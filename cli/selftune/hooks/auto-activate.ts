#!/usr/bin/env bun
/**
 * Claude Code UserPromptSubmit hook: auto-activate.ts
 *
 * Evaluates activation rules against the current session context and
 * outputs suggestions to stderr (shown to Claude as system messages).
 * Suggestions are advisory — exit code is always 0.
 *
 * Session state is tracked to avoid repeated nags within a session.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  CLAUDE_SETTINGS_PATH,
  EVOLUTION_AUDIT_LOG,
  QUERY_LOG,
  SELFTUNE_CONFIG_DIR,
  sessionStatePath,
  TELEMETRY_LOG,
} from "../constants.js";
import type {
  ActivationContext,
  ActivationRule,
  PromptSubmitPayload,
  SessionState,
} from "../types.js";

// ---------------------------------------------------------------------------
// Session state persistence
// ---------------------------------------------------------------------------

export function loadSessionState(path: string, sessionId: string): SessionState {
  if (!existsSync(path)) {
    return { session_id: sessionId, suggestions_shown: [], updated_at: new Date().toISOString() };
  }

  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as SessionState;
    if (data.session_id === sessionId && Array.isArray(data.suggestions_shown)) {
      return data;
    }
  } catch {
    // corrupt file — start fresh
  }

  return { session_id: sessionId, suggestions_shown: [], updated_at: new Date().toISOString() };
}

export function saveSessionState(path: string, state: SessionState): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// PAI coexistence check
// ---------------------------------------------------------------------------

/**
 * Check if PAI's skill-activation-prompt hook is registered in settings.
 * If so, selftune defers skill-level suggestions.
 */
export function checkPaiCoexistence(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks?: Record<string, Array<{ command?: string; hooks?: Array<{ command?: string }> }>>;
    };

    if (!settings.hooks) return false;

    // Search all hook entries for skill-activation-prompt
    for (const hookEntries of Object.values(settings.hooks)) {
      if (!Array.isArray(hookEntries)) continue;
      for (const entry of hookEntries) {
        // Check flat entry.command
        if (
          typeof entry.command === "string" &&
          entry.command.includes("skill-activation-prompt")
        ) {
          return true;
        }
        // Check nested entry.hooks[].command
        if (entry.hooks && Array.isArray(entry.hooks)) {
          for (const hook of entry.hooks) {
            if (
              typeof hook.command === "string" &&
              hook.command.includes("skill-activation-prompt")
            ) {
              return true;
            }
          }
        }
      }
    }
  } catch {
    // fail-open
  }

  return false;
}

// ---------------------------------------------------------------------------
// Rule evaluation engine
// ---------------------------------------------------------------------------

/**
 * Evaluate all rules against the current context, respecting session state.
 * Returns array of suggestion strings for rules that fired.
 */
export function evaluateRules(
  rules: ActivationRule[],
  ctx: ActivationContext,
  statePath: string,
): string[] {
  const state = loadSessionState(statePath, ctx.session_id);
  const suggestions: string[] = [];
  const newlyShown: string[] = [];

  for (const rule of rules) {
    // Skip rules already shown this session
    if (state.suggestions_shown.includes(rule.id)) continue;

    try {
      const suggestion = rule.evaluate(ctx);
      if (suggestion !== null) {
        suggestions.push(suggestion);
        newlyShown.push(rule.id);
      }
    } catch {
      // fail-open: skip rules that throw
    }
  }

  // Persist updated session state
  if (newlyShown.length > 0) {
    state.suggestions_shown.push(...newlyShown);
    state.updated_at = new Date().toISOString();
    saveSessionState(statePath, state);
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Reusable auto-activate orchestration
// ---------------------------------------------------------------------------

/**
 * Evaluate activation rules for a session and return suggestion strings.
 * Checks PAI coexistence and session state dedup internally.
 * Returns an empty array when PAI is active or no rules fire.
 */
export async function processAutoActivate(
  sessionId: string,
  settingsPath?: string,
): Promise<string[]> {
  // Only check PAI coexistence when a settings path is provided (platform-specific)
  if (settingsPath && checkPaiCoexistence(settingsPath)) return [];

  const { DEFAULT_RULES } = await import("../activation-rules.js");

  const ctx: ActivationContext = {
    session_id: sessionId,
    query_log_path: QUERY_LOG,
    telemetry_log_path: TELEMETRY_LOG,
    evolution_audit_log_path: EVOLUTION_AUDIT_LOG,
    selftune_dir: SELFTUNE_CONFIG_DIR,
    settings_path: settingsPath ?? "",
  };

  const statePath = sessionStatePath(sessionId);
  return evaluateRules(DEFAULT_RULES, ctx, statePath);
}

// ---------------------------------------------------------------------------
// stdin main (only when executed directly, not when imported)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    const payload: PromptSubmitPayload = JSON.parse(await Bun.stdin.text());
    const sessionId = payload.session_id ?? "unknown";
    const suggestions = await processAutoActivate(sessionId, CLAUDE_SETTINGS_PATH);

    if (suggestions.length > 0) {
      const context = suggestions.map((s) => `[selftune] Suggestion: ${s}`).join("\n");
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: context,
          },
        }),
      );
    }
  } catch {
    // silent — hooks must never block Claude
  }
  process.exit(0);
}
