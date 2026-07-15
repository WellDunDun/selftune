/**
 * Universal hook types for multi-agent abstraction.
 * All platform adapters normalize their native events to these types.
 */

/** Supported agent platforms */
export type HookPlatform = "claude-code" | "codex" | "opencode" | "cline" | "pi";

/** Normalized event types across all platforms */
export type HookEventType = "pre_tool_use" | "post_tool_use" | "prompt_submit" | "session_end";

/**
 * Platform-agnostic hook event. Each adapter normalizes its native payload to this shape.
 * Fields are optional because not all platforms provide all data.
 */
export interface UnifiedHookEvent {
  platform: HookPlatform;
  event_type: HookEventType;
  session_id: string;
  cwd?: string;
  transcript_path?: string;

  // Tool-related (pre_tool_use / post_tool_use)
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: Record<string, unknown>;

  // Prompt-related (prompt_submit)
  prompt?: string;

  // Session-related (session_end)
  last_message?: string;

  /** Original platform-specific payload, preserved for platform-specific logic */
  raw_payload?: unknown;
}

/**
 * Hook response returned to the host agent.
 * Adapters translate this back to platform-specific format.
 */
export interface HookResponse {
  /** Whether the hook modified the input */
  modified: boolean;
  /** Decision for PreToolUse guards */
  decision?: "allow" | "block" | "skip";
  /** Modified tool input (for pre_tool_use hooks that modify commands) */
  updated_input?: Record<string, unknown>;
  /** Advisory message (stderr suggestions) */
  message?: string;
  /** Additional context to inject (stdout JSON for Claude Code) */
  context?: string;
}

/** Generic session state for dedup/tracking across hook invocations */
export interface SessionState<T extends Record<string, unknown> = Record<string, unknown>> {
  session_id: string;
  created_at: string;
  data: T;
}

/** Platform event mapping reference */
export const PLATFORM_EVENT_MAP: Record<HookPlatform, Partial<Record<HookEventType, string>>> = {
  "claude-code": {
    pre_tool_use: "PreToolUse",
    post_tool_use: "PostToolUse",
    prompt_submit: "UserPromptSubmit",
    session_end: "Stop",
  },
  codex: {
    pre_tool_use: "PreToolUse",
    post_tool_use: "PostToolUse",
    prompt_submit: "SessionStart",
    session_end: "Stop",
  },
  opencode: {
    pre_tool_use: "tool.execute.before",
    post_tool_use: "tool.execute.after",
    session_end: "session.idle",
  },
  cline: {
    post_tool_use: "PostToolUse",
    session_end: "TaskComplete",
  },
  pi: {
    prompt_submit: "message",
    pre_tool_use: "tool_call",
    post_tool_use: "tool_result",
    session_end: "session_shutdown",
  },
};
