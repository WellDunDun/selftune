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

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import {
  CANONICAL_LOG,
  CODEX_INGEST_MARKER,
  QUERY_LOG,
  SKILL_LOG,
  TELEMETRY_LOG,
} from "@selftune/runtime/constants";
import {
  replaceCanonicalSessionSnapshotToDb,
  writeQueryToDb,
  writeSessionTelemetryToDb,
  writeSkillUsageToDb,
} from "@selftune/runtime/localdb/direct-write";
import {
  buildCanonicalExecutionFact,
  buildCanonicalPrompt,
  buildCanonicalSession,
  buildCanonicalSkillInvocation,
  type CanonicalBaseInput,
  deriveInvocationMode,
  derivePromptId,
  deriveSkillInvocationId,
  NORMALIZER_VERSION,
} from "@selftune/runtime/normalization";
import type {
  CanonicalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "@selftune/runtime/types";
import { handleCLIError } from "@selftune/runtime/utils/cli-error";
import {
  fingerprintIngestionFile,
  isFileIngestionCurrent,
  loadFileIngestionMarker,
  saveFileIngestionMarker,
} from "@selftune/runtime/utils/jsonl";
import { extractActionableQueryText } from "@selftune/runtime/utils/query-filter";
import {
  getInternalPromptTargetSkill,
  isWrappedNonUserPart,
} from "@selftune/runtime/utils/skill-detection";
import {
  classifySkillPath,
  extractSkillNamesFromInstructions,
  extractSkillNamesFromPathReferences,
  findInstalledSkillNames,
  findInstalledSkillPath,
  findRepositorySkillDirs,
} from "@selftune/runtime/utils/skill-discovery";
export { buildLocalTelemetryBatchFromRollout } from "./codex-trace-projection.js";
import {
  scanRolloutLines,
  scanRolloutLinesAsync,
  type RolloutLineScan,
} from "./rollout-line-scanner.js";

export const DEFAULT_CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const SKILL_NAME_CACHE = new Map<string, Set<string>>();

/** Return skill names from Codex and agent skill directories for the given workspace. */
export function findSkillNames(
  cwd: string = process.cwd(),
  homeDir: string = homedir(),
  adminDir: string = "/etc/codex/skills",
  codexHome: string = process.env.CODEX_HOME ?? join(homeDir, ".codex"),
): Set<string> {
  const cacheKey = [cwd, homeDir, adminDir, codexHome].join("\u0000");
  const cached = SKILL_NAME_CACHE.get(cacheKey);
  if (cached) return new Set(cached);

  const names = findInstalledSkillNames([
    ...findRepositorySkillDirs(cwd),
    join(homeDir, ".agents", "skills"),
    adminDir,
    join(codexHome, "skills"),
    join(codexHome, "skills", ".system"),
  ]);
  SKILL_NAME_CACHE.set(cacheKey, names);
  return new Set(names);
}

/**
 * Find all rollout-*.jsonl files under codexHome/sessions/YYYY/MM/DD/.
 * If `since` is given, only return files from that date onward.
 */
export function findRolloutFiles(codexHome: string, since?: Date): string[] {
  const sessionsDir = join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) return [];

  const files: string[] = [];
  const sinceDay = since
    ? Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
    : undefined;

  for (const yearEntry of readdirSync(sessionsDir).toSorted()) {
    const yearDir = join(sessionsDir, yearEntry);
    try {
      if (!statSync(yearDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const year = Number.parseInt(yearEntry, 10);
    if (Number.isNaN(year)) continue;
    if (sinceDay !== undefined && Date.UTC(year + 1, 0, 1) <= sinceDay) continue;

    for (const monthEntry of readdirSync(yearDir).toSorted()) {
      const monthDir = join(yearDir, monthEntry);
      try {
        if (!statSync(monthDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const month = Number.parseInt(monthEntry, 10);
      if (Number.isNaN(month)) continue;
      if (sinceDay !== undefined && Date.UTC(year, month, 1) <= sinceDay) continue;

      for (const dayEntry of readdirSync(monthDir).toSorted()) {
        const dayDir = join(monthDir, dayEntry);
        try {
          if (!statSync(dayDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const day = Number.parseInt(dayEntry, 10);
        if (Number.isNaN(day)) continue;

        if (sinceDay !== undefined) {
          const fileDay = Date.UTC(year, month - 1, day);
          if (fileDay < sinceDay) continue;
        }

        for (const file of readdirSync(dayDir).toSorted()) {
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
  started_at?: string;
  ended_at?: string;
  actionable_prompt_count?: number;
  session_id: string;
  source: string;
  rollout_path: string;
  query: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  skills_invoked: string[];
  skill_evidence: Record<string, "explicit" | "inferred">;
  assistant_turns: number;
  errors_encountered: number;
  input_tokens: number;
  output_tokens: number;
  transcript_chars: number;
  cwd: string;
  transcript_path: string;
  last_user_query: string;
  /** Observed-format metadata (populated when session_meta/event_msg records are found). */
  observed_meta?: {
    model_provider?: string;
    model?: string;
    approval_policy?: string;
    sandbox_policy?: string;
    originator?: string;
    git?: { branch?: string; remote?: string; commit?: string };
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

const explicitSkillMentionPrefixes = [
  "use",
  "using",
  "run",
  "invoke",
  "apply",
  "load",
  "open",
  "read",
  "follow",
] as const;
const explicitSkillMentionConnectors = ["with", "via", "through"] as const;
const explicitSkillMentionSetupPrefixes = [
  "initialize",
  "init",
  "configure",
  "setup",
  "set up",
  "audit",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeExplicitSkillMatchers(skillNames: Iterable<string>): ReadonlyArray<RegExp> {
  const alternatives = [...new Set([...skillNames].map((name) => name.trim()).filter(Boolean))]
    .toSorted((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  if (!alternatives) return [];
  const group = `(${alternatives})`;
  return [
    new RegExp(`\\$${group}(?:\\b|$)`, "gi"),
    new RegExp(`\\b${group}\\s+skill\\b`, "gi"),
    new RegExp(`\\b(?:${explicitSkillMentionPrefixes.join("|")})\\s+${group}\\b`, "gi"),
    new RegExp(`\\b(?:${explicitSkillMentionConnectors.join("|")})\\s+${group}\\b`, "gi"),
    new RegExp(`\\b(?:${explicitSkillMentionSetupPrefixes.join("|")})\\s+${group}\\b`, "gi"),
  ];
}

function hasSkillPathReference(text: string): boolean {
  return (
    text.includes(".agents/skills/") ||
    text.includes(".codex/skills/") ||
    text.includes(".opencode/skills/") ||
    text.includes(".claude/skills/") ||
    text.includes("/etc/codex/skills/")
  );
}

interface RolloutParser {
  readonly onLine: (line: string) => void;
  readonly finish: (scan: RolloutLineScan | null) => ParsedRollout | null;
}

function makeRolloutParser(path: string, skillNames: Set<string>): RolloutParser {
  const threadId = basename(path, ".jsonl").replace("rollout-", "");
  let prompt = "";
  let lastUserQuery = "";
  const toolCalls: Record<string, number> = {};
  const bashCommands: string[] = [];
  const skillsTriggered: string[] = [];
  const skillEvidence = new Map<string, "explicit" | "inferred">();
  let errors = 0;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let actionablePromptCount = 0;
  let observedStartedAt: string | undefined;
  let observedEndedAt: string | undefined;

  // Observed-format metadata (session_meta/turn_context/event_msg records)
  let observedMeta:
    | {
        model_provider?: string;
        model?: string;
        approval_policy?: string;
        sandbox_policy?: string;
        originator?: string;
        git?: { branch?: string; remote?: string; commit?: string };
      }
    | undefined;
  let observedSessionId: string | undefined;
  let observedCwd: string | undefined;
  const sessionSkillNames = new Set(skillNames);
  let explicitSkillMatchers: ReadonlyArray<RegExp> = [];
  let canonicalSkillNames = new Map<string, string>();
  let matcherSkillCount = -1;
  let hasActionablePrompt = false;
  const markSkillTriggered = (skillName: string, evidence: "explicit" | "inferred"): void => {
    if (!skillsTriggered.includes(skillName)) {
      skillsTriggered.push(skillName);
    }
    const existingEvidence = skillEvidence.get(skillName);
    if (existingEvidence !== "explicit") {
      skillEvidence.set(skillName, evidence);
    }
  };
  // The skill inventory is authority-bearing: only session metadata is a
  // trusted declaration of what was installed for this rollout. User and
  // assistant content can quote, generate, or relay arbitrary instructions.
  const rememberTrustedSessionSkillNames = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
    // Session metadata can be large. The extractor only recognizes a
    // dedicated heading, so avoid allocating a skill map when it is absent.
    if (!/(?:^|\n)\s*###\s+available skills\s*$/im.test(text)) return;
    for (const skillName of extractSkillNamesFromInstructions(text, sessionSkillNames)) {
      sessionSkillNames.add(skillName);
    }
  };
  const rememberWorkspaceSkills = (cwd: unknown): void => {
    if (typeof cwd !== "string" || !cwd.trim()) return;
    for (const skillName of findSkillNames(cwd)) {
      sessionSkillNames.add(skillName);
    }
  };
  const detectExplicitSkillNames = (text: string): void => {
    if (matcherSkillCount !== sessionSkillNames.size) {
      explicitSkillMatchers = makeExplicitSkillMatchers(sessionSkillNames);
      canonicalSkillNames = new Map(
        [...sessionSkillNames].map((skillName) => [skillName.toLowerCase(), skillName]),
      );
      matcherSkillCount = sessionSkillNames.size;
    }
    for (const matcher of explicitSkillMatchers) {
      matcher.lastIndex = 0;
      for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
        const skillName = match[1];
        if (skillName) {
          markSkillTriggered(
            canonicalSkillNames.get(skillName.toLowerCase()) ?? skillName,
            "explicit",
          );
        }
      }
    }
  };
  const detectExplicitPromptSkillMentions = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
    if (isWrappedNonUserPart(text)) return;
    const actionableQuery = extractActionableQueryText(text);
    const actionableText = actionableQuery ?? text;
    if (actionableQuery && hasSkillPathReference(actionableQuery)) {
      for (const skillName of extractSkillNamesFromPathReferences(
        actionableQuery,
        sessionSkillNames,
      )) {
        markSkillTriggered(skillName, "explicit");
      }
    }
    const internalTargetSkill = getInternalPromptTargetSkill(actionableText, sessionSkillNames);
    if (internalTargetSkill) {
      markSkillTriggered(internalTargetSkill, "explicit");
      return;
    }
    // `extractExplicitSkillMentions` tests five regular expressions for every
    // installed skill. Most Codex user-message events are ordinary prompts,
    // so a cheap necessary-condition check avoids multiplying large prompts
    // by the complete skill inventory. Every phrase accepted by the precise
    // extractor contains one of these markers.
    if (
      !/\$|\b(?:skill|use|using|run|invoke|apply|load|open|read|follow|with|via|through|initialize|init|configure|setup|set\s+up|audit)\b/i.test(
        actionableText,
      )
    ) {
      return;
    }
    detectExplicitSkillNames(actionableText);
  };
  const detectExplicitSkillReads = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
    if (!hasSkillPathReference(text)) return;
    for (const skillName of extractSkillNamesFromPathReferences(text, sessionSkillNames)) {
      markSkillTriggered(skillName, "explicit");
    }
  };
  const rememberPromptCandidate = (value: unknown, trackActionable = false): void => {
    const message = typeof value === "string" ? value.trim() : "";
    if (!message) return;
    lastUserQuery = message;
    const actionableMessage = extractActionableQueryText(message);
    if (actionableMessage) {
      if (trackActionable) actionablePromptCount += 1;
      if (!hasActionablePrompt) {
        prompt = actionableMessage;
        hasActionablePrompt = true;
      }
      return;
    }
    if (!prompt) {
      prompt = message;
    }
  };
  const observeTimestamp = (value: string): void => {
    const epochMilliseconds = Date.parse(value);
    if (!Number.isFinite(epochMilliseconds)) return;
    const normalizedTimestamp = new Date(epochMilliseconds).toISOString();
    if (observedStartedAt === undefined || epochMilliseconds < Date.parse(observedStartedAt)) {
      observedStartedAt = normalizedTimestamp;
    }
    if (observedEndedAt === undefined || epochMilliseconds > Date.parse(observedEndedAt)) {
      observedEndedAt = normalizedTimestamp;
    }
  };

  const onLine = (line: string): void => {
    const isEventMessage = line.includes('"type":"event_msg"');
    const isResponseItem = line.includes('"type":"response_item"');
    const canSkipEventMessage =
      isEventMessage && !line.includes('"type":"user_message"') && !line.includes('"token_count"');
    const canSkipResponseItem =
      isResponseItem &&
      !line.includes('"type":"function_call"') &&
      !line.includes('"type":"custom_tool_call"') &&
      !line.includes('"type":"agent_reasoning"') &&
      !line.includes('"role":"user"');
    if (canSkipEventMessage || canSkipResponseItem) {
      const timestamp = /(?:^|[,{])"timestamp"\s*:\s*"([^"\\]+)"/.exec(line)?.[1];
      if (timestamp) observeTimestamp(timestamp);
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    const eventTimestamp = optionalString(event.timestamp);
    if (eventTimestamp) observeTimestamp(eventTimestamp);
    const etype = (event.type as string) ?? "";

    // --- Observed local rollout format (session_meta, event_msg, turn_context, response_item) ---
    if (etype === "session_meta") {
      const payload = (event.payload as Record<string, unknown>) ?? {};
      const observedId = optionalString(payload.id);
      const observedWorkspace = optionalString(payload.cwd);
      const modelProvider = optionalString(payload.model_provider);
      const model = optionalString(payload.model);
      const originator = optionalString(payload.originator);
      if (observedId) observedSessionId = observedId;
      if (observedWorkspace) observedCwd = observedWorkspace;
      rememberWorkspaceSkills(observedWorkspace);
      rememberTrustedSessionSkillNames(payload.instructions);
      rememberTrustedSessionSkillNames(
        (payload.base_instructions as Record<string, unknown> | undefined)?.text,
      );
      if (!observedMeta) observedMeta = {};
      if (modelProvider) observedMeta.model_provider = modelProvider;
      if (model) observedMeta.model = model;
      if (originator) observedMeta.originator = originator;
    } else if (etype === "turn_context") {
      const payload = (event.payload as Record<string, unknown>) ?? {};
      const approvalPolicy = optionalString(payload.approval_policy);
      const sandboxPolicy = optionalString(payload.sandbox_policy);
      const model = optionalString(payload.model);
      const gitPayload = payload.git as Record<string, unknown> | undefined;
      if (!observedMeta) observedMeta = {};
      if (approvalPolicy) observedMeta.approval_policy = approvalPolicy;
      if (sandboxPolicy) observedMeta.sandbox_policy = sandboxPolicy;
      if (model) observedMeta.model = model;
      if (gitPayload) {
        observedMeta.git = {
          branch: optionalString(gitPayload.branch),
          remote: optionalString(gitPayload.remote),
          commit: optionalString(gitPayload.commit) ?? optionalString(gitPayload.sha),
        };
      }
      turns += 1;
    } else if (etype === "event_msg") {
      const payload = (event.payload as Record<string, unknown>) ?? {};
      const msgType = (payload.type as string) ?? "";
      if (msgType === "user_message") {
        rememberPromptCandidate(payload.message, true);
        detectExplicitPromptSkillMentions(payload.message);
      }
      // Token usage in event_msg payloads
      const tokenCount = payload.token_count as Record<string, number> | undefined;
      if (tokenCount) {
        inputTokens += tokenCount.input_tokens ?? tokenCount.input ?? 0;
        outputTokens += tokenCount.output_tokens ?? tokenCount.output ?? 0;
      }
    } else if (etype === "response_item") {
      const payload = (event.payload as Record<string, unknown>) ?? {};
      const itemType = (payload.type as string) ?? "";
      if (itemType === "function_call") {
        const fnName = (payload.name as string) ?? "function_call";
        toolCalls[fnName] = (toolCalls[fnName] ?? 0) + 1;
        // Only path-based skill references count as triggers here.
        detectExplicitSkillReads(payload.arguments);
      } else if (itemType === "custom_tool_call") {
        const toolName = optionalString(payload.name) ?? "custom_tool_call";
        toolCalls[toolName] = (toolCalls[toolName] ?? 0) + 1;
        // Codex Desktop sends its executable tool program in `input` rather
        // than the legacy function call's `arguments` field.
        detectExplicitSkillReads(payload.input);
      } else if (itemType === "agent_reasoning") {
        toolCalls.reasoning = (toolCalls.reasoning ?? 0) + 1;
      } else if (itemType === "message") {
        const parts = Array.isArray(payload.content)
          ? payload.content
              .map((part) =>
                typeof part === "object" && part
                  ? (((part as Record<string, unknown>).text as string | undefined) ?? "")
                  : "",
              )
              .filter(Boolean)
          : [];
        if ((payload.role as string) === "user") {
          for (const part of parts) {
            rememberPromptCandidate(part, true);
            detectExplicitPromptSkillMentions(part);
          }
        }
      }
    } else if (etype === "turn.started") {
      // --- Documented Codex event format ---
      turns += 1;
    } else if (etype === "turn.completed") {
      const usage = (event.usage as Record<string, number>) ?? {};
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      rememberPromptCandidate(event.user_message, true);
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
          detectExplicitSkillReads(cmd);
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
      if (itemType === "command_execution") {
        detectExplicitSkillReads(item.command);
      }
    } else if (etype === "error") {
      errors += 1;
    }

    // Some rollout formats embed the original prompt
    rememberPromptCandidate(event.prompt);
  };

  const finish = (scan: RolloutLineScan | null): ParsedRollout | null => {
    if (scan === null || scan.nonEmptyLineCount === 0) return null;

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
      started_at: observedStartedAt,
      ended_at: observedEndedAt,
      actionable_prompt_count: actionablePromptCount,
      session_id: observedSessionId ?? threadId,
      source: "codex_rollout",
      rollout_path: path,
      query: prompt,
      tool_calls: toolCalls,
      total_tool_calls: Object.values(toolCalls).reduce((a, b) => a + b, 0),
      bash_commands: bashCommands,
      skills_triggered: skillsTriggered,
      skills_invoked: skillsTriggered.filter(
        (skillName) => skillEvidence.get(skillName) === "explicit",
      ),
      skill_evidence: Object.fromEntries(skillEvidence),
      assistant_turns: turns,
      errors_encountered: errors,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      transcript_chars: scan.transcriptChars,
      cwd: observedCwd ?? "",
      transcript_path: path,
      last_user_query: lastUserQuery || prompt,
      observed_meta: observedMeta,
    };
  };

  return { onLine, finish };
}

/**
 * Parse a Codex rollout JSONL file synchronously for the standalone
 * compatibility command.
 */
export function parseRolloutFile(path: string, skillNames: Set<string>): ParsedRollout | null {
  const parser = makeRolloutParser(path, skillNames);
  return parser.finish(scanRolloutLines(path, parser.onLine));
}

/** Parse a rollout through bounded, interruptible source-sync I/O. */
export async function parseRolloutFileAsync(
  path: string,
  skillNames: Set<string>,
  signal: AbortSignal,
): Promise<ParsedRollout | null> {
  const parser = makeRolloutParser(path, skillNames);
  return parser.finish(await scanRolloutLinesAsync(path, parser.onLine, signal));
}

/** Write parsed session data to shared logs. */
export function ingestFile(
  parsed: ParsedRollout,
  dryRun = false,
  queryLogPath: string = QUERY_LOG,
  telemetryLogPath: string = TELEMETRY_LOG,
  skillLogPath: string = SKILL_LOG,
  canonicalLogPath: string = CANONICAL_LOG,
  onDryRunMessage?: (message: string) => void,
): boolean {
  const { query: prompt, session_id: sessionId, skills_triggered: skills } = parsed;

  if (dryRun) {
    // oxlint-disable-next-line no-console -- standalone ingestor preserves legacy preview output
    const writeMessage = onDryRunMessage ?? ((message: string) => console.log(message));
    writeMessage(
      `  [DRY RUN] Would ingest: session=${sessionId.slice(0, 12)}... ` +
        `turns=${parsed.assistant_turns} commands=${parsed.bash_commands.length} skills=${JSON.stringify(skills)}`,
    );
    if (prompt) writeMessage(`           query: ${prompt.slice(0, 80)}`);
    return true;
  }

  let succeeded = true;

  // Write to all_queries_log if we have a prompt
  if (prompt && prompt.length >= 4) {
    const queryRecord: QueryLogRecord = {
      timestamp: parsed.timestamp,
      session_id: sessionId,
      query: prompt,
      source: "codex_rollout",
    };
    succeeded = writeQueryToDb(queryRecord) && succeeded;
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
    skills_invoked: parsed.skills_invoked,
    assistant_turns: parsed.assistant_turns,
    errors_encountered: parsed.errors_encountered,
    transcript_chars: parsed.transcript_chars,
    last_user_query: parsed.last_user_query,
    source: parsed.source,
    input_tokens: parsed.input_tokens,
    output_tokens: parsed.output_tokens,
    rollout_path: parsed.rollout_path,
  };
  succeeded = writeSessionTelemetryToDb(telemetry) && succeeded;

  // Write skill triggers
  for (const skillName of skills) {
    const isExplicit = parsed.skill_evidence[skillName] === "explicit";
    const skillPath = isExplicit
      ? (findInstalledSkillPath(skillName, [
          ...findRepositorySkillDirs(parsed.cwd || process.cwd()),
          join(homedir(), ".agents", "skills"),
          "/etc/codex/skills",
          join(DEFAULT_CODEX_HOME, "skills"),
          join(DEFAULT_CODEX_HOME, "skills", ".system"),
        ]) ?? `(codex:${skillName})`)
      : `(codex:${skillName})`;
    const skillRecord: SkillUsageRecord = {
      timestamp: parsed.timestamp,
      session_id: sessionId,
      skill_name: skillName,
      skill_path: skillPath,
      ...classifySkillPath(skillPath),
      query: prompt,
      triggered: true,
      source: isExplicit ? "codex_rollout_explicit" : "codex_rollout",
    };
    succeeded = writeSkillUsageToDb(skillRecord) && succeeded;
  }

  // Canonical replay records are a complete snapshot of the current rollout.
  const canonicalRecords = buildCanonicalRecordsFromRollout(parsed);
  succeeded = replaceCanonicalSessionSnapshotToDb(canonicalRecords) && succeeded;

  return succeeded;
}

/** Build canonical records from a parsed rollout. */
export function buildCanonicalRecordsFromRollout(parsed: ParsedRollout): CanonicalRecord[] {
  const records: CanonicalRecord[] = [];
  const baseInput: CanonicalBaseInput = {
    platform: "codex",
    capture_mode: "batch_ingest",
    source_session_kind: "replayed",
    session_id: parsed.session_id,
    raw_source_ref: {
      path: parsed.rollout_path,
      event_type: "codex_rollout",
    },
  };

  // Session record
  const meta = parsed.observed_meta;
  records.push(
    buildCanonicalSession({
      ...baseInput,
      started_at: parsed.timestamp,
      workspace_path: parsed.cwd || undefined,
      provider: meta?.model_provider,
      model: meta?.model,
      approval_policy: meta?.approval_policy,
      sandbox_policy: meta?.sandbox_policy,
      agent_id: meta?.originator,
      branch: meta?.git?.branch,
      repo_remote: meta?.git?.remote,
      commit_sha: meta?.git?.commit,
    }),
  );

  // Prompt record
  const promptEmitted = Boolean(parsed.query && parsed.query.length >= 4);
  const promptId = promptEmitted
    ? `${derivePromptId(parsed.session_id, 0)}:codex-rollout`
    : undefined;

  if (promptId) {
    records.push(
      buildCanonicalPrompt({
        ...baseInput,
        prompt_id: promptId,
        occurred_at: parsed.timestamp,
        prompt_text: parsed.query,
        prompt_index: 0,
      }),
    );
  }

  // Skill invocation records
  for (let i = 0; i < parsed.skills_triggered.length; i++) {
    const skillName = parsed.skills_triggered[i];
    const isExplicit = parsed.skill_evidence[skillName] === "explicit";
    const { invocation_mode, confidence } = deriveInvocationMode(
      isExplicit ? { has_skill_md_read: true } : { is_text_mention_only: true },
    );
    records.push(
      buildCanonicalSkillInvocation({
        ...baseInput,
        skill_invocation_id: deriveSkillInvocationId(
          parsed.session_id,
          skillName,
          i,
          "codex-rollout",
        ),
        occurred_at: parsed.timestamp,
        matched_prompt_id: promptId,
        skill_name: skillName,
        skill_path: `(codex:${skillName})`,
        invocation_mode,
        triggered: true,
        confidence,
      }),
    );
  }

  // Execution fact record
  records.push(
    buildCanonicalExecutionFact({
      ...baseInput,
      execution_fact_id: `${parsed.session_id}:execution-fact:codex-rollout`,
      occurred_at: parsed.timestamp,
      prompt_id: promptId,
      tool_calls_json: parsed.tool_calls,
      total_tool_calls: parsed.total_tool_calls,
      bash_commands_redacted: parsed.bash_commands,
      assistant_turns: parsed.assistant_turns,
      errors_encountered: parsed.errors_encountered,
      input_tokens: parsed.input_tokens ?? undefined,
      output_tokens: parsed.output_tokens ?? undefined,
    }),
  );

  return records;
}

// --- CLI main ---
export async function cliMain(): Promise<void> {
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

  const marker = loadFileIngestionMarker(CODEX_INGEST_MARKER);
  const skillNames = findSkillNames();
  const candidates = rolloutFiles.map((path) => ({
    path,
    fingerprint: fingerprintIngestionFile(path, NORMALIZER_VERSION),
  }));
  const pending = values.force
    ? candidates
    : candidates.filter(
        ({ path, fingerprint }) => !isFileIngestionCurrent(marker, path, fingerprint),
      );
  console.log(`Found ${rolloutFiles.length} rollout files, ${pending.length} new or changed.`);

  if (since) {
    console.log(`  Filtering to sessions from ${values.since} onward.`);
  }

  let ingestedCount = 0;
  let skippedCount = 0;

  let markerChanged = false;
  for (const { path: rolloutFile, fingerprint } of pending) {
    const parsed = parseRolloutFile(rolloutFile, skillNames);
    if (parsed === null) {
      marker.set(rolloutFile, fingerprint);
      markerChanged = true;
      if (values.verbose) {
        console.log(`  SKIP (empty/unparseable): ${basename(rolloutFile)}`);
      }
      skippedCount += 1;
      continue;
    }

    if (values.verbose || values["dry-run"]) {
      console.log(`  ${values["dry-run"] ? "[DRY] " : ""}Ingesting: ${basename(rolloutFile)}`);
    }

    if (ingestFile(parsed, values["dry-run"], QUERY_LOG, TELEMETRY_LOG, SKILL_LOG, CANONICAL_LOG)) {
      marker.set(rolloutFile, fingerprint);
      markerChanged = true;
      ingestedCount += 1;
    } else {
      skippedCount += 1;
      // oxlint-disable-next-line no-console -- standalone ingestor must expose retryable failure
      console.error(`  RETRY NEEDED (database write failed): ${basename(rolloutFile)}`);
    }
  }

  if (!values["dry-run"] && markerChanged) {
    saveFileIngestionMarker(CODEX_INGEST_MARKER, marker);
  }

  console.log(`\nDone. Ingested ${ingestedCount} sessions, skipped ${skippedCount}.`);
  if (markerChanged && !values["dry-run"]) {
    console.log(`Marker updated: ${CODEX_INGEST_MARKER}`);
  }
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
