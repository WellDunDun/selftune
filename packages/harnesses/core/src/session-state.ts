/**
 * Generic session state persistence for hooks.
 *
 * Extracted from the duplicate patterns in auto-activate.ts (loadSessionState/saveSessionState)
 * and skill-change-guard.ts (loadGuardState/saveGuardState). Both follow the same pattern:
 *
 *   1. Read a JSON file keyed by session_id
 *   2. If session_id matches, return persisted state; otherwise return defaults
 *   3. Write state back after updates
 *
 * This module generalizes that pattern with a type-safe generic interface.
 * Fail-open: corrupt or missing files return fresh defaults.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SessionState } from "./types.js";

/**
 * Load session state from a JSON file.
 *
 * The file is located at `{dir}/{prefix}-{sessionId}.json`. If the file does not
 * exist, is corrupt, or belongs to a different session, fresh defaults are returned.
 *
 * @param dir        Directory to store state files (e.g., SELFTUNE_CONFIG_DIR)
 * @param prefix     Filename prefix (e.g., "session-state", "guard-state")
 * @param sessionId  Current session ID — state is invalidated when it changes
 * @param defaults   Factory function returning fresh default state data
 */
export function loadSessionState<T extends Record<string, unknown>>(
  dir: string,
  prefix: string,
  sessionId: string,
  defaults: () => T,
): SessionState<T> {
  const safeName = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = join(dir, `${prefix}-${safeName}.json`);

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as SessionState<T>;
    if (raw.session_id === sessionId && typeof raw.data === "object" && raw.data !== null) {
      return raw;
    }
  } catch {
    // ENOENT (missing) or corrupt JSON -- return fresh defaults
  }

  return {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    data: defaults(),
  };
}

/**
 * Save session state to a JSON file.
 *
 * The file is written to `{dir}/{prefix}-{state.session_id}.json`.
 * The directory is created if it does not exist.
 *
 * @param dir     Directory to store state files
 * @param prefix  Filename prefix (must match what was used in loadSessionState)
 * @param state   The session state to persist
 */
export function saveSessionState<T extends Record<string, unknown>>(
  dir: string,
  prefix: string,
  state: SessionState<T>,
): void {
  const safeName = state.session_id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = join(dir, `${prefix}-${safeName}.json`);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}
