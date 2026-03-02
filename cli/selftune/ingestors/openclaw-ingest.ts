#!/usr/bin/env bun
/**
 * OpenClaw session ingestor: openclaw-ingest.ts
 *
 * Ingests OpenClaw session history from JSONL files into our shared
 * skill eval log format.
 *
 * OpenClaw stores sessions as JSONL at:
 *   ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
 *
 * Each JSONL file has:
 *   Line 1 (session header): {"type":"session","version":5,"id":"<uuid>","timestamp":"<iso>","cwd":"<path>"}
 *   Line 2+ (messages): {"role":"user|assistant|toolResult","content":[...],"timestamp":<ms>}
 *
 * Usage:
 *   bun openclaw-ingest.ts
 *   bun openclaw-ingest.ts --since 2026-01-01
 *   bun openclaw-ingest.ts --agents-dir /custom/path
 *   bun openclaw-ingest.ts --dry-run
 *   bun openclaw-ingest.ts --force
 *   bun openclaw-ingest.ts --verbose
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  OPENCLAW_AGENTS_DIR,
  OPENCLAW_INGEST_MARKER,
  QUERY_LOG,
  SKILL_LOG,
  TELEMETRY_LOG,
} from "../constants.js";
import type { QueryLogRecord, SkillUsageRecord } from "../types.js";
import { appendJsonl, loadMarker, saveMarker } from "../utils/jsonl.js";

export interface SessionFile {
  agentId: string;
  sessionId: string;
  filePath: string;
  timestamp: number; // epoch ms from file stat or header
}

export interface ParsedSession {
  timestamp: string;
  session_id: string;
  source: string;
  transcript_path: string;
  cwd: string;
  last_user_query: string;
  query: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  assistant_turns: number;
  errors_encountered: number;
  transcript_chars: number;
}

/**
 * Scan <agentsDir>/<agentId>/sessions/*.jsonl for OpenClaw session files.
 * Reads line 1 of each file to get the session header with id and timestamp.
 * If sinceTs (epoch ms) is provided, skips sessions older than that.
 */
export function findOpenClawSessions(agentsDir: string, sinceTs: number | null): SessionFile[] {
  if (!existsSync(agentsDir)) return [];

  const results: SessionFile[] = [];
  let agentDirs: string[];

  try {
    agentDirs = readdirSync(agentsDir);
  } catch {
    return [];
  }

  for (const agentId of agentDirs) {
    const sessionsDir = join(agentsDir, agentId, "sessions");
    if (!existsSync(sessionsDir)) continue;

    let files: string[];
    try {
      files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(sessionsDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const firstLine = content.split("\n")[0]?.trim();
        if (!firstLine) continue;

        const header = JSON.parse(firstLine);
        if (header.type !== "session") continue;

        const sessionId = header.id ?? basename(file, ".jsonl");
        const headerTs = header.timestamp ? new Date(header.timestamp).getTime() : 0;
        const fileTs = headerTs || statSync(filePath).mtimeMs;

        if (sinceTs !== null && fileTs < sinceTs) continue;

        results.push({
          agentId,
          sessionId,
          filePath,
          timestamp: fileTs,
        });
      } catch {
        // Skip files that can't be read or parsed
      }
    }
  }

  return results;
}

/**
 * Parse an OpenClaw session JSONL file into a ParsedSession.
 *
 * Line 1: session header with id, timestamp, cwd
 * Lines 2+: messages with role user/assistant/toolResult
 */
