#!/usr/bin/env bun

import type { Database } from "bun:sqlite";
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
import { writeSkillCheckToDb } from "../localdb/direct-write.js";
import { queryQueryLog, querySkillUsageRecords } from "../localdb/queries.js";
import { buildCanonicalSkillInvocation, deriveInvocationMode } from "../normalization.js";
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

export interface RepairSQLiteResult {
  deleted_legacy_rows: number;
  deleted_prior_repair_rows: number;
  inserted_repair_rows: number;
  skipped_pairs_with_canonical: number;
  repaired_pairs_inserted: number;
}

function deleteRedundantLegacyRows(db: Database): number {
  const deleteTriggered = db.run(`
    DELETE FROM skill_invocations
    WHERE skill_invocation_id LIKE '%:su:%'
      AND triggered = 1
      AND EXISTS (
        SELECT 1
        FROM skill_invocations current
        WHERE current.session_id = skill_invocations.session_id
          AND lower(current.skill_name) = lower(skill_invocations.skill_name)
          AND current.skill_invocation_id NOT LIKE '%:su:%'
          AND current.triggered = 1
      )
  `);

  const deleteMisses = db.run(`
    DELETE FROM skill_invocations
    WHERE skill_invocation_id LIKE '%:su:%'
      AND triggered = 0
      AND EXISTS (
        SELECT 1
        FROM skill_invocations current
        WHERE current.session_id = skill_invocations.session_id
          AND lower(current.skill_name) = lower(skill_invocations.skill_name)
          AND COALESCE(current.query, '') = COALESCE(skill_invocations.query, '')
          AND current.skill_invocation_id NOT LIKE '%:su:%'
          AND current.triggered = 0
      )
  `);

  return deleteTriggered.changes + deleteMisses.changes;
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
  const pendingContextualReads = new Map<string, SkillUsageRecord>();
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
          const inferredSkillName = basename(dirname(filePath)).trim();
          if (inferredSkillName && !skillPathLookup.has(inferredSkillName)) {
            skillPathLookup.set(inferredSkillName.toLowerCase(), filePath);
          }
          if (lastUserMessage && inferredSkillName) {
            const dedupeKey = invocationKey(sessionId, inferredSkillName, lastUserMessage.query);
            if (!seen.has(dedupeKey) && !pendingContextualReads.has(dedupeKey)) {
              pendingContextualReads.set(dedupeKey, {
                timestamp: timestamp || lastUserMessage.timestamp || fallbackTimestamp,
                session_id: sessionId,
                skill_name: inferredSkillName,
                skill_path: filePath,
                ...classifySkillPath(filePath, homeDir, codexHome),
                skill_path_resolution_source: "raw_log",
                query: lastUserMessage.query,
                triggered: false,
                source: "claude_code_repair",
              });
            }
          }
        }
        continue;
      }

      if (toolName !== "Skill" || !lastUserMessage) continue;

      const skillName = ((input.skill as string) ?? (input.name as string) ?? "").trim();
      if (!skillName) continue;
      const toolUseId = optionalString(toolUse.id);

      const dedupeKey = invocationKey(sessionId, skillName, lastUserMessage.query);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      pendingContextualReads.delete(dedupeKey);

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

  if (pendingContextualReads.size > 0) {
    repaired.push(...pendingContextualReads.values());
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

function inferRepairPlatform(source: string | undefined): "claude_code" | "codex" {
  return source?.includes("codex") ? "codex" : "claude_code";
}

function normalizeRepairSkillName(skillName: string): string {
  return skillName.trim().toLowerCase();
}

function pairKey(sessionId: string, skillName: string): string {
  return `${sessionId}\u0000${normalizeRepairSkillName(skillName)}`;
}

function splitPairKey(key: string): { sessionId: string; skillName: string } {
  const [sessionId, skillName] = key.split("\u0000");
  return { sessionId, skillName: normalizeRepairSkillName(skillName) };
}

function compareRepairRecords(a: SkillUsageRecord, b: SkillUsageRecord): number {
  return (
    a.timestamp.localeCompare(b.timestamp) ||
    a.query.localeCompare(b.query) ||
    a.skill_path.localeCompare(b.skill_path) ||
    Number(a.triggered) - Number(b.triggered)
  );
}

function invocationKey(sessionId: string, skillName: string, query: string): string {
  return `${sessionId}\u0000${skillName.trim().toLowerCase()}\u0000${query}`;
}

function stableKeyHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Persist repaired skill usage into the canonical skill_invocations table.
 *
 * Strategy:
 * - delete legacy triggered :su: rows for repaired session/skill pairs
 * - delete prior capture_mode=repair rows for those pairs (idempotent reruns)
 * - insert repaired rows only when the pair has no canonical triggered rows
 *
 * This lets repair improve SQLite without overriding source-truth canonical
 * replay/hook rows, while also removing duplicate legacy trigger rows from
 * mixed historical sessions.
 */
export function persistRepairedSkillUsageToDb(
  db: Database,
  records: SkillUsageRecord[],
): RepairSQLiteResult {
  const triggeredRecords = records.filter((record) => record.triggered);
  const missedRecords = records.filter((record) => !record.triggered);
  const recordsByPair = new Map<string, SkillUsageRecord[]>();
  const missedRecordsByKey = new Map<string, SkillUsageRecord>();

  for (const record of triggeredRecords) {
    const key = pairKey(record.session_id, record.skill_name);
    const bucket = recordsByPair.get(key);
    if (bucket) {
      bucket.push(record);
    } else {
      recordsByPair.set(key, [record]);
    }
  }
  for (const record of missedRecords) {
    const key = invocationKey(record.session_id, record.skill_name, record.query);
    const existing = missedRecordsByKey.get(key);
    if (!existing || compareRepairRecords(record, existing) < 0) {
      missedRecordsByKey.set(key, record);
    }
  }

  if (recordsByPair.size === 0 && missedRecordsByKey.size === 0) {
    return {
      deleted_legacy_rows: 0,
      deleted_prior_repair_rows: 0,
      inserted_repair_rows: 0,
      skipped_pairs_with_canonical: 0,
      repaired_pairs_inserted: 0,
    };
  }

  const selectExisting = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN skill_invocation_id LIKE '%:su:%' AND triggered = 1 THEN 1 ELSE 0 END), 0) AS legacy_rows,
      COALESCE(SUM(CASE WHEN capture_mode = 'repair' AND triggered = 1 THEN 1 ELSE 0 END), 0) AS repair_rows,
      COALESCE(
        SUM(
          CASE
            WHEN skill_invocation_id NOT LIKE '%:su:%'
             AND COALESCE(capture_mode, '') != 'repair'
             AND triggered = 1
            THEN 1 ELSE 0
          END
        ),
        0
      ) AS canonical_rows
    FROM skill_invocations
    WHERE session_id = ? AND LOWER(skill_name) = ?
  `);
  const deleteLegacyTriggered = db.prepare(`
    DELETE FROM skill_invocations
    WHERE session_id = ? AND LOWER(skill_name) = ? AND skill_invocation_id LIKE '%:su:%' AND triggered = 1
  `);
  const deleteRepairTriggered = db.prepare(`
    DELETE FROM skill_invocations
    WHERE session_id = ? AND LOWER(skill_name) = ? AND capture_mode = 'repair' AND triggered = 1
  `);
  const selectExistingMiss = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN skill_invocation_id LIKE '%:su:%' AND triggered = 0 THEN 1 ELSE 0 END), 0) AS legacy_rows,
      COALESCE(SUM(CASE WHEN capture_mode = 'repair' AND triggered = 0 THEN 1 ELSE 0 END), 0) AS repair_rows,
      COALESCE(
        SUM(
          CASE
            WHEN skill_invocation_id NOT LIKE '%:su:%'
             AND COALESCE(capture_mode, '') != 'repair'
             AND triggered = 0
            THEN 1 ELSE 0
          END
        ),
        0
      ) AS canonical_rows
    FROM skill_invocations
    WHERE session_id = ? AND LOWER(skill_name) = ? AND query = ?
  `);
  const deleteLegacyMiss = db.prepare(`
    DELETE FROM skill_invocations
    WHERE session_id = ? AND LOWER(skill_name) = ? AND query = ? AND skill_invocation_id LIKE '%:su:%' AND triggered = 0
  `);
  const deleteRepairMiss = db.prepare(`
    DELETE FROM skill_invocations
    WHERE session_id = ? AND LOWER(skill_name) = ? AND query = ? AND capture_mode = 'repair' AND triggered = 0
  `);

  const result: RepairSQLiteResult = {
    deleted_legacy_rows: 0,
    deleted_prior_repair_rows: 0,
    inserted_repair_rows: 0,
    skipped_pairs_with_canonical: 0,
    repaired_pairs_inserted: 0,
  };

  db.run("BEGIN IMMEDIATE");
  try {
    const redundantLegacyRows = deleteRedundantLegacyRows(db);
    result.deleted_legacy_rows += redundantLegacyRows;

    for (const [key, pairRecords] of recordsByPair.entries()) {
      const { sessionId, skillName } = splitPairKey(key);
      const existing = selectExisting.get(sessionId, skillName) as
        | { legacy_rows: number; repair_rows: number; canonical_rows: number }
        | undefined;

      const legacyRows = existing?.legacy_rows ?? 0;
      const repairRows = existing?.repair_rows ?? 0;
      const canonicalRows = existing?.canonical_rows ?? 0;

      if (repairRows > 0) {
        deleteRepairTriggered.run(sessionId, skillName);
        result.deleted_prior_repair_rows += repairRows;
      }
      if (legacyRows > 0) {
        deleteLegacyTriggered.run(sessionId, skillName);
        result.deleted_legacy_rows += legacyRows;
      }
      if (canonicalRows > 0) {
        result.skipped_pairs_with_canonical += 1;
        continue;
      }

      const sortedRecords = [...pairRecords].sort(compareRepairRecords);
      const canonicalSkillName = sortedRecords[0]?.skill_name.trim() || skillName;
      const { invocation_mode, confidence } = deriveInvocationMode({ is_repaired: true });

      for (let index = 0; index < sortedRecords.length; index++) {
        const record = sortedRecords[index];
        const platform = inferRepairPlatform(record.source);
        const canonical = buildCanonicalSkillInvocation({
          platform,
          capture_mode: "repair",
          source_session_kind: "repaired",
          session_id: record.session_id,
          raw_source_ref: {
            event_type: "repair-skill-usage",
            metadata: {
              source: record.source ?? null,
              skill_path_resolution_source: record.skill_path_resolution_source ?? null,
              skill_project_root: record.skill_project_root ?? null,
              skill_registry_dir: record.skill_registry_dir ?? null,
            },
          },
          skill_invocation_id: `${record.session_id}:r:${canonicalSkillName}:${index}`,
          occurred_at: record.timestamp,
          skill_name: canonicalSkillName,
          skill_path: record.skill_path,
          invocation_mode,
          triggered: true,
          confidence,
        });

        writeSkillCheckToDb({
          ...canonical,
          query: record.query,
          skill_path: record.skill_path,
          skill_scope: record.skill_scope,
          source: record.source,
        });
        result.inserted_repair_rows += 1;
      }

      result.repaired_pairs_inserted += 1;
    }

    for (const record of missedRecordsByKey.values()) {
      const canonicalSkillName = record.skill_name.trim();
      const normalizedSkillName = normalizeRepairSkillName(canonicalSkillName);
      const existing = selectExistingMiss.get(
        record.session_id,
        normalizedSkillName,
        record.query,
      ) as { legacy_rows: number; repair_rows: number; canonical_rows: number } | undefined;

      const legacyRows = existing?.legacy_rows ?? 0;
      const repairRows = existing?.repair_rows ?? 0;
      const canonicalRows = existing?.canonical_rows ?? 0;

      if (repairRows > 0) {
        deleteRepairMiss.run(record.session_id, normalizedSkillName, record.query);
        result.deleted_prior_repair_rows += repairRows;
      }
      if (legacyRows > 0) {
        deleteLegacyMiss.run(record.session_id, normalizedSkillName, record.query);
        result.deleted_legacy_rows += legacyRows;
      }
      if (canonicalRows > 0) {
        result.skipped_pairs_with_canonical += 1;
        continue;
      }

      const platform = inferRepairPlatform(record.source);
      const { invocation_mode, confidence } = deriveInvocationMode({ is_repaired: true });
      const canonical = buildCanonicalSkillInvocation({
        platform,
        capture_mode: "repair",
        source_session_kind: "repaired",
        session_id: record.session_id,
        raw_source_ref: {
          event_type: "repair-skill-usage",
          metadata: {
            source: record.source ?? null,
            skill_path_resolution_source: record.skill_path_resolution_source ?? null,
            skill_project_root: record.skill_project_root ?? null,
            skill_registry_dir: record.skill_registry_dir ?? null,
            miss_type: "contextual_read",
          },
        },
        skill_invocation_id: `${record.session_id}:rmiss:${canonicalSkillName}:${stableKeyHash(record.query)}`,
        occurred_at: record.timestamp,
        skill_name: canonicalSkillName,
        skill_path: record.skill_path,
        invocation_mode,
        triggered: false,
        confidence,
      });

      writeSkillCheckToDb({
        ...canonical,
        query: record.query,
        skill_path: record.skill_path,
        skill_scope: record.skill_scope,
        source: record.source,
      });
      result.inserted_repair_rows += 1;
      result.repaired_pairs_inserted += 1;
    }

    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }

  return result;
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
    // SQLite-first: default paths read from SQLite; JSONL only for custom --skill-log overrides
    let rawSkillRecords: SkillUsageRecord[];
    let queryRecords: QueryLogRecord[];
    const skillLogPath = values["skill-log"] ?? SKILL_LOG;
    if (skillLogPath === SKILL_LOG) {
      const db = getDb();
      rawSkillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
      queryRecords = queryQueryLog(db) as QueryLogRecord[];
    } else {
      // test/custom-path fallback
      rawSkillRecords = readJsonl<SkillUsageRecord>(skillLogPath);
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

    const sqlite = persistRepairedSkillUsageToDb(getDb(), repairedRecords);

    writeRepairedSkillUsageRecords(
      repairedRecords,
      repairedSessionIds,
      values.out ?? REPAIRED_SKILL_LOG,
      values["sessions-marker"] ?? REPAIRED_SKILL_SESSIONS_MARKER,
    );
    console.log(JSON.stringify({ ...summary, sqlite }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] Failed to repair skill usage: ${message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  cliMain();
}
