#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  CLAUDE_CODE_PROJECTS_DIR,
  QUERY_LOG,
  REPAIRED_SKILL_LOG,
  REPAIRED_SKILL_SESSIONS_MARKER,
  SKILL_LOG,
} from "../constants.js";
import { findTranscriptFiles } from "../ingestors/claude-replay.js";
import {
  DEFAULT_CODEX_HOME,
  findRolloutFiles,
  findSkillNames,
  parseRolloutFile,
} from "../ingestors/codex-rollout.js";
import { getDb } from "../localdb/db.js";
import { queryQueryLog, querySkillUsageRecords } from "../localdb/queries.js";
import type { QueryLogRecord, SkillUsageRecord } from "../types.js";
import { readJsonl } from "../utils/jsonl.js";
import { isActionableQueryText } from "../utils/query-filter.js";
import {
  classifySkillPath,
  findInstalledSkillPath,
  findRepositoryClaudeSkillDirs,
  findRepositorySkillDirs,
} from "../utils/skill-discovery.js";
import { writeRepairedSkillUsageRecords } from "../utils/skill-log.js";

interface ActionableUserMessage {
  query: string;
  timestamp: string;
}

export interface RepairSkillUsageResult {
  repairedRecords: SkillUsageRecord[];
  repairedSessionIds: Set<string>;
}

interface RebuiltSessionRecords {
  records: SkillUsageRecord[];
  sessionIds: Set<string>;
}

interface ExtractedSkillUsage {
  processed: boolean;
  records: SkillUsageRecord[];
}

interface ExtractedCodexSkillUsage extends ExtractedSkillUsage {
  sessionId?: string;
}

interface ResolvedSkillPath {
  skillPath: string;
  resolutionSource: NonNullable<SkillUsageRecord["skill_path_resolution_source"]>;
}

function isEphemeralLauncherProjectRoot(projectRoot: string): boolean {
  return projectRoot.startsWith("/tmp/") || projectRoot.startsWith("/private/tmp/");
}

