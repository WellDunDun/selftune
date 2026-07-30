import { basename, dirname } from "node:path";

import type { DashboardActionMetrics } from "../../dashboard-contract.js";
import type { RuntimeReplayEntryMetrics } from "../../types.js";
import {
  extractExplicitSkillMentions,
  extractSkillNamesFromPathReferences,
} from "../../utils/skill-discovery.js";
import type { RuntimeReplayInvokerInput, RuntimeReplayObservation } from "./contracts.js";
import { resolveReplayPath } from "./workspace.js";

export function parseClaudeRuntimeReplayOutput(rawOutput: string): RuntimeReplayObservation {
  const triggeredSkillNames = new Set<string>();
  const readSkillPaths = new Set<string>();
  let sessionId: string | undefined;
  let runtimeError: string | undefined;

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const maybeSessionId = parsed.session_id;
    if (typeof maybeSessionId === "string" && maybeSessionId) {
      sessionId = maybeSessionId;
    }

    if (typeof parsed.error === "string" && parsed.error) {
      runtimeError = parsed.error;
    }

    const assistantMessage =
      parsed.type === "assistant" && typeof parsed.message === "object" && parsed.message !== null
        ? (parsed.message as Record<string, unknown>)
        : undefined;
    const content = assistantMessage?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type !== "tool_use") continue;

      const toolName = typedBlock.name;
      const input =
        typeof typedBlock.input === "object" && typedBlock.input !== null
          ? (typedBlock.input as Record<string, unknown>)
          : {};

      if (toolName === "Skill") {
        const skillName = input.skill;
        if (typeof skillName === "string" && skillName.trim()) {
          triggeredSkillNames.add(skillName.trim());
        }
      }

      if (toolName === "Read") {
        const filePath = input.file_path;
        if (typeof filePath === "string" && filePath.trim()) {
          readSkillPaths.add(resolveReplayPath(filePath.trim()));
        }
      }
    }
  }

  return {
    triggeredSkillNames: [...triggeredSkillNames],
    readSkillPaths: [...readSkillPaths],
    rawOutput,
    ...(sessionId ? { sessionId } : {}),
    ...(runtimeError ? { runtimeError } : {}),
  };
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

function normalizeReplayEventType(value: unknown): string {
  return typeof value === "string" ? value.replace(/[._]/g, "-").trim().toLowerCase() : "";
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeClaudeModel(value: string | null): string | null {
  return value ? value.replace(/\[[^\]]+\]$/, "") : null;
}

function firstModelUsageKey(value: unknown): string | null {
  const modelUsage = readObject(value);
  if (!modelUsage) return null;
  const firstKey = Object.keys(modelUsage)[0];
  return normalizeClaudeModel(firstKey ?? null);
}

