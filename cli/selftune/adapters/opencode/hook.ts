#!/usr/bin/env bun
/**
 * OpenCode hook adapter for selftune.
 *
 * Translates OpenCode hook events to selftune's shared hook logic.
 * OpenCode pipes JSON on stdin; this adapter normalizes field names,
 * dispatches to the appropriate selftune handler, and writes an
 * OpenCode-format JSON response to stdout.
 *
 * Event mapping:
 *   tool.execute.before  -> PreToolUse handlers (skill-change-guard, evolution-guard)
 *   tool.execute.after   -> PostToolUse handlers (skill-eval, commit-track)
 *   session.idle         -> session-stop handler
 *
 * Fail-open: never crashes, always outputs valid JSON, exits 0 on errors.
 *
 * Usage: echo '$HOOK_PAYLOAD' | selftune opencode hook
 */

import type { PostToolUsePayload, PreToolUsePayload, StopPayload } from "../../types.js";

// ---------------------------------------------------------------------------
// OpenCode input / output types
// ---------------------------------------------------------------------------

interface OpenCodeHookInput {
  event: "tool.execute.before" | "tool.execute.after" | "session.idle";
  session_id: string;
  tool?: {
    name?: string;
    args?: Record<string, unknown>;
    result?: Record<string, unknown>;
  };
  cwd?: string;
}

interface OpenCodeHookResponse {
  modified: boolean;
  args?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function outputResponse(response: OpenCodeHookResponse): void {
  process.stdout.write(JSON.stringify(response));
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  let eventName: string | undefined;

  try {
    const raw = await Bun.stdin.text();

    if (!raw.trim()) {
      outputResponse({ modified: false });
      return;
    }

    // Fast-path: for tool.execute.before, skip full parse if not interesting
    const preview = raw.slice(0, 8192);
    const isBefore = preview.includes("tool.execute.before");
    if (isBefore) {
      // Only parse fully if it might be a git commit or SKILL.md write
      const mightBeInteresting =
        (preview.includes("git") && preview.includes("commit")) ||
        preview.includes("SKILL.md") ||
        preview.includes("skill.md");
      if (!mightBeInteresting) {
        outputResponse({ modified: false });
        return;
      }
    }

    let input: OpenCodeHookInput;
    try {
      input = JSON.parse(raw) as OpenCodeHookInput;
    } catch {
      outputResponse({ modified: false });
      return;
    }

    eventName = input.event;
    if (!eventName) {
      outputResponse({ modified: false });
      return;
    }

    switch (eventName) {
      case "tool.execute.before":
        await handleToolBefore(input);
        outputResponse({ modified: false });
        break;
      case "tool.execute.after":
        await handleToolAfter(input);
        outputResponse({ modified: false });
        break;
      case "session.idle":
        await handleSessionIdle(input);
        outputResponse({ modified: false });
        break;
      default:
        outputResponse({ modified: false });
    }
  } catch {
    // Fail-open: never crash, always return valid JSON
    outputResponse({ modified: false });
  }
}

// ---------------------------------------------------------------------------
// tool.execute.before -> PreToolUse handlers
// ---------------------------------------------------------------------------

async function handleToolBefore(input: OpenCodeHookInput): Promise<void> {
  const toolName = input.tool?.name ?? "";
  const toolInput = input.tool?.args ?? {};

  const payload: PreToolUsePayload = {
    session_id: input.session_id,
    cwd: input.cwd,
    tool_name: toolName,
    tool_input: toolInput,
  };

  // Run skill-change-guard (advisory suggestion for SKILL.md writes)
  try {
    const { processPreToolUse } = await import("../../hooks/skill-change-guard.js");
    const { SESSION_STATE_DIR } = await import("../../constants.js");
    const safe = (input.session_id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
    const statePath = `${SESSION_STATE_DIR}/guard-state-${safe}.json`;
    const suggestion = processPreToolUse(payload, statePath);
    if (suggestion) {
      process.stderr.write(`[selftune] ${suggestion}\n`);
    }
  } catch {
    /* fail-open */
  }

  // Run evolution-guard (may block SKILL.md writes on monitored skills)
  try {
    const { processEvolutionGuard } = await import("../../hooks/evolution-guard.js");
    const { EVOLUTION_AUDIT_LOG, SELFTUNE_CONFIG_DIR } = await import("../../constants.js");
    const result = await processEvolutionGuard(payload, {
      auditLogPath: EVOLUTION_AUDIT_LOG,
      selftuneDir: SELFTUNE_CONFIG_DIR,
    });
    if (result) {
      // OpenCode does not support exit-code blocking like Claude Code.
      // Emit the warning to stderr for agent visibility.
      process.stderr.write(`${result.message}\n`);
    }
  } catch {
    /* fail-open */
  }
}

// ---------------------------------------------------------------------------
// tool.execute.after -> PostToolUse handlers
// ---------------------------------------------------------------------------

async function handleToolAfter(input: OpenCodeHookInput): Promise<void> {
  const toolName = input.tool?.name ?? "";
  const toolInput = input.tool?.args ?? {};
  const toolResult = input.tool?.result ?? {};

  const payload: PostToolUsePayload = {
    session_id: input.session_id,
    cwd: input.cwd,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResult,
  };

  // Run skill-eval (skill usage tracking)
  try {
    const { processToolUse } = await import("../../hooks/skill-eval.js");
    await processToolUse(payload);
  } catch {
    /* fail-open */
  }

  // Run commit-track (git commit traceability)
  try {
    const { processCommitTrack } = await import("../../hooks/commit-track.js");
    await processCommitTrack(payload);
  } catch {
    /* fail-open */
  }
}

// ---------------------------------------------------------------------------
// session.idle -> session-stop handler
// ---------------------------------------------------------------------------

async function handleSessionIdle(input: OpenCodeHookInput): Promise<void> {
  const payload: StopPayload = {
    session_id: input.session_id,
    cwd: input.cwd,
  };

  try {
    const { processSessionStop } = await import("../../hooks/session-stop.js");
    await processSessionStop(payload);
  } catch {
    /* fail-open */
  }
}

// ---------------------------------------------------------------------------
// stdin main (only when executed directly, not when imported)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await cliMain();
  process.exit(0);
}
