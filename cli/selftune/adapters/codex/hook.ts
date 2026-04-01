#!/usr/bin/env bun
/**
 * Codex hook adapter for selftune.
 *
 * Reads Codex hook payloads from stdin and delegates to shared selftune hook logic.
 * Codex uses the same hook protocol as Claude Code (JSON on stdin, JSON on stdout),
 * so the payloads are structurally identical.
 *
 * Usage: echo '$HOOK_PAYLOAD' | selftune codex hook
 *
 * Event routing:
 *   SessionStart  -> prompt-log (processPrompt) + auto-activate (processAutoActivate)
 *   PreToolUse    -> skill-change-guard + evolution-guard
 *   PostToolUse   -> skill-eval (processToolUse) + commit-track (processCommitTrack)
 *   Stop          -> session-stop (processSessionStop)
 *
 * Exit codes:
 *   0 = success / allow
 *   2 = block (PreToolUse guard rejection, Claude Code convention)
 *
 * Fail-open: any unhandled error -> exit 0, never crash the host agent.
 */

import type {
  PostToolUsePayload,
  PreToolUsePayload,
  PromptSubmitPayload,
  StopPayload,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Codex hook payload — superset of all event fields. */
export interface CodexHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: Record<string, unknown>;
  prompt?: string;
  user_prompt?: string;
  permission_mode?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  [key: string]: unknown;
}

/** Response written to stdout. Empty object = no-op. */
type HookResponse = Record<string, unknown>;

const EMPTY_RESPONSE: HookResponse = {};

// ---------------------------------------------------------------------------
// Event handlers (dynamic imports for fast startup)
// ---------------------------------------------------------------------------

async function handleSessionStart(payload: CodexHookPayload): Promise<HookResponse> {
  // 1. Prompt logging
  try {
    const { processPrompt } = await import("../../hooks/prompt-log.js");
    const promptPayload: PromptSubmitPayload = {
      session_id: payload.session_id,
      transcript_path: payload.transcript_path,
      cwd: payload.cwd,
      prompt: payload.prompt,
      user_prompt: payload.user_prompt,
      hook_event_name: "UserPromptSubmit",
    };
    await processPrompt(promptPayload);
  } catch {
    // fail-open
  }

  // 2. Auto-activate suggestions
  let response: HookResponse = EMPTY_RESPONSE;
  try {
    const { processAutoActivate } = await import("../../hooks/auto-activate.js");
    const sessionId = payload.session_id ?? "unknown";
    const suggestions = await processAutoActivate(sessionId);
    if (suggestions.length > 0) {
      const context = suggestions.map((s) => `[selftune] Suggestion: ${s}`).join("\n");
      // Codex supports hookSpecificOutput.additionalContext like Claude Code
      response = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context,
        },
      };
    }
  } catch {
    // fail-open
  }

  return response;
}

async function handlePreToolUse(
  payload: CodexHookPayload,
): Promise<{ response: HookResponse; exitCode: number }> {
  const prePayload: PreToolUsePayload = {
    tool_name: payload.tool_name ?? "",
    tool_input: payload.tool_input ?? {},
    tool_use_id: payload.tool_use_id,
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    hook_event_name: "PreToolUse",
  };

  // Import constants once for both guards
  let constants:
    | { EVOLUTION_AUDIT_LOG: string; SELFTUNE_CONFIG_DIR: string; SESSION_STATE_DIR: string }
    | undefined;
  try {
    constants = await import("../../constants.js");
  } catch {
    // fail-open
  }

  // 1. Evolution guard (can block with exit 2)
  try {
    if (constants) {
      const { processEvolutionGuard } = await import("../../hooks/evolution-guard.js");
      const guardResult = await processEvolutionGuard(prePayload, {
        auditLogPath: constants.EVOLUTION_AUDIT_LOG,
        selftuneDir: constants.SELFTUNE_CONFIG_DIR,
      });
      if (guardResult) {
        process.stderr.write(`${guardResult.message}\n`);
        return { response: EMPTY_RESPONSE, exitCode: guardResult.exitCode };
      }
    }
  } catch {
    // fail-open
  }

  // 2. Skill change guard (advisory only, never blocks)
  try {
    if (constants) {
      const { processPreToolUse } = await import("../../hooks/skill-change-guard.js");
      const sessionId = payload.session_id ?? "unknown";
      const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const statePath = `${constants.SESSION_STATE_DIR}/guard-state-${safe}.json`;
      const suggestion = processPreToolUse(prePayload, statePath);
      if (suggestion) {
        process.stderr.write(`[selftune] Suggestion: ${suggestion}\n`);
      }
    }
  } catch {
    // fail-open
  }

  return { response: EMPTY_RESPONSE, exitCode: 0 };
}

