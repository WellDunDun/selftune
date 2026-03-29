import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  containsGitCommitCommand,
  parseCommitSha,
  parseCommitTitle,
  parseBranchFromOutput,
  scrubRemoteUrl,
  processCommitTrack,
} from "../../cli/selftune/hooks/commit-track.js";
import { _setTestDb, getDb, openDb } from "../../cli/selftune/localdb/db.js";
import type { PostToolUsePayload } from "../../cli/selftune/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-commit-track-"));
  const testDb = openDb(":memory:");
  _setTestDb(testDb);
});

afterEach(() => {
  const db = getDb();
  db?.close?.();
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to count commit_tracking rows. */
function commitTrackingCount(): number {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as cnt FROM commit_tracking").get() as { cnt: number };
  return row.cnt;
}

/** Helper to get the latest commit_tracking row. */
function getLatestCommitTracking(): Record<string, unknown> | null {
  const db = getDb();
  return db.query("SELECT * FROM commit_tracking ORDER BY id DESC LIMIT 1").get() as Record<
    string,
    unknown
  > | null;
}

// ---------------------------------------------------------------------------
// containsGitCommitCommand
// ---------------------------------------------------------------------------

describe("containsGitCommitCommand", () => {
  test("detects git commit", () => {
    expect(containsGitCommitCommand("git commit -m 'Fix bug'")).toBe(true);
    expect(containsGitCommitCommand('git commit -am "Add feature"')).toBe(true);
  });

  test("detects git merge", () => {
    expect(containsGitCommitCommand("git merge feature-branch")).toBe(true);
  });

  test("detects git cherry-pick", () => {
    expect(containsGitCommitCommand("git cherry-pick abc1234")).toBe(true);
  });

  test("detects git revert", () => {
    expect(containsGitCommitCommand("git revert HEAD")).toBe(true);
  });

  test("skips non-commit git commands", () => {
    expect(containsGitCommitCommand("git status")).toBe(false);
    expect(containsGitCommitCommand("git log --oneline")).toBe(false);
    expect(containsGitCommitCommand("git diff")).toBe(false);
    expect(containsGitCommitCommand("git push origin main")).toBe(false);
  });

  test("skips non-git commands", () => {
    expect(containsGitCommitCommand("ls -la")).toBe(false);
    expect(containsGitCommitCommand("echo hello")).toBe(false);
    expect(containsGitCommitCommand("npm install")).toBe(false);
  });

  test("handles piped/chained commands containing git commit", () => {
    expect(containsGitCommitCommand("git add . && git commit -m 'Fix'")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseCommitSha
// ---------------------------------------------------------------------------

describe("parseCommitSha", () => {
  test("extracts SHA from standard git commit output", () => {
    expect(parseCommitSha("[main abc1234] Fix bug")).toBe("abc1234");
  });

  test("extracts SHA from feature branch output", () => {
    expect(parseCommitSha("[feature/branch 1234567] Add feature")).toBe("1234567");
  });

  test("extracts SHA from root-commit output", () => {
    expect(parseCommitSha("[main (root-commit) abc1234] Initial commit")).toBe("abc1234");
  });

  test("extracts full 40-char SHA", () => {
    expect(parseCommitSha("[main abcdef1234567890abcdef1234567890abcdef12] Fix")).toBe(
      "abcdef1234567890abcdef1234567890abcdef12",
    );
  });

  test("extracts SHA from multiline output", () => {
    const output = `[main d1e2f3a] Add new feature
 2 files changed, 45 insertions(+), 3 deletions(-)`;
    expect(parseCommitSha(output)).toBe("d1e2f3a");
  });

  test("returns undefined for non-commit output", () => {
    expect(parseCommitSha("On branch main")).toBeUndefined();
    expect(parseCommitSha("nothing to commit")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseCommitTitle
// ---------------------------------------------------------------------------

describe("parseCommitTitle", () => {
  test("extracts title from standard output", () => {
    expect(parseCommitTitle("[main abc1234] Fix bug in parser")).toBe("Fix bug in parser");
  });

  test("extracts title from root-commit output", () => {
    expect(parseCommitTitle("[main (root-commit) abc1234] Initial commit")).toBe("Initial commit");
  });

  test("returns undefined for non-commit output", () => {
    expect(parseCommitTitle("nothing to commit")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseBranchFromOutput
// ---------------------------------------------------------------------------

describe("parseBranchFromOutput", () => {
  test("extracts branch from standard output", () => {
    expect(parseBranchFromOutput("[main abc1234] Fix bug")).toBe("main");
  });

  test("extracts branch with slashes", () => {
    expect(parseBranchFromOutput("[feature/my-branch abc1234] Add feature")).toBe(
      "feature/my-branch",
    );
  });

  test("extracts branch from root-commit output", () => {
    expect(parseBranchFromOutput("[main (root-commit) abc1234] Initial commit")).toBe("main");
  });

  test("returns undefined for non-commit output", () => {
    expect(parseBranchFromOutput("nothing to commit")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// scrubRemoteUrl
// ---------------------------------------------------------------------------

describe("scrubRemoteUrl", () => {
  test("scrubs credentials from HTTPS URL", () => {
    expect(scrubRemoteUrl("https://user:token@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
  });

  test("passes through clean HTTPS URL", () => {
    expect(scrubRemoteUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
  });

  test("passes through SSH URL", () => {
    expect(scrubRemoteUrl("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
  });

  test("returns undefined for empty input", () => {
    expect(scrubRemoteUrl("")).toBeUndefined();
    expect(scrubRemoteUrl(undefined as unknown as string)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// processCommitTrack (integration)
// ---------------------------------------------------------------------------

describe("processCommitTrack", () => {
  test("records a git commit from Bash tool output", async () => {
    const payload: PostToolUsePayload = {
      session_id: "sess-123",
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "Fix bug"' },
      tool_response: {
        stdout: `[main d1e2f3a] Fix bug
 2 files changed, 45 insertions(+), 3 deletions(-)`,
      },
    };

    const result = await processCommitTrack(payload);
    expect(result).not.toBeNull();
    expect(result?.commit_sha).toBe("d1e2f3a");
    expect(result?.commit_title).toBe("Fix bug");

    expect(commitTrackingCount()).toBe(1);
    const row = getLatestCommitTracking();
    expect(row?.session_id).toBe("sess-123");
    expect(row?.commit_sha).toBe("d1e2f3a");
    expect(row?.commit_title).toBe("Fix bug");
  });

  test("skips non-Bash tool", async () => {
    const payload: PostToolUsePayload = {
      session_id: "sess-123",
      tool_name: "Read",
      tool_input: { file_path: "/some/file.ts" },
      tool_response: {},
    };

    const result = await processCommitTrack(payload);
    expect(result).toBeNull();
    expect(commitTrackingCount()).toBe(0);
  });

  test("skips non-git-commit Bash commands", async () => {
    const payload: PostToolUsePayload = {
      session_id: "sess-123",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_response: { stdout: "On branch main\nnothing to commit" },
    };

    const result = await processCommitTrack(payload);
    expect(result).toBeNull();
    expect(commitTrackingCount()).toBe(0);
  });

  test("skips when no SHA can be parsed from output", async () => {
    const payload: PostToolUsePayload = {
      session_id: "sess-123",
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'empty'" },
      tool_response: { stdout: "nothing to commit, working tree clean" },
    };

    const result = await processCommitTrack(payload);
    expect(result).toBeNull();
    expect(commitTrackingCount()).toBe(0);
  });

  test("handles git merge output", async () => {
    const payload: PostToolUsePayload = {
      session_id: "sess-456",
      tool_name: "Bash",
      tool_input: { command: "git merge feature-branch" },
      tool_response: {
        stdout: `Merge made by the 'ort' strategy.
 src/app.ts | 10 +++++++---
 1 file changed, 7 insertions(+), 3 deletions(-)`,
      },
    };

    // Merge output doesn't always have the [branch SHA] format,
    // so this should return null when SHA can't be parsed
    const result = await processCommitTrack(payload);
    // This particular merge output has no [branch SHA] line
    expect(result).toBeNull();
  });

  test("handles git cherry-pick output", async () => {
    const payload: PostToolUsePayload = {
      session_id: "sess-789",
      tool_name: "Bash",
      tool_input: { command: "git cherry-pick abc1234" },
      tool_response: {
        stdout: `[main f5e6d7c] Cherry-picked feature
 1 file changed, 5 insertions(+)`,
      },
    };

    const result = await processCommitTrack(payload);
    expect(result).not.toBeNull();
    expect(result?.commit_sha).toBe("f5e6d7c");
  });

  test("handles missing tool_response gracefully", async () => {
    const payload: PostToolUsePayload = {
      session_id: "sess-123",
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'test'" },
    };

    const result = await processCommitTrack(payload);
    expect(result).toBeNull();
  });
});
