#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  CLAUDE_CODE_PROJECTS_DIR,
  QUERY_LOG,
  REPAIRED_SKILL_LOG,
  REPAIRED_SKILL_SESSIONS_MARKER,
  SKILL_LOG,
} from "../constants.js";
import { findTranscriptFiles } from "../ingestors/claude-replay.js";
import type { QueryLogRecord, SkillUsageRecord } from "../types.js";
import { readJsonl } from "../utils/jsonl.js";
import { isActionableQueryText } from "../utils/query-filter.js";
import { writeRepairedSkillUsageRecords } from "../utils/skill-log.js";

interface ActionableUserMessage {
  query: string;
  timestamp: string;
}

export interface RepairSkillUsageResult {
  repairedRecords: SkillUsageRecord[];
  repairedSessionIds: Set<string>;
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
    const skillCounts = counts.get(skillName)!;
    skillCounts.set(skillPath, (skillCounts.get(skillPath) ?? 0) + 1);
  }

  const lookup = new Map<string, string>();
  for (const [skillName, skillCounts] of counts.entries()) {
    const best = [...skillCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) lookup.set(skillName, best[0]);
  }
  return lookup;
}

function extractSessionSkillUsage(
  transcriptPath: string,
  skillPathLookup: Map<string, string>,
): SkillUsageRecord[] {
  if (!existsSync(transcriptPath)) return [];

  let content: string;
  try {
    content = readFileSync(transcriptPath, "utf-8");
  } catch {
    return [];
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
  const seen = new Set<string>();
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

    if (role === "user") {
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

      const dedupeKey = [sessionId, skillName, lastUserMessage.query].join("\u0000");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const skillPath =
        skillPathLookup.get(skillName.toLowerCase()) ?? `(repaired:${skillName})`;

      repaired.push({
        timestamp: timestamp || lastUserMessage.timestamp || fallbackTimestamp,
        session_id: sessionId,
        skill_name: skillName,
        skill_path: skillPath,
        query: lastUserMessage.query,
        triggered: true,
        source: "claude_code_repair",
      });
    }
  }

  return repaired;
}

export function rebuildSkillUsageFromTranscripts(
  transcriptPaths: string[],
  rawSkillRecords: SkillUsageRecord[],
): RepairSkillUsageResult {
  const repairedSessionIds = new Set<string>();
  const skillPathLookup = buildSkillPathLookup(rawSkillRecords);
  const repairedRecords: SkillUsageRecord[] = [];

  for (const transcriptPath of transcriptPaths) {
    const sessionId = basename(transcriptPath, ".jsonl");
    repairedSessionIds.add(sessionId);
    repairedRecords.push(...extractSessionSkillUsage(transcriptPath, skillPathLookup));
  }

  return { repairedRecords, repairedSessionIds };
}

export function cliMain(): void {
  const { values } = parseArgs({
    options: {
      "projects-dir": { type: "string", default: CLAUDE_CODE_PROJECTS_DIR },
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
      console.error(`[ERROR] Invalid --since date: ${values.since}`);
      process.exit(1);
    }
  }

  const transcriptPaths = findTranscriptFiles(values["projects-dir"] ?? CLAUDE_CODE_PROJECTS_DIR, since);
  const rawSkillRecords = readJsonl<SkillUsageRecord>(values["skill-log"] ?? SKILL_LOG);
  const queryRecords = readJsonl<QueryLogRecord>(QUERY_LOG);
  const { repairedRecords, repairedSessionIds } = rebuildSkillUsageFromTranscripts(
    transcriptPaths,
    rawSkillRecords,
  );

  const matchedQueries = new Set(repairedRecords.map((record) => record.query.toLowerCase().trim()));
  const totalReinsQueries = queryRecords.filter(
    (record) => typeof record.query === "string" && /\breins\b/i.test(record.query),
  ).length;
  const totalReinsMatches = repairedRecords.filter((record) => /\breins\b/i.test(record.query)).length;

  console.log(
    JSON.stringify(
      {
        transcripts_scanned: transcriptPaths.length,
        repaired_sessions: repairedSessionIds.size,
        repaired_records: repairedRecords.length,
        unique_matched_queries: matchedQueries.size,
        reins_queries_seen: totalReinsQueries,
        reins_skill_matches: totalReinsMatches,
        output: values.out ?? REPAIRED_SKILL_LOG,
      },
      null,
      2,
    ),
  );

  if (values["dry-run"]) return;

  writeRepairedSkillUsageRecords(
    repairedRecords,
    repairedSessionIds,
    values.out ?? REPAIRED_SKILL_LOG,
    values["sessions-marker"] ?? REPAIRED_SKILL_SESSIONS_MARKER,
  );
}

if (import.meta.main) {
  cliMain();
}
