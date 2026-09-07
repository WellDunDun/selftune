import { basename, dirname } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import type { DashboardActionMetrics } from "../../dashboard-contract.js";
import type { RuntimeReplayEntryMetrics } from "../../types.js";
import {
  extractExplicitSkillMentions,
  extractSkillNamesFromPathReferences,
} from "../../utils/skill-discovery.js";
import type { RuntimeReplayInvokerInput, RuntimeReplayObservation } from "./contracts.js";
import { resolveReplayPath } from "./workspace.js";
import { optionalEvidence } from "../../utils/transcript-contract.js";

const Text = optionalEvidence(Schema.String);
const NumberField = optionalEvidence(Schema.Number.check(Schema.isFinite()));
const Usage = Schema.Struct({
  input_tokens: NumberField,
  output_tokens: NumberField,
  cache_creation_input_tokens: NumberField,
  cache_read_input_tokens: NumberField,
});
const ToolInput = Schema.Struct({
  skill: Text,
  file_path: Text,
  filePath: Text,
  path: Text,
  command: Text,
  cmd: Text,
});
const ClaudeBlock = Schema.NullOr(
  Schema.Struct({
    type: Text,
    name: Text,
    input: optionalEvidence(ToolInput),
  }),
).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null))));
const decodeClaudeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Text,
      subtype: Text,
      session_id: Text,
      model: Text,
      error: Text,
      usage: optionalEvidence(Usage),
      modelUsage: optionalEvidence(Schema.Record(Schema.String, Schema.Json)),
      total_cost_usd: NumberField,
      duration_ms: NumberField,
      num_turns: NumberField,
      message: optionalEvidence(
        Schema.Struct({
          model: Text,
          usage: optionalEvidence(Usage),
          content: optionalEvidence(Schema.Array(ClaudeBlock)),
        }),
      ),
    }),
  ),
);

const ErrorMessage = Schema.Struct({ message: Schema.String });
const CodexError = Schema.Union([
  ErrorMessage,
  Schema.String.pipe(
    Schema.decodeTo(
      ErrorMessage,
      SchemaTransformation.transform({
        decode: (message) => ({ message }),
        encode: (error) => error.message,
      }),
    ),
  ),
]);
const CodexText = Schema.NullOr(Schema.Struct({ text: Text })).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(null))),
);
const decodeCodexLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Text,
      thread_id: Text,
      message: Text,
      error: optionalEvidence(CodexError),
      item: optionalEvidence(
        Schema.Struct({
          item_type: Text,
          type: Text,
          command: Text,
          // Only numeric zero proves success; retain malformed exit values so
          // they cannot disappear and turn a failed replay into a passing one.
          exit_code: optionalEvidence(Schema.Json),
        }),
      ),
      payload: optionalEvidence(
        Schema.Struct({
          type: Text,
          arguments: Text,
          role: Text,
          text: Text,
          content: optionalEvidence(Schema.Array(CodexText)),
        }),
      ),
    }),
  ),
);

const OpenCodePart = Schema.Struct({
  type: Text,
  tool: Text,
  name: Text,
  text: Text,
  sessionID: Text,
  error: Text,
  message: Text,
  reason: Text,
  state: optionalEvidence(
    Schema.Struct({
      status: Text,
      input: optionalEvidence(ToolInput),
      metadata: optionalEvidence(Schema.Struct({ exit: optionalEvidence(Schema.Json) })),
    }),
  ),
});
const decodeOpenCodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ...OpenCodePart.fields,
      session_id: Text,
      part: optionalEvidence(OpenCodePart),
    }),
  ),
);

