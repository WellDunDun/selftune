/**
 * Canonical telemetry normalization helpers.
 *
 * This module provides shared functions that all platform adapters call
 * to produce canonical records alongside their raw JSONL output.
 *
 * Contract rules (from telemetry-field-map.md):
 *   1. Normalization is additive — raw capture is preserved separately.
 *   2. Every canonical record includes platform, capture_mode,
 *      source_session_kind, session_id, and raw_source_ref.
 *   3. prompt_kind, is_actionable, invocation_mode, and confidence are
 *      normalization outputs, not downstream heuristics.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { CANONICAL_LOG, canonicalSessionStatePath } from "./constants.js";
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalCaptureMode,
  type CanonicalCompletionStatus,
  type CanonicalExecutionFactRecord,
  type CanonicalInvocationMode,
  type CanonicalPlatform,
  type CanonicalPromptKind,
  type CanonicalPromptRecord,
  type CanonicalRawSourceRef,
  type CanonicalRecord,
  type CanonicalSessionRecord,
  type CanonicalSessionRecordBase,
  type CanonicalSkillInvocationRecord,
  type CanonicalSourceSessionKind,
} from "./types.js";
import { isActionableQueryText } from "./utils/query-filter.js";

/** Current normalizer version. Bump on logic changes. */
export const NORMALIZER_VERSION = "1.0.0";

interface CanonicalPromptSessionState {
  session_id: string;
  next_prompt_index: number;
  last_prompt_id?: string;
  last_actionable_prompt_id?: string;
  updated_at: string;
}

interface PromptStateLockMetadata {
  owner_id: string;
  pid: number;
  acquired_at: string;
  heartbeat_at: string;
  state_path: string;
}

const PROMPT_STATE_LOCK_TIMEOUT_MS = 30_000;
const PROMPT_STATE_LOCK_POLL_MS = 25;
const PROMPT_STATE_LOCK_SAB = new SharedArrayBuffer(4);
const PROMPT_STATE_LOCK_VIEW = new Int32Array(PROMPT_STATE_LOCK_SAB);

function sleepSync(ms: number): void {
  Atomics.wait(PROMPT_STATE_LOCK_VIEW, 0, 0, ms);
}

function defaultPromptSessionState(sessionId: string): CanonicalPromptSessionState {
  return {
    session_id: sessionId,
    next_prompt_index: 0,
    updated_at: new Date().toISOString(),
  };
}

function derivePromptSessionStateFromCanonicalLog(
  sessionId: string,
  canonicalLogPath: string = CANONICAL_LOG,
): CanonicalPromptSessionState {
  const recovered = defaultPromptSessionState(sessionId);
  let maxPromptIndex = -1;
  let maxActionablePromptIndex = -1;

  if (!existsSync(canonicalLogPath)) {
    return recovered;
  }

  let content = "";
  try {
    content = readFileSync(canonicalLogPath, "utf-8");
  } catch {
    return recovered;
  }

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.record_kind !== "prompt" || parsed.session_id !== sessionId) continue;

    const promptId = typeof parsed.prompt_id === "string" ? parsed.prompt_id : undefined;
    let promptIndex =
      typeof parsed.prompt_index === "number" && Number.isFinite(parsed.prompt_index)
        ? parsed.prompt_index
        : undefined;

    if (promptIndex === undefined && promptId) {
      const match = /:p(\d+)$/.exec(promptId);
      if (match) {
        promptIndex = Number.parseInt(match[1], 10);
      }
    }

    if (promptIndex === undefined || !Number.isFinite(promptIndex)) continue;

    if (promptIndex >= maxPromptIndex) {
      maxPromptIndex = promptIndex;
      recovered.last_prompt_id = promptId ?? derivePromptId(sessionId, promptIndex);
    }

    if (parsed.is_actionable === true && promptIndex >= maxActionablePromptIndex) {
      maxActionablePromptIndex = promptIndex;
      recovered.last_actionable_prompt_id = promptId ?? derivePromptId(sessionId, promptIndex);
    }
  }

  recovered.next_prompt_index = maxPromptIndex >= 0 ? maxPromptIndex + 1 : 0;
  return recovered;
}

function archiveCorruptPromptSessionState(path: string): void {
  if (!existsSync(path)) return;
  const archivedPath = `${path}.corrupt-${Date.now()}`;
  renameSync(path, archivedPath);
}