export function parseOpenClawSession(filePath: string, skillNames: Set<string>): ParsedSession {
  const empty: ParsedSession = {
    timestamp: "",
    session_id: "",
    source: "openclaw",
    transcript_path: filePath,
    cwd: "",
    last_user_query: "",
    query: "",
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [],
    assistant_turns: 0,
    errors_encountered: 0,
    transcript_chars: 0,
  };

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return empty;
  }

  empty.transcript_chars = content.length;
  const lines = content.split("\n").filter((l) => l.trim());

  if (lines.length === 0) return empty;

  // Parse session header (line 1)
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return empty;
  }

  if (header.type !== "session") return empty;

  const sessionId = (header.id as string) ?? "";
  const timestamp = (header.timestamp as string) ?? "";
  const cwd = (header.cwd as string) ?? "";

  const toolCalls: Record<string, number> = {};
  const bashCommands: string[] = [];
  const skillsTriggered: string[] = [];
  let firstUserQuery = "";
  let lastUserQuery = "";
  let assistantTurns = 0;
  let errors = 0;

  // Parse messages (lines 2+)
  for (let i = 1; i < lines.length; i++) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const role = (msg.role as string) ?? "";
    const contentBlocks = normalizeContentBlocks(msg.content);

    if (role === "user") {
      // Extract text from user messages
      for (const block of contentBlocks) {
        if (block.type === "text") {
          const text = ((block.text as string) ?? "").trim();
          if (text) {
            if (!firstUserQuery) firstUserQuery = text;
            lastUserQuery = text;
            break;
          }
        }
      }
    } else if (role === "assistant") {
      assistantTurns += 1;

      for (const block of contentBlocks) {
        const blockType = (block.type as string) ?? "";

        // Handle toolCall and toolUse (alias)
        if (blockType === "toolCall" || blockType === "toolUse") {
          const toolName = (block.name as string) ?? "unknown";
          toolCalls[toolName] = (toolCalls[toolName] ?? 0) + 1;
          const inp = (block.input as Record<string, unknown>) ?? {};

          // Extract bash commands
          if (["Bash", "bash", "execute_bash"].includes(toolName)) {
            const cmd = ((inp.command as string) ?? (inp.cmd as string) ?? "").trim();
            if (cmd) bashCommands.push(cmd);
          }

          // Skill detection: file reads of SKILL.md
          if (["Read", "read_file"].includes(toolName)) {
            const fp = (inp.file_path as string) ?? (inp.path as string) ?? "";
            if (basename(fp).toUpperCase() === "SKILL.MD") {
              const skillName = basename(join(fp, ".."));
              if (!skillsTriggered.includes(skillName)) {
                skillsTriggered.push(skillName);
              }
            }
          }
        }

        // Check text content for skill name mentions
        const textContent = (block.text as string) ?? "";
        for (const skillName of skillNames) {
          if (textContent.includes(skillName) && !skillsTriggered.includes(skillName)) {
            skillsTriggered.push(skillName);
          }
        }
      }
    } else if (role === "toolResult") {
      // Count errors at the message level
      if (msg.isError === true) {
        errors += 1;
      }

      // Also check content blocks for errors
      for (const block of contentBlocks) {
        if (block.isError === true || block.is_error === true) {
          errors += 1;
        }
      }
    }
  }

  return {
    timestamp,
    session_id: sessionId,
    source: "openclaw",
    transcript_path: filePath,
    cwd,
    last_user_query: lastUserQuery || firstUserQuery,
    query: firstUserQuery,
    tool_calls: toolCalls,
    total_tool_calls: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    bash_commands: bashCommands,
    skills_triggered: skillsTriggered,
    assistant_turns: assistantTurns,
    errors_encountered: errors,
    transcript_chars: content.length,
  };
}

/** Normalize message content into an array of content block objects. */
function normalizeContentBlocks(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null);
  }
  if (typeof raw === "string") {
    return [{ type: "text", text: raw }];
  }
  if (typeof raw === "object" && raw !== null) {
    return [raw as Record<string, unknown>];
  }
  return [];
}

const OPENCLAW_SKILL_DIRS = [
  join(homedir(), ".openclaw", "skills"),
  join(process.cwd(), ".agents", "skills"),
];

/**
 * Find OpenClaw skill names from skill directories.
 * By default checks:
 *   <agentsDir>/../skills/ (managed skills)
 *   ~/.openclaw/skills/
 *   process.cwd()/.agents/skills/ (workspace skills)
 */