function extractActionableUserText(content: unknown): string | null {
  let text = "";

  if (typeof content === "string") {
    text = content.trim();
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (part): part is Record<string, unknown> =>
          typeof part === "object" &&
          part !== null &&
          (part as Record<string, unknown>).type === "text",
      )
      .map((part) => (part.text as string) ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  if (!text || text.length < 4) return null;
  return isActionableQueryText(text) ? text : null;
}

function buildSkillPathLookup(records: SkillUsageRecord[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();

  for (const record of records) {
    if (typeof record.skill_name !== "string" || typeof record.skill_path !== "string") continue;
    const skillName = record.skill_name.trim().toLowerCase();
    const skillPath = record.skill_path.trim();
    if (!skillName || !skillPath.endsWith("SKILL.md") || skillPath.startsWith("(")) continue;

    if (!counts.has(skillName)) counts.set(skillName, new Map());
    const skillCounts = counts.get(skillName);
    if (!skillCounts) continue;
    skillCounts.set(skillPath, (skillCounts.get(skillPath) ?? 0) + 1);
  }

  const lookup = new Map<string, string>();
  for (const [skillName, skillCounts] of counts.entries()) {
    const best = [...skillCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) lookup.set(skillName, best[0]);
  }
  return lookup;
}

function resolveCodexSkillPath(
  skillName: string,
  cwd: string,
  homeDir: string = process.env.HOME ?? "",
  codexHome: string = DEFAULT_CODEX_HOME,
): ResolvedSkillPath {
  const skillPath = findInstalledSkillPath(skillName, [
    ...findRepositorySkillDirs(cwd),
    join(homeDir, ".agents", "skills"),
    "/etc/codex/skills",
    join(codexHome, "skills"),
    join(codexHome, "skills", ".system"),
  ]);
  return skillPath
    ? { skillPath, resolutionSource: "installed_scope" }
    : { skillPath: `(codex:${skillName})`, resolutionSource: "fallback" };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveClaudeSkillPath(
  skillName: string,
  sessionCwd: string | undefined,
  homeDir: string = process.env.HOME ?? "",
  codexHome: string = DEFAULT_CODEX_HOME,
): ResolvedSkillPath {
  const candidateDirs = [
    ...(sessionCwd ? findRepositorySkillDirs(sessionCwd) : []),
    ...(sessionCwd ? findRepositoryClaudeSkillDirs(sessionCwd) : []),
    join(homeDir, ".agents", "skills"),
    join(homeDir, ".claude", "skills"),
    "/etc/codex/skills",
    join(codexHome, "skills"),
    join(codexHome, "skills", ".system"),
  ];
  const skillPath = findInstalledSkillPath(skillName, candidateDirs);
  return skillPath
    ? { skillPath, resolutionSource: "installed_scope" }
    : { skillPath: `(repaired:${skillName})`, resolutionSource: "fallback" };
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const block = part as Record<string, unknown>;
      return optionalString(block.text) ?? optionalString(block.content) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractLauncherSkillBaseDir(content: string): string | undefined {
  const match = content.match(/^Base directory for this skill:\s*(.+)$/m);
  return match?.[1]?.trim() || undefined;
}

function applyLauncherSkillBaseDir(
  pending: { skillName: string; recordIndex?: number },
  launcherDir: string,
  skillPathLookup: Map<string, string>,
  repaired: SkillUsageRecord[],
  homeDir: string,
  codexHome: string,
): void {
  const launcherSkillPath = join(launcherDir, "SKILL.md");
  skillPathLookup.set(pending.skillName.toLowerCase(), launcherSkillPath);
  const classified = classifySkillPath(launcherSkillPath, homeDir, codexHome);
  const launcherMetadata =
    classified.skill_scope === "project" &&
    classified.skill_project_root &&
    isEphemeralLauncherProjectRoot(classified.skill_project_root)
      ? { skill_scope: "unknown" as const }
      : classified;

  if (pending.recordIndex !== undefined) {
    const record = repaired[pending.recordIndex];
    if (record) {
      record.skill_path = launcherSkillPath;
      record.skill_scope = launcherMetadata.skill_scope;
      if (launcherMetadata.skill_project_root) {
        record.skill_project_root = launcherMetadata.skill_project_root;
      } else {
        delete record.skill_project_root;
      }
      if (launcherMetadata.skill_registry_dir) {
        record.skill_registry_dir = launcherMetadata.skill_registry_dir;
      } else {
        delete record.skill_registry_dir;
      }
      record.skill_path_resolution_source = "launcher_base_dir";
    }
  }
}

function extractSessionSkillUsage(
  transcriptPath: string,
  skillPathLookup: Map<string, string>,
  homeDir: string = process.env.HOME ?? "",
  codexHome: string = DEFAULT_CODEX_HOME,
): ExtractedSkillUsage {
  if (!existsSync(transcriptPath)) return { processed: false, records: [] };

  let content: string;
  try {
    content = readFileSync(transcriptPath, "utf-8");
  } catch {
    return { processed: false, records: [] };
  }

  const sessionId = basename(transcriptPath, ".jsonl");
  const fallbackTimestamp = (() => {
    try {
      return statSync(transcriptPath).mtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  })();

  let lastUserMessage: ActionableUserMessage | null = null;
  let sessionCwd: string | undefined;
  const seen = new Set<string>();
  const pendingSkillCalls = new Map<string, { skillName: string; recordIndex?: number }>();
  const repaired: SkillUsageRecord[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const msg = (entry.message as Record<string, unknown>) ?? entry;
    const role = (msg.role as string) ?? (entry.role as string) ?? "";
    const timestamp =
      (entry.timestamp as string) ?? (msg.timestamp as string) ?? lastUserMessage?.timestamp ?? "";
    sessionCwd =
      optionalString(entry.cwd) ??
      optionalString(msg.cwd) ??
      optionalString((entry.data as Record<string, unknown> | undefined)?.cwd) ??
      sessionCwd;

    if (role === "user") {
      const userBlocks = Array.isArray(msg.content ?? entry.content ?? "")
        ? ((msg.content ?? entry.content ?? "") as unknown[])
        : [];
      for (const block of userBlocks) {
        if (typeof block !== "object" || block === null) continue;
        const toolResult = block as Record<string, unknown>;
        if (toolResult.type === "tool_result") {
          const toolUseId = optionalString(toolResult.tool_use_id);
          if (!toolUseId) continue;
          const pending = pendingSkillCalls.get(toolUseId);
          if (!pending) continue;

          const launcherDir = extractLauncherSkillBaseDir(
            extractToolResultText(toolResult.content),
          );
          if (!launcherDir) continue;

          applyLauncherSkillBaseDir(
            pending,
            launcherDir,
            skillPathLookup,
            repaired,
            homeDir,
            codexHome,
          );
          pendingSkillCalls.delete(toolUseId);
          continue;
        }

        if (toolResult.type === "text" && pendingSkillCalls.size === 1) {
          const launcherDir = extractLauncherSkillBaseDir(extractToolResultText(toolResult.text));
          if (!launcherDir) continue;

          const [toolUseId, pending] = pendingSkillCalls.entries().next().value as [
            string,
            { skillName: string; recordIndex?: number },
          ];
          applyLauncherSkillBaseDir(
            pending,
            launcherDir,
            skillPathLookup,
            repaired,
            homeDir,
            codexHome,
          );
          pendingSkillCalls.delete(toolUseId);
        }
      }

      const query = extractActionableUserText(msg.content ?? entry.content ?? "");
      if (query) {
        lastUserMessage = { query, timestamp: timestamp || fallbackTimestamp };
      }
      continue;
    }

    if (role !== "assistant") continue;

    const blocks = Array.isArray(msg.content ?? entry.content ?? "")
      ? ((msg.content ?? entry.content ?? "") as unknown[])
      : [];

    for (const block of blocks) {
      if (typeof block !== "object" || block === null) continue;
      const toolUse = block as Record<string, unknown>;
      if (toolUse.type !== "tool_use") continue;

      const input = (toolUse.input as Record<string, unknown>) ?? {};
      const toolName = (toolUse.name as string) ?? "";

      if (toolName === "Read") {
        const filePath = (input.file_path as string) ?? "";
        if (filePath.endsWith("SKILL.md")) {
          const inferredSkillName = basename(dirname(filePath)).trim().toLowerCase();
          if (inferredSkillName && !skillPathLookup.has(inferredSkillName)) {
            skillPathLookup.set(inferredSkillName, filePath);
          }
        }
        continue;
      }

      if (toolName !== "Skill" || !lastUserMessage) continue;

      const skillName = ((input.skill as string) ?? (input.name as string) ?? "").trim();
      if (!skillName) continue;
      const toolUseId = optionalString(toolUse.id);

      const dedupeKey = [sessionId, skillName, lastUserMessage.query].join("\u0000");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const knownSkillPath = skillPathLookup.get(skillName.toLowerCase());
      const { skillPath, resolutionSource } = knownSkillPath
        ? { skillPath: knownSkillPath, resolutionSource: "raw_log" as const }
        : resolveClaudeSkillPath(skillName, sessionCwd, homeDir, codexHome);

      const recordIndex =
        repaired.push({
          timestamp: timestamp || lastUserMessage.timestamp || fallbackTimestamp,
          session_id: sessionId,
          skill_name: skillName,
          skill_path: skillPath,
          ...classifySkillPath(skillPath, homeDir, codexHome),
          skill_path_resolution_source: resolutionSource,
          query: lastUserMessage.query,
          triggered: true,
          source: "claude_code_repair",
        }) - 1;

      if (toolUseId) {
        pendingSkillCalls.set(toolUseId, { skillName, recordIndex });
      }
    }
  }

  return { processed: true, records: repaired };
}

function extractCodexSkillUsage(
  rolloutPath: string,
  skillPathLookup: Map<string, string>,
  homeDir: string = process.env.HOME ?? "",
  codexHome: string = DEFAULT_CODEX_HOME,
): ExtractedCodexSkillUsage {
  const parsed = parseRolloutFile(rolloutPath, findSkillNames());
  if (!parsed) return { processed: false, records: [] };
  if (parsed.skills_invoked.length === 0 || !parsed.query.trim()) {
    return {
      processed: true,
      sessionId: parsed.session_id,
      records: [],
    };
  }

  return {
    processed: true,
    sessionId: parsed.session_id,
    records: parsed.skills_invoked.map((skillName) => {
      const knownSkillPath = skillPathLookup.get(skillName.toLowerCase());
      const { skillPath, resolutionSource } = knownSkillPath
        ? { skillPath: knownSkillPath, resolutionSource: "raw_log" as const }
        : resolveCodexSkillPath(skillName, parsed.cwd, homeDir, codexHome);
      return {
        timestamp: parsed.timestamp,
        session_id: parsed.session_id,
        skill_name: skillName,
        skill_path: skillPath,
        ...classifySkillPath(skillPath, homeDir, codexHome),
        skill_path_resolution_source: resolutionSource,
        query: parsed.query.trim(),
        triggered: true,
        source: "codex_rollout_explicit",
      };
    }),
  };
}

export function rebuildSkillUsageFromCodexRollouts(
  rolloutPaths: string[],
  rawSkillRecords: SkillUsageRecord[],
  homeDir: string = process.env.HOME ?? "",
  codexHome: string = DEFAULT_CODEX_HOME,
): RebuiltSessionRecords {
  const rebuiltSessionIds = new Set<string>();
  const skillPathLookup = buildSkillPathLookup(rawSkillRecords);
  const rebuiltRecords: SkillUsageRecord[] = [];

  for (const rolloutPath of rolloutPaths) {
    const extracted = extractCodexSkillUsage(rolloutPath, skillPathLookup, homeDir, codexHome);
    if (extracted.processed && extracted.sessionId) {
      rebuiltSessionIds.add(extracted.sessionId);
    }
    if (extracted.records.length === 0) continue;
    rebuiltRecords.push(...extracted.records);
  }

  return { records: rebuiltRecords, sessionIds: rebuiltSessionIds };
}

export function rebuildSkillUsageFromTranscripts(
  transcriptPaths: string[],
  rawSkillRecords: SkillUsageRecord[],
  homeDir: string = process.env.HOME ?? "",
  codexHome: string = DEFAULT_CODEX_HOME,
): RepairSkillUsageResult {
  const repairedSessionIds = new Set<string>();
  const skillPathLookup = buildSkillPathLookup(rawSkillRecords);
  const repairedRecords: SkillUsageRecord[] = [];

  for (const transcriptPath of transcriptPaths) {
    const sessionId = basename(transcriptPath, ".jsonl");
    const extracted = extractSessionSkillUsage(transcriptPath, skillPathLookup, homeDir, codexHome);
    if (extracted.processed) {
      repairedSessionIds.add(sessionId);
    }
    if (extracted.records.length === 0) continue;
    repairedRecords.push(...extracted.records);
  }

  return { repairedRecords, repairedSessionIds };
}

export function cliMain(): void {
  try {
    const { values } = parseArgs({
      options: {
        "projects-dir": { type: "string", default: CLAUDE_CODE_PROJECTS_DIR },
        "codex-home": { type: "string", default: DEFAULT_CODEX_HOME },
        since: { type: "string" },
        out: { type: "string", default: REPAIRED_SKILL_LOG },
        "sessions-marker": { type: "string", default: REPAIRED_SKILL_SESSIONS_MARKER },
        "skill-log": { type: "string", default: SKILL_LOG },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });

    if (values.help) {
      console.log(`selftune repair-skill-usage — Rebuild trustworthy skill usage from transcripts

Usage:
  selftune repair-skill-usage [options]

Options:
  --projects-dir <dir>      Claude transcript directory (default: ~/.claude/projects)
  --codex-home <dir>        Codex home directory (default: ~/.codex)
  --since <date>            Only repair sessions modified on/after date
  --out <path>              Repaired overlay log path
  --sessions-marker <path>  Repaired session-id marker path
  --skill-log <path>        Raw skill usage log path
  --dry-run                 Show counts without writing files
  --help                    Show this help`);
      process.exit(0);
    }

    let since: Date | undefined;
    if (values.since) {
      since = new Date(values.since);
      if (Number.isNaN(since.getTime())) {
        throw new Error(`Invalid --since date: ${values.since}`);
      }
    }

    const transcriptPaths = findTranscriptFiles(
      values["projects-dir"] ?? CLAUDE_CODE_PROJECTS_DIR,
      since,
    );
    const rolloutPaths = findRolloutFiles(values["codex-home"] ?? DEFAULT_CODEX_HOME, since);
    let rawSkillRecords: SkillUsageRecord[];
    let queryRecords: QueryLogRecord[];
    try {
      const db = getDb();
      rawSkillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
      queryRecords = queryQueryLog(db) as QueryLogRecord[];
    } catch {
      rawSkillRecords = readJsonl<SkillUsageRecord>(values["skill-log"] ?? SKILL_LOG);
      queryRecords = readJsonl<QueryLogRecord>(QUERY_LOG);
    }
    const { repairedRecords, repairedSessionIds } = rebuildSkillUsageFromTranscripts(
      transcriptPaths,
      rawSkillRecords,
      process.env.HOME ?? "",
      values["codex-home"] ?? DEFAULT_CODEX_HOME,
    );
    const { records: codexRecords, sessionIds: codexSessionIds } =
      rebuildSkillUsageFromCodexRollouts(
        rolloutPaths,
        rawSkillRecords,
        process.env.HOME ?? "",
        values["codex-home"] ?? DEFAULT_CODEX_HOME,
      );
    for (const sessionId of codexSessionIds) repairedSessionIds.add(sessionId);
    repairedRecords.push(...codexRecords);

    const matchedQueries = new Set(
      repairedRecords.map((record) => record.query.toLowerCase().trim()),
    );
    const totalReinsQueries = queryRecords.filter(
      (record) => typeof record.query === "string" && /\breins\b/i.test(record.query),
    ).length;
    const totalReinsMatches = repairedRecords.filter((record) =>
      /\breins\b/i.test(record.query),
    ).length;
    const totalCodexMatches = repairedRecords.filter(
      (record) => record.source === "codex_rollout_explicit",
    ).length;

    const summary = {
      transcripts_scanned: transcriptPaths.length,
      codex_rollouts_scanned: rolloutPaths.length,
      repaired_sessions: repairedSessionIds.size,
      repaired_records: repairedRecords.length,
      codex_repaired_records: totalCodexMatches,
      unique_matched_queries: matchedQueries.size,
      reins_queries_seen: totalReinsQueries,
      reins_skill_matches: totalReinsMatches,
      output: values.out ?? REPAIRED_SKILL_LOG,
    };

    if (values["dry-run"]) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    writeRepairedSkillUsageRecords(
      repairedRecords,
      repairedSessionIds,
      values.out ?? REPAIRED_SKILL_LOG,
      values["sessions-marker"] ?? REPAIRED_SKILL_SESSIONS_MARKER,
    );
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] Failed to repair skill usage: ${message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  cliMain();
}