export function parseClaudeRuntimeReplayOutput(rawOutput: string): RuntimeReplayObservation {
  const triggeredSkillNames = new Set<string>();
  const readSkillPaths = new Set<string>();
  let sessionId: string | undefined;
  let runtimeError: string | undefined;

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const decoded = decodeClaudeLine(trimmed);
    if (Option.isNone(decoded)) continue;
    const parsed = decoded.value;

    const maybeSessionId = parsed.session_id;
    if (maybeSessionId) {
      sessionId = maybeSessionId;
    }

    if (parsed.error) {
      runtimeError = parsed.error;
    }

    const assistantMessage = parsed.type === "assistant" ? parsed.message : undefined;
    const content = assistantMessage?.content;
    if (!content) continue;

    for (const block of content) {
      if (block?.type !== "tool_use") continue;

      const toolName = block.name;
      const input = block.input;

      if (toolName === "Skill") {
        const skillName = input?.skill;
        if (skillName?.trim()) {
          triggeredSkillNames.add(skillName.trim());
        }
      }

      if (toolName === "Read") {
        const filePath = input?.file_path;
        if (filePath?.trim()) {
          readSkillPaths.add(resolveReplayPath(filePath.trim()));
        }
      }
    }
  }

  const observation: RuntimeReplayObservation = {
    triggeredSkillNames: [...triggeredSkillNames],
    readSkillPaths: [...readSkillPaths],
    rawOutput,
  };
  if (sessionId) observation.sessionId = sessionId;
  if (runtimeError) observation.runtimeError = runtimeError;
  return observation;
}

export function buildKnownSkillNames(input: RuntimeReplayInvokerInput): Set<string> {
  return new Set([
    input.targetSkillName.trim(),
    ...input.competingSkillPaths.map((skillPath) => basename(dirname(skillPath)).trim()),
  ]);
}