async function handlePostToolUse(payload: CodexHookPayload): Promise<HookResponse> {
  const postPayload: PostToolUsePayload = {
    tool_name: payload.tool_name ?? "",
    tool_input: payload.tool_input ?? {},
    tool_use_id: payload.tool_use_id,
    tool_response: payload.tool_response,
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    hook_event_name: "PostToolUse",
  };

  // 1. Skill eval (Read/Skill tool usage tracking)
  try {
    const { processToolUse } = await import("../../hooks/skill-eval.js");
    await processToolUse(postPayload);
  } catch {
    // fail-open
  }

  // 2. Commit tracking (git commit detection in Bash output)
  try {
    const { processCommitTrack } = await import("../../hooks/commit-track.js");
    await processCommitTrack(postPayload);
  } catch {
    // fail-open
  }

  return EMPTY_RESPONSE;
}

async function handleStop(payload: CodexHookPayload): Promise<HookResponse> {
  try {
    const { processSessionStop } = await import("../../hooks/session-stop.js");
    const stopPayload: StopPayload = {
      session_id: payload.session_id,
      transcript_path: payload.transcript_path,
      cwd: payload.cwd,
      stop_hook_active: payload.stop_hook_active,
      last_assistant_message:
        typeof payload.last_assistant_message === "string"
          ? payload.last_assistant_message
          : undefined,
      hook_event_name: "Stop",
    };
    await processSessionStop(stopPayload);
  } catch {
    // fail-open
  }
  return EMPTY_RESPONSE;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function writeResponse(response: HookResponse): void {
  process.stdout.write(JSON.stringify(response));
}

/**
 * CLI entry point. Reads stdin, routes to the correct handler, writes response.
 */
export async function cliMain(): Promise<void> {
  let exitCode = 0;

  try {
    const { readStdinWithPreview } = await import("../../hooks/stdin-preview.js");
    const { full } = await readStdinWithPreview();

    // Fast-path: empty stdin -> no-op
    if (!full.trim()) {
      writeResponse(EMPTY_RESPONSE);
      process.exit(0);
    }

    let payload: CodexHookPayload;
    try {
      payload = JSON.parse(full) as CodexHookPayload;
    } catch {
      writeResponse(EMPTY_RESPONSE);
      process.exit(0);
    }

    const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";

    // Fast-path: use preview to skip irrelevant events without full routing
    if (!eventName) {
      writeResponse(EMPTY_RESPONSE);
      process.exit(0);
    }

    let response: HookResponse = EMPTY_RESPONSE;

    switch (eventName) {
      case "SessionStart": {
        response = await handleSessionStart(payload);
        break;
      }
      case "PreToolUse": {
        const result = await handlePreToolUse(payload);
        response = result.response;
        exitCode = result.exitCode;
        break;
      }
      case "PostToolUse": {
        response = await handlePostToolUse(payload);
        break;
      }
      case "Stop": {
        response = await handleStop(payload);
        break;
      }
      default: {
        // Unknown event — no-op
        break;
      }
    }

    writeResponse(response);
  } catch {
    // Fail-open: never crash
    writeResponse(EMPTY_RESPONSE);
  }

  process.exit(exitCode);
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  await cliMain();
}