function joinPromptStateLockPath(path: string): string {
  return `${path}.lock`;
}

function joinPromptStateLockMetadataPath(lockPath: string): string {
  return `${lockPath}/owner.json`;
}

function writePromptStateLockMetadata(lockPath: string, ownerId: string, statePath: string): void {
  const now = new Date().toISOString();
  const metadataPath = joinPromptStateLockMetadataPath(lockPath);
  const metadata: PromptStateLockMetadata = {
    owner_id: ownerId,
    pid: process.pid,
    acquired_at: now,
    heartbeat_at: now,
    state_path: statePath,
  };
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
}

function readPromptStateLockMetadata(lockPath: string): PromptStateLockMetadata | null {
  const metadataPath = joinPromptStateLockMetadataPath(lockPath);
  if (!existsSync(metadataPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf-8")) as PromptStateLockMetadata;
    if (
      typeof parsed.owner_id === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.heartbeat_at === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function touchPromptStateLock(lockPath: string, ownerId: string, statePath: string): void {
  const metadataPath = joinPromptStateLockMetadataPath(lockPath);
  const current = readPromptStateLockMetadata(lockPath);
  if (current && current.owner_id !== ownerId) return;

  const now = new Date().toISOString();
  const metadata: PromptStateLockMetadata = {
    owner_id: ownerId,
    pid: process.pid,
    acquired_at: current?.acquired_at ?? now,
    heartbeat_at: now,
    state_path: statePath,
  };
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
}

function loadPromptSessionState(
  path: string,
  sessionId: string,
  canonicalLogPath: string = CANONICAL_LOG,
  options?: { archiveCorrupt?: boolean },
): CanonicalPromptSessionState {
  if (!existsSync(path)) {
    return derivePromptSessionStateFromCanonicalLog(sessionId, canonicalLogPath);
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CanonicalPromptSessionState;
    if (
      parsed.session_id === sessionId &&
      typeof parsed.next_prompt_index === "number" &&
      Number.isFinite(parsed.next_prompt_index)
    ) {
      return parsed;
    }
  } catch {
    // fall through to canonical-log recovery
  }

  if (options?.archiveCorrupt) {
    try {
      archiveCorruptPromptSessionState(path);
    } catch {
      // Ignore archive failures and recover from canonical log instead.
    }
  }

  return derivePromptSessionStateFromCanonicalLog(sessionId, canonicalLogPath);
}

function savePromptSessionState(path: string, state: CanonicalPromptSessionState): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tempPath = joinTempStatePath(path);
  writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tempPath, path);
}

function joinTempStatePath(path: string): string {
  return `${dirname(path)}/.${basename(path)}.tmp-${process.pid}-${Date.now()}`;
}

function isStaleLock(lockPath: string): boolean {
  const metadata = readPromptStateLockMetadata(lockPath);
  try {
    const heartbeatAt = metadata ? Date.parse(metadata.heartbeat_at) : statSync(lockPath).mtimeMs;
    if (!Number.isFinite(heartbeatAt)) return false;
    return Date.now() - heartbeatAt > PROMPT_STATE_LOCK_TIMEOUT_MS;
  } catch {
    return false;
  }
}

function withPromptStateLock<T>(statePath: string, fn: () => T): T {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const lockPath = joinPromptStateLockPath(statePath);
  const deadline = Date.now() + PROMPT_STATE_LOCK_TIMEOUT_MS;
  const ownerId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  while (true) {
    try {
      mkdirSync(lockPath);
      writePromptStateLockMetadata(lockPath, ownerId, statePath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      if (isStaleLock(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring prompt state lock for ${statePath}`);
      }

      sleepSync(PROMPT_STATE_LOCK_POLL_MS);
    }
  }

  try {
    touchPromptStateLock(lockPath, ownerId, statePath);
    return fn();
  } finally {
    const metadata = readPromptStateLockMetadata(lockPath);
    if (!metadata || metadata.owner_id === ownerId) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
}

export interface CanonicalPromptIdentity {
  prompt_id: string;
  prompt_index: number;
}

export function reservePromptIdentity(
  sessionId: string,
  isActionable: boolean,
  statePath: string = canonicalSessionStatePath(sessionId),
  canonicalLogPath: string = CANONICAL_LOG,
): CanonicalPromptIdentity {
  return withPromptStateLock(statePath, () => {
    const state = loadPromptSessionState(statePath, sessionId, canonicalLogPath, {
      archiveCorrupt: true,
    });
    const promptIndex = state.next_prompt_index;
    const promptId = derivePromptId(sessionId, promptIndex);

    state.next_prompt_index = promptIndex + 1;
    state.last_prompt_id = promptId;
    if (isActionable) state.last_actionable_prompt_id = promptId;
    state.updated_at = new Date().toISOString();
    savePromptSessionState(statePath, state);

    return { prompt_id: promptId, prompt_index: promptIndex };
  });
}

export function getLatestPromptIdentity(
  sessionId: string,
  statePath: string = canonicalSessionStatePath(sessionId),
  canonicalLogPath: string = CANONICAL_LOG,
): { last_prompt_id?: string; last_actionable_prompt_id?: string } {
  const state = loadPromptSessionState(statePath, sessionId, canonicalLogPath);
  return {
    last_prompt_id: state.last_prompt_id,
    last_actionable_prompt_id: state.last_actionable_prompt_id,
  };
}

export function appendCanonicalRecord(
  record: CanonicalRecord,
  logPath: string = CANONICAL_LOG,
): void {
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
}

export function appendCanonicalRecords(
  records: CanonicalRecord[],
  logPath: string = CANONICAL_LOG,
): void {
  for (const record of records) appendCanonicalRecord(record, logPath);
}

// ---------------------------------------------------------------------------
// Prompt classification
// ---------------------------------------------------------------------------

const META_PREFIXES = [
  "<system_instruction>",
  "<system-instruction>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<command-name>",
  "Tool loaded.",
  "You are an evaluation assistant.",
  "You are a skill description optimizer",
  "CONTEXT:",
  "Base directory for this skill:",
  "USER'S CURRENT MESSAGE (summarize THIS):",
];

const CONTINUATION_PREFIXES = [
  "This session is being continued from a previous conversation",
  "Continue from where you left off.",
];

const TASK_NOTIFICATION_PREFIXES = ["<task-notification>", "Completing task"];

const TEAMMATE_MESSAGE_PREFIXES = ["<teammate-message"];

const TOOL_OUTPUT_PREFIXES = ["<tool_result", "<function_result"];

const SYSTEM_INSTRUCTION_PREFIXES = [
  "[Automated",
  "[System",
  "[Request interrupted by user for tool use]",
  "[Request interrupted by user]",
];

/**
 * Classify a prompt into a canonical prompt kind.
 * Order matters — more specific prefixes checked first.
 */
export function classifyPromptKind(text: string): CanonicalPromptKind {
  if (typeof text !== "string") return "unknown";
  const trimmed = text.trim();
  if (!trimmed) return "unknown";

  if (TOOL_OUTPUT_PREFIXES.some((p) => trimmed.startsWith(p))) return "tool_output";
  if (SYSTEM_INSTRUCTION_PREFIXES.some((p) => trimmed.startsWith(p))) return "system_instruction";
  if (TASK_NOTIFICATION_PREFIXES.some((p) => trimmed.startsWith(p))) return "task_notification";
  if (TEAMMATE_MESSAGE_PREFIXES.some((p) => trimmed.startsWith(p))) return "teammate_message";
  if (CONTINUATION_PREFIXES.some((p) => trimmed.startsWith(p))) return "continuation";
  if (META_PREFIXES.some((p) => trimmed.startsWith(p))) return "meta";

  return "user";
}

/**
 * Determine if a prompt is actionable (real user work vs meta/system noise).
 * Delegates to the existing query-filter logic for backward compatibility.
 */
export function classifyIsActionable(text: string): boolean {
  return isActionableQueryText(text);
}

// ---------------------------------------------------------------------------
// Invocation mode
// ---------------------------------------------------------------------------

export interface InvocationClassification {
  invocation_mode: CanonicalInvocationMode;
  confidence: number;
}

/**
 * Classify how a skill was invoked.
 */
export function deriveInvocationMode(opts: {
  has_skill_tool_call?: boolean;
  has_skill_md_read?: boolean;
  is_text_mention_only?: boolean;
  is_repaired?: boolean;
}): InvocationClassification {
  if (opts.is_repaired) return { invocation_mode: "repaired", confidence: 0.9 };
  if (opts.has_skill_tool_call) return { invocation_mode: "explicit", confidence: 1.0 };
  if (opts.has_skill_md_read) return { invocation_mode: "implicit", confidence: 0.7 };
  if (opts.is_text_mention_only) return { invocation_mode: "inferred", confidence: 0.4 };
  return { invocation_mode: "inferred", confidence: 0.4 };
}

// ---------------------------------------------------------------------------
// Prompt hashing
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic prompt hash for dedupe and privacy-safe analytics.
 */
export function hashPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Derive a deterministic prompt ID from session + index.
 */
export function derivePromptId(sessionId: string, index: number): string {
  return `${sessionId}:p${index}`;
}

/**
 * Derive a deterministic skill invocation ID.
 */
export function deriveSkillInvocationId(
  sessionId: string,
  skillName: string,
  index: number,
): string {
  return `${sessionId}:s:${skillName}:${index}`;
}

// ---------------------------------------------------------------------------
// Canonical record builders
// ---------------------------------------------------------------------------

export interface CanonicalBaseInput {
  platform: CanonicalPlatform;
  capture_mode: CanonicalCaptureMode;
  source_session_kind: CanonicalSourceSessionKind;
  session_id: string;
  raw_source_ref: CanonicalRawSourceRef;
}

function makeBase(
  record_kind: CanonicalSessionRecordBase["record_kind"],
  input: CanonicalBaseInput,
): CanonicalSessionRecordBase {
  return {
    record_kind,
    schema_version: CANONICAL_SCHEMA_VERSION,
    normalizer_version: NORMALIZER_VERSION,
    normalized_at: new Date().toISOString(),
    platform: input.platform,
    capture_mode: input.capture_mode,
    source_session_kind: input.source_session_kind,
    session_id: input.session_id,
    raw_source_ref: input.raw_source_ref,
  };
}

export interface BuildSessionInput extends CanonicalBaseInput {
  started_at?: string;
  ended_at?: string;
  external_session_id?: string;
  parent_session_id?: string;
  agent_id?: string;
  agent_type?: string;
  agent_cli?: string;
  session_key?: string;
  channel?: string;
  workspace_path?: string;
  repo_root?: string;
  repo_remote?: string;
  branch?: string;
  commit_sha?: string;
  permission_mode?: string;
  approval_policy?: string;
  sandbox_policy?: string;
  provider?: string;
  model?: string;
  completion_status?: CanonicalCompletionStatus;
  end_reason?: string;
}

export function buildCanonicalSession(input: BuildSessionInput): CanonicalSessionRecord {
  const base = makeBase("session", input);
  const record: CanonicalSessionRecord = { ...base, record_kind: "session" };

  // Copy optional fields only when present
  if (input.started_at !== undefined) record.started_at = input.started_at;
  if (input.ended_at !== undefined) record.ended_at = input.ended_at;
  if (input.external_session_id !== undefined)
    record.external_session_id = input.external_session_id;
  if (input.parent_session_id !== undefined) record.parent_session_id = input.parent_session_id;
  if (input.agent_id !== undefined) record.agent_id = input.agent_id;
  if (input.agent_type !== undefined) record.agent_type = input.agent_type;
  if (input.agent_cli !== undefined) record.agent_cli = input.agent_cli;
  if (input.session_key !== undefined) record.session_key = input.session_key;
  if (input.channel !== undefined) record.channel = input.channel;
  if (input.workspace_path !== undefined) record.workspace_path = input.workspace_path;
  if (input.repo_root !== undefined) record.repo_root = input.repo_root;
  if (input.repo_remote !== undefined) record.repo_remote = input.repo_remote;
  if (input.branch !== undefined) record.branch = input.branch;
  if (input.commit_sha !== undefined) record.commit_sha = input.commit_sha;
  if (input.permission_mode !== undefined) record.permission_mode = input.permission_mode;
  if (input.approval_policy !== undefined) record.approval_policy = input.approval_policy;
  if (input.sandbox_policy !== undefined) record.sandbox_policy = input.sandbox_policy;
  if (input.provider !== undefined) record.provider = input.provider;
  if (input.model !== undefined) record.model = input.model;
  if (input.completion_status !== undefined) record.completion_status = input.completion_status;
  if (input.end_reason !== undefined) record.end_reason = input.end_reason;

  return record;
}

export interface BuildPromptInput extends CanonicalBaseInput {
  prompt_id: string;
  occurred_at: string;
  prompt_text: string;
  prompt_kind?: CanonicalPromptKind;
  is_actionable?: boolean;
  prompt_hash?: string;
  prompt_index?: number;
  parent_prompt_id?: string;
  source_message_id?: string;
}

export function buildCanonicalPrompt(input: BuildPromptInput): CanonicalPromptRecord {
  const base = makeBase("prompt", input);
  const kind = input.prompt_kind ?? classifyPromptKind(input.prompt_text);
  const actionable = input.is_actionable ?? classifyIsActionable(input.prompt_text);

  const record: CanonicalPromptRecord = {
    ...base,
    record_kind: "prompt",
    prompt_id: input.prompt_id,
    occurred_at: input.occurred_at,
    prompt_text: input.prompt_text,
    prompt_hash: input.prompt_hash ?? hashPrompt(input.prompt_text),
    prompt_kind: kind,
    is_actionable: actionable,
  };

  if (input.prompt_index !== undefined) record.prompt_index = input.prompt_index;
  if (input.parent_prompt_id !== undefined) record.parent_prompt_id = input.parent_prompt_id;
  if (input.source_message_id !== undefined) record.source_message_id = input.source_message_id;

  return record;
}

export interface BuildSkillInvocationInput extends CanonicalBaseInput {
  skill_invocation_id: string;
  occurred_at: string;
  matched_prompt_id?: string;
  skill_name: string;
  skill_path?: string;
  skill_version_hash?: string;
  invocation_mode: CanonicalInvocationMode;
  triggered: boolean;
  confidence: number;
  tool_name?: string;
  tool_call_id?: string;
}

export function buildCanonicalSkillInvocation(
  input: BuildSkillInvocationInput,
): CanonicalSkillInvocationRecord {
  const base = makeBase("skill_invocation", input);

  const record: CanonicalSkillInvocationRecord = {
    ...base,
    record_kind: "skill_invocation",
    skill_invocation_id: input.skill_invocation_id,
    occurred_at: input.occurred_at,
    skill_name: input.skill_name,
    invocation_mode: input.invocation_mode,
    triggered: input.triggered,
    confidence: input.confidence,
  };

  if (input.matched_prompt_id !== undefined) record.matched_prompt_id = input.matched_prompt_id;
  if (input.skill_path !== undefined) record.skill_path = input.skill_path;
  if (input.skill_version_hash !== undefined) record.skill_version_hash = input.skill_version_hash;
  if (input.tool_name !== undefined) record.tool_name = input.tool_name;
  if (input.tool_call_id !== undefined) record.tool_call_id = input.tool_call_id;

  return record;
}

export interface BuildExecutionFactInput extends CanonicalBaseInput {
  occurred_at: string;
  prompt_id?: string;
  tool_calls_json: Record<string, number>;
  total_tool_calls: number;
  bash_commands_redacted: string[];
  assistant_turns: number;
  errors_encountered: number;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  completion_status?: CanonicalCompletionStatus;
  end_reason?: string;
}

export function buildCanonicalExecutionFact(
  input: BuildExecutionFactInput,
): CanonicalExecutionFactRecord {
  const base = makeBase("execution_fact", input);

  const record: CanonicalExecutionFactRecord = {
    ...base,
    record_kind: "execution_fact",
    occurred_at: input.occurred_at,
    tool_calls_json: input.tool_calls_json,
    total_tool_calls: input.total_tool_calls,
    bash_commands_redacted: input.bash_commands_redacted,
    assistant_turns: input.assistant_turns,
    errors_encountered: input.errors_encountered,
  };

  if (input.prompt_id !== undefined) record.prompt_id = input.prompt_id;
  if (input.input_tokens !== undefined) record.input_tokens = input.input_tokens;
  if (input.output_tokens !== undefined) record.output_tokens = input.output_tokens;
  if (input.duration_ms !== undefined) record.duration_ms = input.duration_ms;
  if (input.completion_status !== undefined) record.completion_status = input.completion_status;
  if (input.end_reason !== undefined) record.end_reason = input.end_reason;

  return record;
}
