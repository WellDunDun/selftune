/**
 * Shared git metadata extraction for hooks.
 *
 * Extracted from duplicated logic in session-stop.ts (branch/remote extraction)
 * and commit-track.ts (commit detection, remote scrubbing, branch fallback).
 *
 * All functions are fail-open: git errors return undefined/null, never throw.
 */

import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Git metadata extracted from a working directory. */
export interface GitMetadata {
  branch?: string;
  repoRemote?: string;
}

/** Parsed commit information from git output. */
export interface ParsedCommit {
  sha?: string;
  title?: string;
  branch?: string;
}

// ---------------------------------------------------------------------------
// Pre-compiled regex patterns
// ---------------------------------------------------------------------------

/** Matches git commands that produce commits: commit, merge, cherry-pick, revert. */
const GIT_COMMIT_CMD_RE = /\bgit\s+(commit|merge|cherry-pick|revert)\b/;

/**
 * Matches standard git commit output: [branch SHA] title
 * Supports optional parenthetical like (root-commit).
 * Branch names can contain word chars, slashes, dots, hyphens, plus signs.
 */
const COMMIT_OUTPUT_RE = /\[([\w/.+-]+)(?:\s+\([^)]+\))?\s+([a-f0-9]{7,40})\]\s+(.+)/;

// ---------------------------------------------------------------------------
// Git metadata extraction
// ---------------------------------------------------------------------------

/**
 * Extract git branch and remote URL from a working directory.
 *
 * Uses short-timeout execSync calls. Returns partial results if one
 * command fails (e.g., branch succeeds but remote is not configured).
 * Returns empty object if cwd is not a git repo.
 *
 * @param cwd  Working directory to inspect
 */
export function extractGitMetadata(cwd: string): GitMetadata {
  if (!cwd) return {};

  const result: GitMetadata = {};

  try {
    result.branch =
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
      result.repoRemote = scrubRemoteUrl(rawRemote);
    }
  } catch {
    /* no remote configured */
  }

  return result;
}

// ---------------------------------------------------------------------------
// URL scrubbing
// ---------------------------------------------------------------------------

/**
 * Scrub credentials from a git remote URL.
 *
 * HTTP(S) URLs have username/password stripped. SSH URLs and other formats
 * are returned as-is (they don't embed credentials in the URL structure).
 *
 * @param rawUrl  Raw remote URL from `git remote get-url`
 * @returns       Scrubbed URL, or undefined for empty input
 */
export function scrubRemoteUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // SSH or non-URL format -- safe as-is
    return rawUrl;
  }
}

// ---------------------------------------------------------------------------
// Commit detection
// ---------------------------------------------------------------------------

/**
 * Check if a command string contains a git commit-producing operation.
 * Detects: git commit, git merge, git cherry-pick, git revert.
 */
export function containsGitCommitCommand(command: string): boolean {
  return GIT_COMMIT_CMD_RE.test(command);
}

/**
 * Parse commit metadata from git's standard output format.
 *
 * Expects output like: `[main abc1234] Fix the bug`
 * or with root-commit: `[main (root-commit) abc1234] Initial commit`
 *
 * @param stdout  The stdout from a git commit/merge/cherry-pick/revert command
 * @returns       Parsed commit info, or null if output doesn't match
 */
export function parseCommitFromOutput(stdout: string): ParsedCommit | null {
  const match = stdout.match(COMMIT_OUTPUT_RE);
  if (!match) return null;

  return {
    branch: match[1],
    sha: match[2],
    title: match[3].trim(),
  };
}
