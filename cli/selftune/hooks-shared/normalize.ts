/**
 * Normalizers that convert platform-specific hook payloads to UnifiedHookEvent.
 *
 * Each platform adapter maps its native payload shape and event names
 * to the shared UnifiedHookEvent interface. The normalizers are intentionally
 * lenient — unknown fields are ignored, missing fields become undefined.
 *
 * Fail-open: any parsing error returns a minimal event with what we have.
 */

import type { HookEventType, HookPlatform, UnifiedHookEvent } from "./types.js";
import { PLATFORM_EVENT_MAP } from "./types.js";

// ---------------------------------------------------------------------------
// Reverse lookup: native event name -> HookEventType
// ---------------------------------------------------------------------------

/** Build a reverse map from native event string to HookEventType for a platform. */
function buildReverseLookup(platform: HookPlatform): Map<string, HookEventType> {
  const forward = PLATFORM_EVENT_MAP[platform];
  const reverse = new Map<string, HookEventType>();
  for (const [hookType, nativeName] of Object.entries(forward)) {
    if (nativeName) {
      reverse.set(nativeName, hookType as HookEventType);
    }
  }
  return reverse;
}

const reverseLookups = new Map<HookPlatform, Map<string, HookEventType>>();

/** Resolve a native event type string to the normalized HookEventType. */
function resolveEventType(
  platform: HookPlatform,
  nativeEventType: string,
): HookEventType | undefined {
  let lookup = reverseLookups.get(platform);
  if (!lookup) {
    lookup = buildReverseLookup(platform);
    reverseLookups.set(platform, lookup);
  }
  return lookup.get(nativeEventType);
}

// ---------------------------------------------------------------------------
// Shared field extraction helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

// ---------------------------------------------------------------------------
// Per-platform field extraction config
// ---------------------------------------------------------------------------

/**
 * Describes how to extract prompt and last_message fields from a platform's
 * payload. Most platforms use the same field names; Claude Code has a
 * user_prompt fallback, and some use last_assistant_message vs last_message.
 */
interface PlatformFieldConfig {
  /** Default event_type when resolution fails */
  fallbackEvent: HookEventType;
  /** Fields to try for prompt (in order, first non-undefined wins) */
  promptFields: string[];
  /** Field name for session-end last message */
  lastMessageField: string;
  /** Field name for post_tool_use output (e.g., "tool_response" or "tool_output") */
  toolOutputField: string;
}

const FIELD_CONFIG: Record<HookPlatform, PlatformFieldConfig> = {
  "claude-code": {
    fallbackEvent: "prompt_submit",
    promptFields: ["prompt", "user_prompt"],
    lastMessageField: "last_assistant_message",
    toolOutputField: "tool_response",
  },
  codex: {
    fallbackEvent: "prompt_submit",
    promptFields: ["prompt"],
    lastMessageField: "last_assistant_message",
    toolOutputField: "tool_response",
  },
  opencode: {
    fallbackEvent: "session_end",
    promptFields: ["prompt"],
    lastMessageField: "last_message",
    toolOutputField: "tool_output",
  },
  cline: {
    fallbackEvent: "session_end",
    promptFields: ["prompt"],
    lastMessageField: "last_message",
    toolOutputField: "tool_output",
  },
  pi: {
    fallbackEvent: "session_end",
    promptFields: ["prompt"],
    lastMessageField: "last_message",
    toolOutputField: "tool_output",
  },
};

// ---------------------------------------------------------------------------
// Unified normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a platform-specific hook payload to UnifiedHookEvent.
 *
 * This single function replaces per-platform normalizers by using
 * FIELD_CONFIG to handle platform-specific field names.
 */
function normalizeForPlatform(
  platform: HookPlatform,
  payload: unknown,
  eventType: string,
): UnifiedHookEvent {
  const raw = obj(payload) ?? {};
  const config = FIELD_CONFIG[platform];
  const resolved = resolveEventType(platform, eventType);

  const base: UnifiedHookEvent = {
    platform,
    event_type: resolved ?? config.fallbackEvent,
    session_id: str(raw.session_id) ?? "unknown",
    cwd: str(raw.cwd),
    transcript_path: str(raw.transcript_path),
    raw_payload: payload,
  };

  if (resolved === "pre_tool_use" || resolved === "post_tool_use") {
    base.tool_name = str(raw.tool_name);
    base.tool_input = obj(raw.tool_input);
    if (resolved === "post_tool_use") {
      base.tool_output = obj(raw[config.toolOutputField]);
    }
  } else if (resolved === "prompt_submit") {
    for (const field of config.promptFields) {
      const v = str(raw[field]);
      if (v) {
        base.prompt = v;
        break;
      }
    }
  } else if (resolved === "session_end") {
    base.last_message = str(raw[config.lastMessageField]);
  }

  return base;
}

// ---------------------------------------------------------------------------
// Public API — named exports for backward compatibility + unified entry point
// ---------------------------------------------------------------------------

export function normalizeClaudeCode(payload: unknown, eventType: string): UnifiedHookEvent {
  return normalizeForPlatform("claude-code", payload, eventType);
}

export function normalizeCodex(payload: unknown, eventType: string): UnifiedHookEvent {
  return normalizeForPlatform("codex", payload, eventType);
}

export function normalizeOpenCode(payload: unknown, eventType: string): UnifiedHookEvent {
  return normalizeForPlatform("opencode", payload, eventType);
}

export function normalizeCline(payload: unknown, eventType: string): UnifiedHookEvent {
  return normalizeForPlatform("cline", payload, eventType);
}

export function normalizePi(payload: unknown, eventType: string): UnifiedHookEvent {
  return normalizeForPlatform("pi", payload, eventType);
}

/**
 * Auto-detect platform and normalize a hook payload to UnifiedHookEvent.
 *
 * @param payload          Raw payload (typically parsed from stdin JSON)
 * @param platform         The host platform
 * @param nativeEventType  The platform-native event type string
 */
export function normalizeHookEvent(
  payload: unknown,
  platform: HookPlatform,
  nativeEventType: string,
): UnifiedHookEvent {
  return normalizeForPlatform(platform, payload, nativeEventType);
}
