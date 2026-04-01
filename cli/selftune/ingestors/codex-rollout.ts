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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { CANONICAL_LOG, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../constants.js";
import {
  writeQueryToDb,
  writeSessionTelemetryToDb,
  writeSkillUsageToDb,
} from "../localdb/direct-write.js";
import {
  appendCanonicalRecords,
  buildCanonicalExecutionFact,
  buildCanonicalPrompt,
  buildCanonicalSession,
  buildCanonicalSkillInvocation,
  type CanonicalBaseInput,
  deriveInvocationMode,
  derivePromptId,
  deriveSkillInvocationId,
} from "../normalization.js";
import type {
  CanonicalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { handleCLIError } from "../utils/cli-error.js";
import { loadMarker, saveMarker } from "../utils/jsonl.js";
import { extractActionableQueryText } from "../utils/query-filter.js";
import { getInternalPromptTargetSkill, isWrappedNonUserPart } from "../utils/skill-detection.js";
import {
  classifySkillPath,
  extractExplicitSkillMentions,
  extractSkillNamesFromInstructions,
  extractSkillNamesFromPathReferences,
  findInstalledSkillNames,
  findInstalledSkillPath,
  findRepositorySkillDirs,
} from "../utils/skill-discovery.js";

const MARKER_FILE = join(homedir(), ".claude", "codex_ingested_rollouts.json");

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
  let lastUserQuery = "";
  const toolCalls: Record<string, number> = {};
  const bashCommands: string[] = [];
  const skillsTriggered: string[] = [];
  const skillEvidence = new Map<string, "explicit" | "inferred">();
  let errors = 0;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;

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
  const rememberSessionSkillNames = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
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
  const detectExplicitPromptSkillMentions = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
    if (isWrappedNonUserPart(text)) return;
    const actionableText = extractActionableQueryText(text) ?? text;
    const internalTargetSkill = getInternalPromptTargetSkill(actionableText, sessionSkillNames);
    if (internalTargetSkill) {
      markSkillTriggered(internalTargetSkill, "explicit");
      return;
    }
    for (const skillName of extractExplicitSkillMentions(actionableText, sessionSkillNames)) {
      markSkillTriggered(skillName, "explicit");
    }
  };
  const detectExplicitSkillReads = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
    for (const skillName of extractSkillNamesFromPathReferences(text, sessionSkillNames)) {
      markSkillTriggered(skillName, "explicit");
    }
  };
  const rememberPromptCandidate = (value: unknown): void => {
    const message = typeof value === "string" ? value.trim() : "";
    if (!message) return;
    lastUserQuery = message;
    const actionableMessage = extractActionableQueryText(message);
    if (actionableMessage) {
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

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

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
      rememberSessionSkillNames(payload.instructions);
      rememberSessionSkillNames(
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
        rememberPromptCandidate(payload.message);
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
        const content = parts.join("\n");
        rememberSessionSkillNames(content);
        if ((payload.role as string) === "user") {
          for (const part of parts) {
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
      rememberPromptCandidate(event.user_message);
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
    transcript_chars: lines.reduce((sum, l) => sum + l.length, 0),
    cwd: observedCwd ?? "",
    transcript_path: path,
    last_user_query: lastUserQuery || prompt,
    observed_meta: observedMeta,
  };
}

/** Write parsed session data to shared logs. */
export function ingestFile(
  parsed: ParsedRollout,
  dryRun = false,
  queryLogPath: string = QUERY_LOG,
  telemetryLogPath: string = TELEMETRY_LOG,
  skillLogPath: string = SKILL_LOG,
  canonicalLogPath: string = CANONICAL_LOG,
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
    writeQueryToDb(queryRecord);
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
  writeSessionTelemetryToDb(telemetry);

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
    writeSkillUsageToDb(skillRecord);
  }

  // --- Canonical normalization records (additive) ---
  const canonicalRecords = buildCanonicalRecordsFromRollout(parsed);
  appendCanonicalRecords(canonicalRecords, canonicalLogPath);

  return true;
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
  const promptId = promptEmitted ? derivePromptId(parsed.session_id, 0) : undefined;

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
        skill_invocation_id: deriveSkillInvocationId(parsed.session_id, skillName, i),
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
  try {
    cliMain();
  } catch (err) {
    handleCLIError(err);
  }
}
