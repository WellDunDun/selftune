#!/usr/bin/env bun
/**
 * Cline hook adapter for selftune.
 *
 * Translates Cline hook events (PostToolUse, TaskComplete, TaskCancel)
 * into selftune hook calls for commit tracking and session telemetry.
 *
 * Protocol: reads JSON from stdin, routes to the appropriate handler,
 * and writes `{"cancel": false}` to stdout.
 *
 * Fail-open: never crashes, never blocks Cline. All errors are silent.
 *
 * Usage: echo '$HOOK_PAYLOAD' | selftune cline hook
 */

import type { StopPayload } from "@selftune/runtime/types";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Cline hook input shape
// ---------------------------------------------------------------------------

const ClineHookInput = Schema.Struct({
  hookName: Schema.String,
  taskId: Schema.String,
  workspaceRoots: Schema.optionalKey(Schema.Array(Schema.String)),
  postToolUse: Schema.optionalKey(
    Schema.Struct({
      toolName: Schema.String,
      parameters: Schema.Struct({ command: Schema.optionalKey(Schema.String) }),
      result: Schema.optionalKey(Schema.String),
    }),
  ),
});
type ClineHookInput = typeof ClineHookInput.Type;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outputResponse(): void {
  process.stdout.write(JSON.stringify({ cancel: false }));
}

async function readStdin(): Promise<{ full: string }> {
  const raw = await Bun.stdin.text();
  return { full: raw };
}

// ---------------------------------------------------------------------------
// PostToolUse handler — commit tracking (inline, fast path)
// ---------------------------------------------------------------------------

async function handlePostToolUse(input: ClineHookInput): Promise<void> {
  const { postToolUse, taskId } = input;
  if (!postToolUse) return;

  const { toolName, parameters, result } = postToolUse;

  // Only care about execute_command that might be git commits
  if (toolName !== "execute_command") return;

  const command = parameters.command ?? "";
  if (!command) return;

  // Use selftune's commit-track logic
  const { containsGitCommitCommand, parseCommitSha, parseCommitTitle, parseBranchFromOutput } =
    await import("@selftune/harness-claude-code/hooks/commit-track");

  if (!containsGitCommitCommand(command)) return;
  if (!result) return;

  const commitSha = parseCommitSha(result);
  if (!commitSha) return;

  const commitTitle = parseCommitTitle(result);
  const branch = parseBranchFromOutput(result);

  // Write to SQLite
  try {
    const { writeCommitTracking } = await import("@selftune/runtime/localdb/direct-write");
    writeCommitTracking({
      session_id: taskId,
      commit_sha: commitSha,
      commit_title: commitTitle,
      branch,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* fail-open */
  }
}

// ---------------------------------------------------------------------------
// TaskComplete / TaskCancel handler — session telemetry (background)
// ---------------------------------------------------------------------------

async function handleTaskEnd(input: ClineHookInput): Promise<void> {
  const { taskId, workspaceRoots } = input;
  const cwd = workspaceRoots?.[0] ?? process.cwd();

  // Build a StopPayload compatible with selftune's session-stop processor
  const payload: StopPayload = {
    session_id: taskId,
    cwd,
    // Cline doesn't provide a transcript path in the same way Claude Code does.
    // session-stop will still record session-level telemetry from what's available.
    transcript_path: "",
  };

  try {
    const { processSessionStop } = await import("@selftune/harness-claude-code/hooks/session-stop");
    await processSessionStop(payload);
  } catch {
    /* fail-open */
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  try {
    const { full } = await readStdin();

    if (!full.trim()) {
      outputResponse();
      return;
    }

    let input: ClineHookInput;
    try {
      input = Schema.decodeUnknownSync(Schema.fromJsonString(ClineHookInput))(full);
    } catch {
      outputResponse();
      return;
    }

    const { hookName } = input;
    if (!hookName) {
      outputResponse();
      return;
    }

    if (hookName === "PostToolUse") {
      await handlePostToolUse(input);
    } else if (hookName === "TaskComplete" || hookName === "TaskCancel") {
      await handleTaskEnd(input);
    }
    // Unknown events are silently ignored (fail-open)

    outputResponse();
  } catch {
    // Fail-open: always output a valid response
    outputResponse();
  }
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  await cliMain();
  process.exit(0);
}