export function findOpenClawSkillNames(
  agentsDir: string,
  extraDirs: string[] = OPENCLAW_SKILL_DIRS,
): Set<string> {
  const names = new Set<string>();
  const skillDirs = [join(agentsDir, "..", "skills"), join(agentsDir, "skills"), ...extraDirs];

  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        const skillDir = join(dir, entry);
        try {
          if (statSync(skillDir).isDirectory() && existsSync(join(skillDir, "SKILL.md"))) {
            names.add(entry);
          }
        } catch {
          // skip entries that can't be stat'd
        }
      }
    } catch {
      // skip dirs that can't be listed
    }
  }
  return names;
}

/** Write a parsed session to our shared logs. Same pattern as opencode-ingest. */
export function writeSession(
  session: ParsedSession,
  dryRun = false,
  queryLogPath: string = QUERY_LOG,
  telemetryLogPath: string = TELEMETRY_LOG,
  skillLogPath: string = SKILL_LOG,
): void {
  const { query: prompt, session_id: sessionId, skills_triggered: skills } = session;

  if (dryRun) {
    console.log(
      `  [DRY] session=${sessionId.slice(0, 12)}... turns=${session.assistant_turns} skills=${JSON.stringify(skills)}`,
    );
    if (prompt) console.log(`        query: ${prompt.slice(0, 80)}`);
    return;
  }

  if (prompt && prompt.length >= 4) {
    const queryRecord: QueryLogRecord = {
      timestamp: session.timestamp,
      session_id: sessionId,
      query: prompt,
      source: session.source,
    };
    appendJsonl(queryLogPath, queryRecord, "all_queries");
  }

  const { query: _q, ...telemetry } = session;
  appendJsonl(telemetryLogPath, telemetry, "session_telemetry");

  for (const skillName of skills) {
    const skillRecord: SkillUsageRecord = {
      timestamp: session.timestamp,
      session_id: sessionId,
      skill_name: skillName,
      skill_path: `(openclaw:${skillName})`,
      query: prompt,
      triggered: true,
      source: session.source,
    };
    appendJsonl(skillLogPath, skillRecord, "skill_usage");
  }
}

// --- CLI main ---
export function cliMain(): void {
  const { values } = parseArgs({
    options: {
      "agents-dir": { type: "string", default: OPENCLAW_AGENTS_DIR },
      since: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
    },
    strict: true,
  });

  const agentsDir = values["agents-dir"] ?? OPENCLAW_AGENTS_DIR;

  if (!existsSync(agentsDir)) {
    console.log(`OpenClaw agents directory not found: ${agentsDir}`);
    console.log("Is OpenClaw installed? Try --agents-dir to specify a custom location.");
    process.exit(1);
  }

  let sinceTs: number | null = null;
  if (values.since) {
    const parsed = new Date(`${values.since}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      console.error(`[ERROR] Invalid --since date: "${values.since}". Use YYYY-MM-DD format.`);
      process.exit(1);
    }
    sinceTs = parsed.getTime();
  }

  const skillNames = findOpenClawSkillNames(agentsDir);
  const alreadyIngested = values.force ? new Set<string>() : loadMarker(OPENCLAW_INGEST_MARKER);
  const allSessions = findOpenClawSessions(agentsDir, sinceTs);

  console.log(`Found ${allSessions.length} total sessions.`);

  const pending = allSessions.filter((s) => !alreadyIngested.has(s.sessionId));
  console.log(`${pending.length} not yet ingested.`);

  const newIngested = new Set<string>();
  let ingestedCount = 0;

  for (const sf of pending) {
    const session = parseOpenClawSession(sf.filePath, skillNames);

    if (values.verbose || values["dry-run"]) {
      console.log(
        `  ${values["dry-run"] ? "[DRY] " : ""}Ingesting: ${sf.sessionId.slice(0, 12)}...`,
      );
    }

    writeSession(session, values["dry-run"]);
    newIngested.add(sf.sessionId);
    ingestedCount += 1;
  }

  if (!values["dry-run"]) {
    saveMarker(OPENCLAW_INGEST_MARKER, new Set([...alreadyIngested, ...newIngested]));
  }

  console.log(`\nDone. Ingested ${ingestedCount} sessions.`);
}

if (import.meta.main) {
  cliMain();
}
