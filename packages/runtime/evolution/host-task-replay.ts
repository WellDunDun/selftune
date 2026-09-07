import type { RoutingReplayFixture } from "../types.js";
import { Effect, Option, Schema } from "effect";
import { optionalEvidence } from "../utils/transcript-contract.js";

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

const ContentPart = Schema.NullOr(Schema.Struct({ text: optionalEvidence(Schema.String) })).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(null))),
);
const Content = Schema.Array(ContentPart);
const TokenCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const ReplayEvent = Schema.Struct({
  type: optionalEvidence(Schema.String),
  thread_id: optionalEvidence(Schema.String),
  item: optionalEvidence(
    Schema.Struct({
      type: optionalEvidence(Schema.String),
      item_type: optionalEvidence(Schema.String),
      text: optionalEvidence(Schema.String),
      content: optionalEvidence(Content),
    }),
  ),
  payload: optionalEvidence(
    Schema.Struct({
      type: optionalEvidence(Schema.String),
      role: optionalEvidence(Schema.String),
      content: optionalEvidence(Content),
    }),
  ),
  usage: optionalEvidence(
    Schema.Struct({
      input_tokens: optionalEvidence(TokenCount),
      output_tokens: optionalEvidence(TokenCount),
    }),
  ),
  error: optionalEvidence(
    Schema.Union([Schema.String, Schema.Struct({ message: optionalEvidence(Schema.String) })]),
  ),
});
const decodeReplayLine = Schema.decodeUnknownOption(Schema.fromJsonString(ReplayEvent));
const isErrorText = Schema.is(Schema.String);

function normalizedType(value: string | undefined): string {
  return value?.replace(/[._]/g, "-").toLowerCase() ?? "";
}

function textParts(value: typeof Content.Type | undefined): string[] {
  return (value ?? []).flatMap((part) => {
    const text = part?.text?.trim();
    return text ? [text] : [];
  });
}

export function parseCodexTaskReplayOutput(rawOutput: string) {
  const messages: string[] = [];
  let sessionId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let runtimeError: string | null = null;
  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const decoded = decodeReplayLine(trimmed);
    if (Option.isNone(decoded)) continue;
    const event = decoded.value;
    if (event.thread_id !== undefined) sessionId = event.thread_id;
    const eventType = normalizedType(event.type);
    const item = event.item;
    const itemType = normalizedType(item?.type ?? item?.item_type);
    if (eventType === "item-completed" && itemType === "agent-message") {
      if (item?.text?.trim()) messages.push(item.text.trim());
      messages.push(...textParts(item?.content));
    }
    if (eventType === "response-item") {
      const payload = event.payload;
      if (normalizedType(payload?.type) === "message" && payload?.role === "assistant") {
        messages.push(...textParts(payload.content));
      }
    }
    const usage = event.usage;
    if (usage) {
      if (usage.input_tokens !== undefined) inputTokens = usage.input_tokens;
      if (usage.output_tokens !== undefined) outputTokens = usage.output_tokens;
    }
    if (isErrorText(event.error)) runtimeError = event.error;
    else if (eventType === "turn-failed" && event.error?.message !== undefined)
      runtimeError = event.error.message;
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