function extractReplaySkillPathReferences(text: string): string[] {
  if (!text) return [];

  const matches = new Set<string>();
  const patterns = [
    /(?:^|[\s"'`])((?:\/etc\/codex\/skills\/[^/\s"'`]+|[^"'`\s]*?\.agents\/skills\/[^/\s"'`]+|[^"'`\s]*?\.codex\/skills\/(?:\.system\/)?[^/\s"'`]+|[^"'`\s]*?\.opencode\/skills\/[^/\s"'`]+|[^"'`\s]*?\.claude\/skills\/[^/\s"'`]+)\/SKILL\.md)(?=[\s"'`]|$)/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match !== null) {
      const value = match[1]?.trim();
      if (value) {
        matches.add(value);
      }
      match = pattern.exec(text);
    }
  }

  return [...matches];
}

function normalizeReplayEventType(value: string | undefined): string {
  return value?.replace(/[._]/g, "-").trim().toLowerCase() ?? "";
}

function readString(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeClaudeModel(value: string | null): string | null {
  return value ? value.replace(/\[[^\]]+\]$/, "") : null;
}

export function extractClaudeRuntimeReplayMetrics(line: string): DashboardActionMetrics | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const decoded = decodeClaudeLine(trimmed);
  if (Option.isNone(decoded)) return null;
  const parsed = decoded.value;

  const eventType = readString(parsed.type);
  const sessionId = readString(parsed.session_id);

  if (eventType === "system" && readString(parsed.subtype) === "init") {
    return {
      platform: "claude_code",
      model: normalizeClaudeModel(readString(parsed.model)),
      session_id: sessionId,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      total_cost_usd: null,
      duration_ms: null,
      num_turns: null,
    };
  }

  if (eventType === "assistant") {
    const message = parsed.message;
    const usage = message?.usage;
    return {
      platform: "claude_code",
      model: normalizeClaudeModel(readString(message?.model)),
      session_id: sessionId,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? null,
      total_cost_usd: null,
      duration_ms: null,
      num_turns: null,
    };
  }

  if (eventType === "result") {
    const usage = parsed.usage;
    return {
      platform: "claude_code",
      model: normalizeClaudeModel(Object.keys(parsed.modelUsage ?? {})[0] ?? null),
      session_id: sessionId,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? null,
      total_cost_usd: parsed.total_cost_usd ?? null,
      duration_ms: parsed.duration_ms ?? null,
      num_turns: parsed.num_turns ?? null,
    };
  }

  return null;
}

export function mergeRuntimeReplayDashboardMetrics(
  previous: DashboardActionMetrics | null,
  next: DashboardActionMetrics,
): DashboardActionMetrics {
  if (!previous) return next;

  return {
    platform: next.platform ?? previous.platform,
    model: next.model ?? previous.model,
    session_id: next.session_id ?? previous.session_id,
    input_tokens: next.input_tokens ?? previous.input_tokens,
    output_tokens: next.output_tokens ?? previous.output_tokens,
    cache_creation_input_tokens:
      next.cache_creation_input_tokens ?? previous.cache_creation_input_tokens,
    cache_read_input_tokens: next.cache_read_input_tokens ?? previous.cache_read_input_tokens,
    total_cost_usd: next.total_cost_usd ?? previous.total_cost_usd,
    duration_ms: next.duration_ms ?? previous.duration_ms,
    num_turns: next.num_turns ?? previous.num_turns,
  };
}

export function buildRuntimeReplayEntryMetrics(
  metrics: DashboardActionMetrics | undefined,
  elapsedMs: number,
): RuntimeReplayEntryMetrics {
  return {
    input_tokens: metrics?.input_tokens ?? null,
    output_tokens: metrics?.output_tokens ?? null,
    cache_creation_input_tokens: metrics?.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: metrics?.cache_read_input_tokens ?? null,
    total_cost_usd: metrics?.total_cost_usd ?? null,
    duration_ms: metrics?.duration_ms ?? elapsedMs,
    num_turns: metrics?.num_turns ?? null,
  };
}

export async function readStreamText(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine?: (line: string) => void,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let buffered = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!chunk) continue;
    output += chunk;
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      onLine?.(line);
    }
  }

  const tail = decoder.decode();
  if (tail) {
    output += tail;
    buffered += tail;
  }
  if (buffered) onLine?.(buffered);

  return output;
}

export function parseCodexRuntimeReplayOutput(
  rawOutput: string,
  knownSkillNames: Set<string>,
): RuntimeReplayObservation {
  const triggeredSkillNames = new Set<string>();
  const readSkillPaths = new Set<string>();
  let sessionId: string | undefined;
  let runtimeError: string | undefined;

  const noteSkillPathsAndNames = (text: string | undefined): void => {
    if (!text) return;

    for (const filePath of extractReplaySkillPathReferences(text)) {
      readSkillPaths.add(filePath);
    }

    for (const skillName of extractSkillNamesFromPathReferences(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };

  const noteExplicitMentions = (text: string | undefined): void => {
    if (!text) return;
    for (const skillName of extractExplicitSkillMentions(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const decoded = decodeCodexLine(trimmed);
    if (Option.isNone(decoded)) continue;
    const parsed = decoded.value;

    const eventType = normalizeReplayEventType(parsed.type);
    const threadId = parsed.thread_id;
    if (threadId) sessionId = threadId;

    if (parsed.error?.message) {
      runtimeError = parsed.error.message;
    } else if (eventType === "error" && parsed.message) {
      runtimeError = parsed.message;
    }

    if (
      eventType === "item-completed" ||
      eventType === "item-started" ||
      eventType === "item-updated"
    ) {
      const item = parsed.item;
      const itemType = normalizeReplayEventType(item?.item_type ?? item?.type);

      if (itemType === "command-execution") {
        noteSkillPathsAndNames(item?.command);
        if (item?.exit_code !== undefined && item.exit_code !== 0 && !runtimeError) {
          runtimeError = `command execution exited with code ${String(item.exit_code)}`;
        }
      }
    }

    if (eventType === "response-item") {
      const payload = parsed.payload;
      const payloadType = normalizeReplayEventType(payload?.type);

      if (payloadType === "function-call") {
        noteSkillPathsAndNames(payload?.arguments);
      } else if (payloadType === "message") {
        const role = payload?.role;
        const content = payload?.content ?? [];
        for (const part of content) {
          const text = part?.text;
          noteSkillPathsAndNames(text);
          if (role === "user") noteExplicitMentions(text);
        }
      } else if (payloadType === "agent-reasoning") {
        noteSkillPathsAndNames(payload?.text);
      }
    }
  }

  const observation: RuntimeReplayObservation = {
    triggeredSkillNames: [...triggeredSkillNames],
    readSkillPaths: [...readSkillPaths],
    rawOutput,
  };
  if (sessionId) observation.sessionId = sessionId;
  if (runtimeError) observation.runtimeError = runtimeError;
  return observation;
}

export function parseOpenCodeRuntimeReplayOutput(
  rawOutput: string,
  knownSkillNames: Set<string>,
): RuntimeReplayObservation {
  const triggeredSkillNames = new Set<string>();
  const readSkillPaths = new Set<string>();
  let sessionId: string | undefined;
  let runtimeError: string | undefined;

  const noteSkillPathsAndNames = (text: string | undefined): void => {
    if (!text) return;
    for (const filePath of extractReplaySkillPathReferences(text)) readSkillPaths.add(filePath);
    for (const skillName of extractSkillNamesFromPathReferences(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };
  const noteExplicitMentions = (text: string | undefined): void => {
    if (!text) return;
    for (const skillName of extractExplicitSkillMentions(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const decoded = decodeOpenCodeLine(trimmed);
    if (Option.isNone(decoded)) continue;
    const parsed = decoded.value;

    const nestedPart = parsed.part;
    const eventType = normalizeReplayEventType(nestedPart?.type ?? parsed.type);
    const payload =
      nestedPart &&
      (nestedPart.tool !== undefined || nestedPart.state !== undefined || nestedPart.text)
        ? nestedPart
        : parsed;

    const possibleSessionId = parsed.sessionID ?? parsed.session_id ?? payload.sessionID;
    if (possibleSessionId) sessionId = possibleSessionId;

    if (parsed.error) {
      runtimeError = parsed.error;
    } else if (payload.error) {
      runtimeError = payload.error;
    }

    if (eventType === "tool") {
      const toolName = normalizeReplayEventType(payload.tool ?? payload.name);
      const state = payload.state;
      const input = state?.input;
      const status = normalizeReplayEventType(state?.status);

      if (toolName === "read" || toolName === "read-file") {
        const filePath = input?.filePath ?? input?.file_path ?? input?.path;
        if (filePath && basename(filePath).toUpperCase() === "SKILL.MD") {
          readSkillPaths.add(filePath);
          triggeredSkillNames.add(basename(dirname(filePath)));
        }
      } else if (toolName === "bash" || toolName === "execute-bash") {
        noteSkillPathsAndNames(input?.command ?? input?.cmd);
      }

      const exitCode = state?.metadata?.exit;
      if (status === "completed" && exitCode !== undefined && exitCode !== 0 && !runtimeError) {
        runtimeError = `tool exited with code ${String(exitCode)}`;
      }
    } else if (eventType === "text" || eventType === "reasoning") {
      noteSkillPathsAndNames(payload.text);
      noteExplicitMentions(payload.text);
    } else if (eventType === "error" && payload.message) {
      runtimeError = payload.message;
    } else if (eventType === "step-finish") {
      const reason = payload.reason;
      if (reason?.toLowerCase() === "error" && !runtimeError) {
        runtimeError = "step finished with error";
      }
    }
  }

  const observation: RuntimeReplayObservation = {
    triggeredSkillNames: [...triggeredSkillNames],
    readSkillPaths: [...readSkillPaths],
    rawOutput,
  };
  if (sessionId) observation.sessionId = sessionId;
  if (runtimeError) observation.runtimeError = runtimeError;
  return observation;
}
