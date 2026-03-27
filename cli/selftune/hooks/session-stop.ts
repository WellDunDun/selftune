#!/usr/bin/env bun
/**
 * Claude Code Stop hook: session-stop.ts
 *
 * Fires when a Claude Code session ends. Reads the session's transcript JSONL
 * and extracts process-level telemetry (tool calls, errors, skills triggered, etc).
 * Writes one record per session to SQLite via writeSessionTelemetryToDb(),
 * with a JSONL backup to session_telemetry_log.jsonl.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { CANONICAL_LOG, ORCHESTRATE_LOCK, TELEMETRY_LOG } from "../constants.js";
import {
  appendCanonicalRecords,
  buildCanonicalExecutionFact,
  buildCanonicalSession,
  type CanonicalBaseInput,
  getLatestPromptIdentity,
} from "../normalization.js";
import type { SessionTelemetryRecord, StopPayload } from "../types.js";
import { parseTranscript } from "../utils/transcript.js";

const LOCK_STALE_MS = 30 * 60 * 1000;

interface ReactiveSpawnDeps {
  spawnOrchestrate?: () => boolean;
}

function hasFreshOrchestrateLock(lockPath: string): boolean {
  try {
    const lockContent = readFileSync(lockPath, "utf8");
    const lock = JSON.parse(lockContent) as { timestamp?: string };
    if (typeof lock.timestamp !== "string") return false;
    const lockAge = Date.now() - new Date(lock.timestamp).getTime();
    return Number.isFinite(lockAge) && lockAge < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Check for pending improvement signals and spawn a focused orchestrate run
 * in the background if warranted. Fire-and-forget — the hook exits immediately.
 *
 * Returns true if a process was spawned, false otherwise.
 */
export async function maybeSpawnReactiveOrchestrate(
  lockPath: string = ORCHESTRATE_LOCK,
  deps: ReactiveSpawnDeps = {},
): Promise<boolean> {
  try {
    // Read pending signals from SQLite (dynamic import to reduce hook startup cost)
    const { getDb } = await import("../localdb/db.js");
    const { queryImprovementSignals } = await import("../localdb/queries.js");
    const db = getDb();
    const pending = queryImprovementSignals(db, false);
    if (pending.length === 0) return false;

    // Do not pre-claim the orchestrate lock here. The spawned process must
    // acquire its own lock or it will immediately self-block on startup.
    if (hasFreshOrchestrateLock(lockPath)) return false;

    // Spawn orchestrate in background (fire-and-forget)
    try {
      const spawnOrchestrate =
        deps.spawnOrchestrate ??
        (() => {
          const proc = Bun.spawn(["selftune", "orchestrate", "--max-skills", "2"], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
          });
          proc.unref();
          return true;
        });
      if (!spawnOrchestrate()) return false;
    } catch {
      return false;
    }

    return true;
  } catch {
    return false; // Silent — hooks must never block Claude
  }
}

/**
 * Core processing logic, exported for testability.
 * Returns the record that was appended.
 */
export async function processSessionStop(
  payload: StopPayload,
  logPath: string = TELEMETRY_LOG,
  canonicalLogPath: string = CANONICAL_LOG,
  promptStatePath?: string,
): Promise<SessionTelemetryRecord> {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";

  const metrics = parseTranscript(transcriptPath);

  const record: SessionTelemetryRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    cwd,
    transcript_path: transcriptPath,
    source: "claude_code",
    ...metrics,
  };

  // SQLite is the primary store (write first so it's never skipped)
  try {
    const { writeSessionTelemetryToDb } = await import("../localdb/direct-write.js");
    writeSessionTelemetryToDb(record);
  } catch {
    /* hooks must never block */
  }

  // Emit canonical session + execution fact records (additive)
  const baseInput: CanonicalBaseInput = {
    platform: "claude_code",
    capture_mode: "hook",
    source_session_kind: "interactive",
    session_id: sessionId,
    raw_source_ref: {
      path: transcriptPath || undefined,
      event_type: "Stop",
    },
  };
  const latestPrompt = getLatestPromptIdentity(sessionId, promptStatePath, canonicalLogPath);

  // Extract git metadata from workspace (silent on failure)
  let branch: string | undefined;
  let repoRemote: string | undefined;
  if (cwd) {
    try {
      branch =
        execSync("git rev-parse --abbrev-ref HEAD", {
          cwd,
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim() || undefined;
    } catch {
      /* not a git repo or git not available */
    }
    try {
      const rawRemote =
        execSync("git remote get-url origin", {
          cwd,
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim() || undefined;
      if (rawRemote) {
        try {
          const parsed = new URL(rawRemote);
          parsed.username = "";
          parsed.password = "";
          repoRemote = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
        } catch {
          repoRemote = rawRemote; // SSH or non-URL format, safe as-is
        }
      }
    } catch {
      /* no remote configured */
    }
  }

  const canonicalSession = buildCanonicalSession({
    ...baseInput,
    workspace_path: cwd || undefined,
    model: metrics.model,
    started_at: metrics.started_at,
    ended_at: metrics.ended_at ?? record.timestamp,
    branch,
    repo_remote: repoRemote,
    agent_cli: "claude-code",
  });

  const canonicalFact = buildCanonicalExecutionFact({
    ...baseInput,
    occurred_at: record.timestamp,
    prompt_id: latestPrompt.last_actionable_prompt_id ?? latestPrompt.last_prompt_id,
    tool_calls_json: metrics.tool_calls,
    total_tool_calls: metrics.total_tool_calls,
    bash_commands_redacted: metrics.bash_commands,
    assistant_turns: metrics.assistant_turns,
    errors_encountered: metrics.errors_encountered,
    input_tokens: metrics.input_tokens,
    output_tokens: metrics.output_tokens,
    duration_ms: metrics.duration_ms,
  });
  appendCanonicalRecords([canonicalSession, canonicalFact], canonicalLogPath);

  // Reactive: spawn focused orchestrate if pending improvement signals exist
  try {
    await maybeSpawnReactiveOrchestrate();
  } catch {
    // silent — hooks must never block
  }

  return record;
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  try {
    const payload: StopPayload = JSON.parse(await Bun.stdin.text());
    await processSessionStop(payload);
  } catch (err) {
    // silent — hooks must never block Claude
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("session-stop hook failed:", err);
    }
  }
  process.exit(0);
}
