#!/usr/bin/env bun
/**
 * Codex rollout ingestor: codex-rollout.ts
 *
 * Retroactively ingests Codex's auto-written rollout logs into our shared
 * skill eval log format.
 *
 * Codex CLI saves every session to:
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<thread_id>.jsonl
 *
 * This script scans those files and populates:
 *   ~/.claude/all_queries_log.jsonl
 *   ~/.claude/session_telemetry_log.jsonl
 *   ~/.claude/skill_usage_log.jsonl
 *
 * Usage:
 *   bun codex-rollout.ts
 *   bun codex-rollout.ts --since 2026-01-01
 *   bun codex-rollout.ts --codex-home /custom/path
 *   bun codex-rollout.ts --dry-run
 *   bun codex-rollout.ts --force
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../constants.js";
import type { QueryLogRecord, SessionTelemetryRecord, SkillUsageRecord } from "../types.js";
import { appendJsonl, loadMarker, saveMarker } from "../utils/jsonl.js";

const MARKER_FILE = join(homedir(), ".claude", "codex_ingested_rollouts.json");

const DEFAULT_CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");

const CODEX_SKILLS_DIRS = [
  join(process.cwd(), ".codex", "skills"),
  join(homedir(), ".codex", "skills"),
];

/** Return skill names from Codex skill directories. */
export function findSkillNames(dirs: string[] = CODEX_SKILLS_DIRS): Set<string> {
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      try {
        if (statSync(skillDir).isDirectory() && existsSync(join(skillDir, "SKILL.md"))) {
          names.add(entry);
        }
      } catch {
        // skip entries that can't be stat'd (broken symlinks, permission errors, etc.)
      }
    }
  }
  return names;
}

/**
 * Find all rollout-*.jsonl files under codexHome/sessions/YYYY/MM/DD/.
 * If `since` is given, only return files from that date onward.
 */
