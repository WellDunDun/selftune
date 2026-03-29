#!/usr/bin/env bun
/**
 * PostToolUse hook: commit-track.ts
 *
 * Detects git commits in Bash tool output and records commit SHA, title,
 * branch, and session ID for session-to-commit traceability.
 *
 * Fail-open: exits 0 on all errors. Never blocks the host agent.
 */

import { execSync } from "node:child_process";

import type { PostToolUsePayload } from "../types.js";

// -- Regex patterns (pre-compiled at module load) ----------------------------

/** Matches git commands that produce commits. */
const GIT_COMMIT_CMD_RE = /\bgit\s+(commit|merge|cherry-pick|revert)\b/;

/**
 * Matches the standard git commit output format: [branch SHA] title
 * Supports optional parenthetical like (root-commit).
 * Branch names can contain word chars, slashes, dots, hyphens, plus signs.
 */
const COMMIT_OUTPUT_RE = /\[([\w/.+-]+)(?:\s+\([^)]+\))?\s+([a-f0-9]{7,40})\]\s+(.+)/;

// -- Pure extraction functions (exported for testability) ---------------------

/** Check if a command string contains a git commit/merge/cherry-pick/revert. */
export function containsGitCommitCommand(command: string): boolean {
  return GIT_COMMIT_CMD_RE.test(command);
}

/** Extract commit SHA from git output. */
export function parseCommitSha(output: string): string | undefined {
  const match = output.match(COMMIT_OUTPUT_RE);
  return match ? match[2] : undefined;
}

/** Extract commit title from git output. */
export function parseCommitTitle(output: string): string | undefined {
  const match = output.match(COMMIT_OUTPUT_RE);
  return match ? match[3].trim() : undefined;
}

/** Extract branch name from git output. */
export function parseBranchFromOutput(output: string): string | undefined {
  const match = output.match(COMMIT_OUTPUT_RE);
  return match ? match[1] : undefined;
}

/** Scrub credentials from a remote URL. Returns undefined for empty input. */
export function scrubRemoteUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // SSH or non-URL format — safe as-is
    return rawUrl;
  }
}

// -- Commit tracking record shape --------------------------------------------

export interface CommitTrackRecord {
  session_id: string;
  commit_sha: string;
  commit_title?: string;
  branch?: string;
  repo_remote?: string;
  timestamp: string;
}

// -- Core processing logic ---------------------------------------------------

/**
 * Process a PostToolUse payload for git commit tracking.
 * Returns the record that was written, or null if skipped.
 * Exported for testability.
 */
export async function processCommitTrack(
  payload: PostToolUsePayload,
): Promise<CommitTrackRecord | null> {
  // Fast-path: only care about Bash tool
  if (payload.tool_name !== "Bash") return null;

  // Fast-path: check if the command is a git commit-producing operation
  const command = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
  if (!containsGitCommitCommand(command)) return null;

  // Extract stdout from tool_response
  const response = payload.tool_response ?? {};
  const stdout = typeof response.stdout === "string" ? response.stdout : "";
  if (!stdout) return null;

  // Parse commit SHA — if we can't find one, nothing to track
  const commitSha = parseCommitSha(stdout);
  if (!commitSha) return null;

  const commitTitle = parseCommitTitle(stdout);
  const outputBranch = parseBranchFromOutput(stdout);
  const sessionId = payload.session_id ?? "unknown";
  const cwd = payload.cwd ?? "";

  // Try to get branch from git if not parsed from output
  let branch = outputBranch;
  if (!branch && cwd) {
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
  }

  // Try to get remote URL (scrub credentials)
  let repoRemote: string | undefined;
  if (cwd) {
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
        repoRemote = scrubRemoteUrl(rawRemote);
      }
    } catch {
      /* no remote configured */
    }
  }

  const record: CommitTrackRecord = {
    session_id: sessionId,
    commit_sha: commitSha,
    commit_title: commitTitle,
    branch,
    repo_remote: repoRemote,
    timestamp: new Date().toISOString(),
  };

  // Write to SQLite (dynamic import to reduce hook startup cost)
  try {
    const { writeCommitTracking } = await import("../localdb/direct-write.js");
    writeCommitTracking(record);
  } catch {
    /* hooks must never block */
  }

  return record;
}

// --- stdin main (only when executed directly, not when imported) ---
if (import.meta.main) {
  try {
    const payload: PostToolUsePayload = JSON.parse(await Bun.stdin.text());
    await processCommitTrack(payload);
  } catch {
    // silent — hooks must never block Claude
  }
  process.exit(0);
}