export function extractClaudeRuntimeReplayMetrics(line: string): DashboardActionMetrics | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

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
    const message = readObject(parsed.message);
    const usage = readObject(message?.usage);
    return {
      platform: "claude_code",
      model: normalizeClaudeModel(readString(message?.model)),
      session_id: sessionId,
      input_tokens: readNumber(usage?.input_tokens),
      output_tokens: readNumber(usage?.output_tokens),
      cache_creation_input_tokens: readNumber(usage?.cache_creation_input_tokens),
      cache_read_input_tokens: readNumber(usage?.cache_read_input_tokens),
      total_cost_usd: null,
      duration_ms: null,
      num_turns: null,
    };
  }

  if (eventType === "result") {
    const usage = readObject(parsed.usage);
    return {
      platform: "claude_code",
      model: firstModelUsageKey(parsed.modelUsage),
      session_id: sessionId,
      input_tokens: readNumber(usage?.input_tokens),
      output_tokens: readNumber(usage?.output_tokens),
      cache_creation_input_tokens: readNumber(usage?.cache_creation_input_tokens),
      cache_read_input_tokens: readNumber(usage?.cache_read_input_tokens),
      total_cost_usd: readNumber(parsed.total_cost_usd),
      duration_ms: readNumber(parsed.duration_ms),
      num_turns: readNumber(parsed.num_turns),
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

  const noteSkillPathsAndNames = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;

    for (const filePath of extractReplaySkillPathReferences(text)) {
      readSkillPaths.add(filePath);
    }

    for (const skillName of extractSkillNamesFromPathReferences(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };

  const noteExplicitMentions = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
    for (const skillName of extractExplicitSkillMentions(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const eventType = normalizeReplayEventType(parsed.type);
    const threadId = parsed.thread_id;
    if (typeof threadId === "string" && threadId) sessionId = threadId;

    if (typeof parsed.error === "string" && parsed.error) {
      runtimeError = parsed.error;
    } else if (eventType === "turn-failed") {
      const error = parsed.error;
      if (typeof error === "object" && error !== null) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") runtimeError = message;
      }
    } else if (eventType === "error" && typeof parsed.message === "string" && parsed.message) {
      runtimeError = parsed.message;
    }

    if (
      eventType === "item-completed" ||
      eventType === "item-started" ||
      eventType === "item-updated"
    ) {
      const item =
        typeof parsed.item === "object" && parsed.item !== null
          ? (parsed.item as Record<string, unknown>)
          : undefined;
      const itemType = normalizeReplayEventType(item?.item_type ?? item?.type);

      if (itemType === "command-execution") {
        noteSkillPathsAndNames(item?.command);
        if (item?.exit_code !== undefined && item.exit_code !== 0 && !runtimeError) {
          runtimeError = `command execution exited with code ${String(item.exit_code)}`;
        }
      }
    }

    if (eventType === "response-item") {
      const payload =
        typeof parsed.payload === "object" && parsed.payload !== null
          ? (parsed.payload as Record<string, unknown>)
          : undefined;
      const payloadType = normalizeReplayEventType(payload?.type);

      if (payloadType === "function-call") {
        noteSkillPathsAndNames(payload?.arguments);
      } else if (payloadType === "message") {
        const role = payload?.role;
        const content = Array.isArray(payload?.content)
          ? (payload.content as Array<Record<string, unknown>>)
          : [];
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

  return {
    triggeredSkillNames: [...triggeredSkillNames],
    readSkillPaths: [...readSkillPaths],
    rawOutput,
    ...(sessionId ? { sessionId } : {}),
    ...(runtimeError ? { runtimeError } : {}),
  };
}

export function parseOpenCodeRuntimeReplayOutput(
  rawOutput: string,
  knownSkillNames: Set<string>,
): RuntimeReplayObservation {
  const triggeredSkillNames = new Set<string>();
  const readSkillPaths = new Set<string>();
  let sessionId: string | undefined;
  let runtimeError: string | undefined;

  const noteSkillPathsAndNames = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
    for (const filePath of extractReplaySkillPathReferences(text)) readSkillPaths.add(filePath);
    for (const skillName of extractSkillNamesFromPathReferences(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };
  const noteExplicitMentions = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
    for (const skillName of extractExplicitSkillMentions(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const nestedPart =
      typeof parsed.part === "object" && parsed.part !== null
        ? (parsed.part as Record<string, unknown>)
        : undefined;
    const eventType = normalizeReplayEventType(nestedPart?.type ?? parsed.type);
    const payload =
      nestedPart &&
      (nestedPart.tool !== undefined || nestedPart.state !== undefined || nestedPart.text)
        ? nestedPart
        : parsed;

    const possibleSessionId = parsed.sessionID ?? parsed.session_id ?? payload.sessionID;
    if (typeof possibleSessionId === "string" && possibleSessionId) sessionId = possibleSessionId;

    if (typeof parsed.error === "string" && parsed.error) {
      runtimeError = parsed.error;
    } else if (typeof payload.error === "string" && payload.error) {
      runtimeError = payload.error;
    }

    if (eventType === "tool") {
      const toolName = normalizeReplayEventType(payload.tool ?? payload.name);
      const state =
        typeof payload.state === "object" && payload.state !== null
          ? (payload.state as Record<string, unknown>)
          : {};
      const input =
        typeof state.input === "object" && state.input !== null
          ? (state.input as Record<string, unknown>)
          : {};
      const status = normalizeReplayEventType(state.status);

      if (toolName === "read" || toolName === "read-file") {
        const filePath = input.filePath ?? input.file_path ?? input.path;
        if (typeof filePath === "string" && basename(filePath).toUpperCase() === "SKILL.MD") {
          readSkillPaths.add(filePath);
          triggeredSkillNames.add(basename(dirname(filePath)));
        }
      } else if (toolName === "bash" || toolName === "execute-bash") {
        noteSkillPathsAndNames(input.command ?? input.cmd);
      }

      const metadata =
        typeof state.metadata === "object" && state.metadata !== null
          ? (state.metadata as Record<string, unknown>)
          : {};
      const exitCode = metadata.exit;
      if (status === "completed" && exitCode !== undefined && exitCode !== 0 && !runtimeError) {
        runtimeError = `tool exited with code ${String(exitCode)}`;
      }
    } else if (eventType === "text" || eventType === "reasoning") {
      noteSkillPathsAndNames(payload.text);
      noteExplicitMentions(payload.text);
    } else if (eventType === "error" && typeof payload.message === "string" && payload.message) {
      runtimeError = payload.message;
    } else if (eventType === "step-finish") {
      const reason = payload.reason;
      if (typeof reason === "string" && reason.toLowerCase() === "error" && !runtimeError) {
        runtimeError = "step finished with error";
      }
    }
  }

  return {
    triggeredSkillNames: [...triggeredSkillNames],
    readSkillPaths: [...readSkillPaths],
    rawOutput,
    ...(sessionId ? { sessionId } : {}),
    ...(runtimeError ? { runtimeError } : {}),
  };
}