export function findRolloutFiles(codexHome: string, since?: Date): string[] {
  const sessionsDir = join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) return [];

  const files: string[] = [];

  for (const yearEntry of readdirSync(sessionsDir).sort()) {
    const yearDir = join(sessionsDir, yearEntry);
    try {
      if (!statSync(yearDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const year = Number.parseInt(yearEntry, 10);
    if (Number.isNaN(year)) continue;

    for (const monthEntry of readdirSync(yearDir).sort()) {
      const monthDir = join(yearDir, monthEntry);
      try {
        if (!statSync(monthDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const month = Number.parseInt(monthEntry, 10);
      if (Number.isNaN(month)) continue;

      for (const dayEntry of readdirSync(monthDir).sort()) {
        const dayDir = join(monthDir, dayEntry);
        try {
          if (!statSync(dayDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const day = Number.parseInt(dayEntry, 10);
        if (Number.isNaN(day)) continue;

        if (since) {
          const fileDate = new Date(year, month - 1, day);
          if (fileDate < since) continue;
        }

        for (const file of readdirSync(dayDir).sort()) {
          if (file.startsWith("rollout-") && file.endsWith(".jsonl")) {
            files.push(join(dayDir, file));
          }
        }
      }
    }
  }

  return files;
}

export interface ParsedRollout {
  timestamp: string;
  session_id: string;
  source: string;
  rollout_path: string;
  query: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  assistant_turns: number;
  errors_encountered: number;
  input_tokens: number;
  output_tokens: number;
  transcript_chars: number;
  cwd: string;
  transcript_path: string;
  last_user_query: string;
}

/**
 * Parse a Codex rollout JSONL file.
 * Returns parsed data or null if the file is empty/unparseable.
 */
export function parseRolloutFile(path: string, skillNames: Set<string>): ParsedRollout | null {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return null;

  const threadId = basename(path, ".jsonl").replace("rollout-", "");
  let prompt = "";
  const toolCalls: Record<string, number> = {};
  const bashCommands: string[] = [];
  const skillsTriggered: string[] = [];
  let errors = 0;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const etype = (event.type as string) ?? "";

    if (etype === "turn.started") {
      turns += 1;
    } else if (etype === "turn.completed") {
      const usage = (event.usage as Record<string, number>) ?? {};
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      if (!prompt) {
        prompt = (event.user_message as string) ?? "";
      }
    } else if (etype === "turn.failed") {
      errors += 1;
    } else if (etype === "item.completed" || etype === "item.started" || etype === "item.updated") {
      const item = (event.item as Record<string, unknown>) ?? {};
      const itemType = (item.item_type as string) ?? (item.type as string) ?? "";

      if (etype === "item.completed") {
        if (itemType === "command_execution") {
          toolCalls.command_execution = (toolCalls.command_execution ?? 0) + 1;
          const cmd = ((item.command as string) ?? "").trim();
          if (cmd) bashCommands.push(cmd);
          if ((item.exit_code as number) !== 0 && item.exit_code !== undefined) {
            errors += 1;
          }
        } else if (itemType === "file_change") {
          toolCalls.file_change = (toolCalls.file_change ?? 0) + 1;
        } else if (itemType === "mcp_tool_call") {
          toolCalls.mcp_tool_call = (toolCalls.mcp_tool_call ?? 0) + 1;
        } else if (itemType === "web_search") {
          toolCalls.web_search = (toolCalls.web_search ?? 0) + 1;
        } else if (itemType === "reasoning") {
          toolCalls.reasoning = (toolCalls.reasoning ?? 0) + 1;
        }
      }

      // Detect skill names in text content on completed events
      const textContent = ((item.text as string) ?? "") + ((item.command as string) ?? "");
      for (const skillName of skillNames) {
        if (
          textContent.includes(skillName) &&
          !skillsTriggered.includes(skillName) &&
          etype === "item.completed"
        ) {
          skillsTriggered.push(skillName);
        }
      }
    } else if (etype === "error") {
      errors += 1;
    }

    // Some rollout formats embed the original prompt
    if (!prompt && (event.prompt as string)) {
      prompt = event.prompt as string;
    }
  }

  // Infer file date from path structure: .../YYYY/MM/DD/rollout-*.jsonl
  let fileDate: string;
  const parts = path.split("/");
  try {
    const dayStr = parts[parts.length - 2];
    const monthStr = parts[parts.length - 3];
    const yearStr = parts[parts.length - 4];
    const year = Number.parseInt(yearStr, 10);
    const month = Number.parseInt(monthStr, 10);
    const day = Number.parseInt(dayStr, 10);
    if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
      fileDate = new Date(Date.UTC(year, month - 1, day)).toISOString();
    } else {
      fileDate = new Date().toISOString();
    }
  } catch {
    fileDate = new Date().toISOString();
  }

  return {
    timestamp: fileDate,
    session_id: threadId,
    source: "codex_rollout",
    rollout_path: path,
    query: prompt,
    tool_calls: toolCalls,
    total_tool_calls: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    bash_commands: bashCommands,
    skills_triggered: skillsTriggered,
    assistant_turns: turns,
    errors_encountered: errors,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    transcript_chars: lines.reduce((sum, l) => sum + l.length, 0),
    cwd: "",
    transcript_path: path,
    last_user_query: prompt,
  };
}

/** Write parsed session data to shared logs. */
export function ingestFile(
  parsed: ParsedRollout,
  dryRun = false,
  queryLogPath: string = QUERY_LOG,
  telemetryLogPath: string = TELEMETRY_LOG,
  skillLogPath: string = SKILL_LOG,
): boolean {
  const { query: prompt, session_id: sessionId, skills_triggered: skills } = parsed;

  if (dryRun) {
    console.log(
      `  [DRY RUN] Would ingest: session=${sessionId.slice(0, 12)}... ` +
        `turns=${parsed.assistant_turns} commands=${parsed.bash_commands.length} skills=${JSON.stringify(skills)}`,
    );
    if (prompt) console.log(`           query: ${prompt.slice(0, 80)}`);
    return true;
  }

  // Write to all_queries_log if we have a prompt
  if (prompt && prompt.length >= 4) {
    const queryRecord: QueryLogRecord = {
      timestamp: parsed.timestamp,
      session_id: sessionId,
      query: prompt,
      source: "codex_rollout",
    };
    appendJsonl(queryLogPath, queryRecord, "all_queries");
  }

  // Write telemetry — explicitly select SessionTelemetryRecord fields
  const telemetry: SessionTelemetryRecord = {
    timestamp: parsed.timestamp,
    session_id: sessionId,
    cwd: parsed.cwd,
    transcript_path: parsed.transcript_path,
    tool_calls: parsed.tool_calls,
    total_tool_calls: parsed.total_tool_calls,
    bash_commands: parsed.bash_commands,
    skills_triggered: skills,
    assistant_turns: parsed.assistant_turns,
    errors_encountered: parsed.errors_encountered,
    transcript_chars: parsed.transcript_chars,
    last_user_query: parsed.last_user_query,
    source: parsed.source,
    input_tokens: parsed.input_tokens,
    output_tokens: parsed.output_tokens,
    rollout_path: parsed.rollout_path,
  };
  appendJsonl(telemetryLogPath, telemetry, "session_telemetry");

  // Write skill triggers
  for (const skillName of skills) {
    const skillRecord: SkillUsageRecord = {
      timestamp: parsed.timestamp,
      session_id: sessionId,
      skill_name: skillName,
      skill_path: `(codex:${skillName})`,
      query: prompt,
      triggered: true,
      source: "codex_rollout",
    };
    appendJsonl(skillLogPath, skillRecord, "skill_usage");
  }

  return true;
}

// --- CLI main ---
export function cliMain(): void {
  const { values } = parseArgs({
    options: {
      "codex-home": { type: "string", default: DEFAULT_CODEX_HOME },
      since: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
    },
    strict: true,
  });

  const codexHome = values["codex-home"] ?? DEFAULT_CODEX_HOME;
  let since: Date | undefined;
  if (values.since) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) {
      console.error(
        `Error: Invalid --since date: "${values.since}". Use a valid date format (e.g., 2026-01-01).`,
      );
      process.exit(1);
    }
  }

  const rolloutFiles = findRolloutFiles(codexHome, since);
  if (rolloutFiles.length === 0) {
    console.log(`No rollout files found under ${codexHome}/sessions/`);
    console.log("Make sure CODEX_HOME is correct and you've run some `codex exec` sessions.");
    process.exit(0);
  }

  const alreadyIngested = values.force ? new Set<string>() : loadMarker(MARKER_FILE);
  const skillNames = findSkillNames();
  const newIngested = new Set<string>();

  const pending = rolloutFiles.filter((f) => !alreadyIngested.has(f));
  console.log(`Found ${rolloutFiles.length} rollout files, ${pending.length} not yet ingested.`);

  if (since) {
    console.log(`  Filtering to sessions from ${values.since} onward.`);
  }

  let ingestedCount = 0;
  let skippedCount = 0;

  for (const rolloutFile of pending) {
    const parsed = parseRolloutFile(rolloutFile, skillNames);
    if (parsed === null) {
      if (values.verbose) {
        console.log(`  SKIP (empty/unparseable): ${basename(rolloutFile)}`);
      }
      skippedCount += 1;
      continue;
    }

    if (values.verbose || values["dry-run"]) {
      console.log(`  ${values["dry-run"] ? "[DRY] " : ""}Ingesting: ${basename(rolloutFile)}`);
    }

    ingestFile(parsed, values["dry-run"]);
    newIngested.add(rolloutFile);
    ingestedCount += 1;
  }

  if (!values["dry-run"]) {
    saveMarker(MARKER_FILE, new Set([...alreadyIngested, ...newIngested]));
  }

  console.log(`\nDone. Ingested ${ingestedCount} sessions, skipped ${skippedCount}.`);
  if (newIngested.size > 0 && !values["dry-run"]) {
    console.log(`Marker updated: ${MARKER_FILE}`);
  }
}

if (import.meta.main) {
  cliMain();
}
