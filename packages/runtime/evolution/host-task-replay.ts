import type { RoutingReplayFixture } from "../types.js";

import type {
  RuntimeReplayContentTarget,
  RuntimeReplayReasoningEffort,
} from "./validate-host-replay/contracts.js";
import {
  buildRuntimeReplayWorkspace,
  cleanupRuntimeReplayWorkspace,
} from "./validate-host-replay/workspace.js";

export const HOST_TASK_REPLAY_TIMEOUT_MS = 300_000;
export const HOST_TASK_REPLAY_TERMINATION_GRACE_MS = 2_000;

export interface CodexTaskReplayProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly kill: (signal?: number) => void;
}

export interface CollectCodexTaskReplayProcessOptions {
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
}

export interface HostTaskReplayResult {
  readonly output: string;
  readonly raw_output: string;
  readonly session_id: string | null;
  readonly duration_ms: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
}

export interface HostTaskReplayOptions {
  readonly task: string;
  readonly body: string;
  readonly fixture: RoutingReplayFixture;
  readonly contentTarget?: RuntimeReplayContentTarget;
  readonly includeTargetSkill: boolean;
  readonly model: string;
  readonly reasoningEffort: RuntimeReplayReasoningEffort;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Collects a replay without trusting child streams to close after process exit.
 * Some Codex helpers inherit the pipes; timeout rejection must therefore be
 * independent of stdout/stderr completion.
 */
export async function collectCodexTaskReplayProcess(
  child: CodexTaskReplayProcess,
  options: CollectCodexTaskReplayProcessOptions = {},
): Promise<readonly [stdout: string, stderr: string, exitCode: number]> {
  const timeoutMs = options.timeoutMs ?? HOST_TASK_REPLAY_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? HOST_TASK_REPLAY_TERMINATION_GRACE_MS;
  let exited = false;
  const exitCode = child.exited.then((code) => {
    exited = true;
    return code;
  });
  const collected = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    exitCode,
  ]);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      void (async () => {
        try {
          child.kill(15);
        } catch {
          // The process may have exited while an inherited stream stayed open.
        }
        await Promise.race([exitCode.then(() => undefined), delay(terminationGraceMs)]);
        if (!exited) {
          try {
            child.kill(9);
          } catch {
            // A concurrent exit already satisfied the termination contract.
          }
        }
        reject(new Error(`Codex task replay timed out after ${timeoutMs}ms.`));
      })();
    }, timeoutMs);
  });
  try {
    return await Promise.race([collected, timeoutFailure]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizedType(value: unknown): string {
  return typeof value === "string" ? value.replace(/[._]/g, "-").toLowerCase() : "";
}

function textParts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    const item = record(part);
    const text = item?.text;
    return typeof text === "string" && text.trim() ? [text.trim()] : [];
  });
}

export function parseCodexTaskReplayOutput(rawOutput: string): {
  output: string;
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  runtimeError: string | null;
} {
  const messages: string[] = [];
  let sessionId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let runtimeError: string | null = null;
  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof event.thread_id === "string") sessionId = event.thread_id;
    const eventType = normalizedType(event.type);
    const item = record(event.item);
    const itemType = normalizedType(item?.type ?? item?.item_type);
    if (eventType === "item-completed" && itemType === "agent-message") {
      if (typeof item?.text === "string" && item.text.trim()) messages.push(item.text.trim());
      messages.push(...textParts(item?.content));
    }
    if (eventType === "response-item") {
      const payload = record(event.payload);
      if (normalizedType(payload?.type) === "message" && payload?.role === "assistant") {
        messages.push(...textParts(payload.content));
      }
    }
    const usage = record(event.usage);
    if (usage) {
      if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
    }
    if (typeof event.error === "string") runtimeError = event.error;
    if (eventType === "turn-failed") {
      const error = record(event.error);
      if (typeof error?.message === "string") runtimeError = error.message;
    }
  }
  return {
    output: messages.at(-1) ?? "",
    sessionId,
    inputTokens,
    outputTokens,
    runtimeError,
  };
}

/** Executes one bounded task with a staged skill arm; external mutation is forbidden. */
export async function runCodexHostTaskReplay(
  options: HostTaskReplayOptions,
): Promise<HostTaskReplayResult> {
  if (options.fixture.platform !== "codex") {
    throw new Error(
      `Codex task replay requires a codex fixture, received ${options.fixture.platform}.`,
    );
  }
  const workspace = buildRuntimeReplayWorkspace(
    options.fixture,
    options.body,
    options.contentTarget ?? "body",
    options.includeTargetSkill,
  );
  const prompt = [
    "Run an isolated execution-quality replay for the user request below.",
    "Use a relevant local project skill if one is available.",
    "Do not access a network, issue tracker, browser, or any path outside this temporary workspace.",
    "Do not create, modify, or publish anything. Do not claim an external action succeeded.",
    "Return only the user-facing draft response that should appear immediately before any external publishing action.",
    `User request: ${options.task}`,
  ].join("\n\n");
  const startedAt = Date.now();
  try {
    const child = Bun.spawn(
      [
        "codex",
        "exec",
        "--model",
        options.model,
        "--config",
        `model_reasoning_effort="${options.reasoningEffort}"`,
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-C",
        workspace.rootDir,
        prompt,
      ],
      {
        cwd: workspace.rootDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...globalThis.process.env, CLAUDECODE: "" },
      },
    );
    const [stdout, stderr, exitCode] = await collectCodexTaskReplayProcess(child);
    const parsed = parseCodexTaskReplayOutput(stdout);
    const error = [parsed.runtimeError, stderr.trim()].filter(Boolean).join(" | ");
    if (exitCode !== 0 || !parsed.output) {
      throw new Error(error || `Codex task replay exited with code ${exitCode}.`);
    }
    return {
      output: parsed.output,
      raw_output: stdout,
      session_id: parsed.sessionId,
      duration_ms: Date.now() - startedAt,
      input_tokens: parsed.inputTokens,
      output_tokens: parsed.outputTokens,
    };
  } finally {
    cleanupRuntimeReplayWorkspace(workspace);
  }
}
