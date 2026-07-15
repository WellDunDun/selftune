#!/usr/bin/env bun
/**
 * Pi hook adapter for selftune.
 *
 * Reads Pi hook payloads from stdin and delegates to shared selftune hook logic.
 * Pi extensions emit events for tool calls, tool results, and session lifecycle.
 *
 * Usage: echo '$HOOK_PAYLOAD' | selftune pi hook
 *
 * Event routing:
 *   tool_call        -> skill-change-guard + evolution-guard (PreToolUse)
 *   tool_result      -> skill-eval (processToolUse) + commit-track (processCommitTrack)
 *   message (user)   -> prompt-log (processPrompt) + auto-activate
 *   session_shutdown -> session-stop (processSessionStop)
 *
 * Fail-open: any unhandled error -> exit 0, never crash the host agent.
 */

import type {
  PostToolUsePayload,
  PreToolUsePayload,
  PromptSubmitPayload,
  StopPayload,
} from "@selftune/runtime/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pi hook payload — superset of all event fields. */
export interface PiHookPayload {
  event_type?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_output?: Record<string, unknown>;
  prompt?: string;
  user_prompt?: string;
  model?: string;
  provider?: string;
  last_assistant_message?: string;
  [key: string]: unknown;
}

/** Response written to stdout. Empty object = no-op. */
type HookResponse = Record<string, unknown>;

const EMPTY_RESPONSE: HookResponse = {};

// ---------------------------------------------------------------------------
// Event handlers (dynamic imports for fast startup)
// ---------------------------------------------------------------------------

async function handlePromptSubmit(payload: PiHookPayload): Promise<HookResponse> {
  // 1. Prompt logging
  try {
    const { processPrompt } = await import("@selftune/harness-claude-code/hooks/prompt-log");
    const promptPayload: PromptSubmitPayload = {
      session_id: payload.session_id,
      cwd: payload.cwd,
      prompt: payload.prompt ?? payload.user_prompt,
      user_prompt: payload.user_prompt ?? payload.prompt,
      hook_event_name: "UserPromptSubmit",
    };
    await processPrompt(promptPayload);
  } catch {
    // fail-open
  }

  // 2. Auto-activate suggestions
  let response: HookResponse = EMPTY_RESPONSE;
  try {
    const { processAutoActivate } =
      await import("@selftune/harness-claude-code/hooks/auto-activate");
    const sessionId = payload.session_id ?? "unknown";
    const suggestions = await processAutoActivate(sessionId);
    if (suggestions.length > 0) {
      const context = suggestions.map((s) => `[selftune] Suggestion: ${s}`).join("\n");
      response = { additionalContext: context };
    }
  } catch {
    // fail-open
  }

  return response;
}

async function handlePreToolUse(
  payload: PiHookPayload,
): Promise<{ response: HookResponse; exitCode: number }> {
  const prePayload: PreToolUsePayload = {
    tool_name: payload.tool_name ?? "",
    tool_input: payload.tool_input ?? {},
    tool_use_id: payload.tool_use_id,
    session_id: payload.session_id,
    cwd: payload.cwd,
    hook_event_name: "PreToolUse",
  };

  let constants:
    | { EVOLUTION_AUDIT_LOG: string; SELFTUNE_CONFIG_DIR: string; SESSION_STATE_DIR: string }
    | undefined;
  try {
    constants = await import("@selftune/runtime/constants");
  } catch {
    // fail-open
  }

  // 1. Evolution guard (can block with exit 2)
  try {
    if (constants) {
      const { processEvolutionGuard } =
        await import("@selftune/harness-claude-code/hooks/evolution-guard");
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
      const { processPreToolUse } =
        await import("@selftune/harness-claude-code/hooks/skill-change-guard");
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

async function handlePostToolUse(payload: PiHookPayload): Promise<HookResponse> {
  const postPayload: PostToolUsePayload = {
    tool_name: payload.tool_name ?? "",
    tool_input: payload.tool_input ?? {},
    tool_use_id: payload.tool_use_id,
    tool_response: payload.tool_output,
    session_id: payload.session_id,
    cwd: payload.cwd,
    hook_event_name: "PostToolUse",
  };

  // 1. Skill eval (Read/Skill tool usage tracking)
  try {
    const { processToolUse } = await import("@selftune/harness-claude-code/hooks/skill-eval");
    await processToolUse(postPayload);
  } catch {
    // fail-open
  }

  // 2. Commit tracking (git commit detection in Bash output)
  try {
    const { processCommitTrack } = await import("@selftune/harness-claude-code/hooks/commit-track");
    await processCommitTrack(postPayload);
  } catch {
    // fail-open
  }

  return EMPTY_RESPONSE;
}

async function handleSessionEnd(payload: PiHookPayload): Promise<HookResponse> {
  try {
    const { processSessionStop } = await import("@selftune/harness-claude-code/hooks/session-stop");
    const stopPayload: StopPayload = {
      session_id: payload.session_id,
      cwd: payload.cwd,
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

function writeResponseAndExit(response: HookResponse, code: number): void {
  const data = JSON.stringify(response);
  process.stdout.write(data, () => {
    process.exit(code);
  });
}

/**
 * CLI entry point. Reads stdin, routes to the correct handler, writes response.
 */
export async function cliMain(): Promise<void> {
  let exitCode = 0;

  try {
    const raw = await Bun.stdin.text();

    // Fast-path: empty stdin -> no-op
    if (!raw.trim()) {
      writeResponseAndExit(EMPTY_RESPONSE, 0);
      return;
    }

    let payload: PiHookPayload;
    try {
      payload = JSON.parse(raw) as PiHookPayload;
    } catch {
      writeResponseAndExit(EMPTY_RESPONSE, 0);
      return;
    }

    const eventType = typeof payload.event_type === "string" ? payload.event_type : "";

    if (!eventType) {
      writeResponseAndExit(EMPTY_RESPONSE, 0);
      return;
    }

    let response: HookResponse = EMPTY_RESPONSE;

    switch (eventType) {
      case "message": {
        response = await handlePromptSubmit(payload);
        break;
      }
      case "tool_call": {
        const result = await handlePreToolUse(payload);
        response = result.response;
        exitCode = result.exitCode;
        break;
      }
      case "tool_result": {
        response = await handlePostToolUse(payload);
        break;
      }
      case "session_shutdown": {
        response = await handleSessionEnd(payload);
        break;
      }
      default: {
        // Unknown event — no-op
        break;
      }
    }

    writeResponseAndExit(response, exitCode);
  } catch {
    // Fail-open: never crash
    writeResponseAndExit(EMPTY_RESPONSE, 0);
  }
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  await cliMain();
}
