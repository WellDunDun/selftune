import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkActiveMonitoring,
  hasRecentWatchSnapshot,
  processEvolutionGuard,
} from "../../cli/selftune/hooks/evolution-guard.js";
import type { PreToolUsePayload } from "../../cli/selftune/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-evolution-guard-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// checkActiveMonitoring — reads evolution audit log for deployed proposals
// ---------------------------------------------------------------------------

describe("checkActiveMonitoring", () => {
  test("returns false when audit log does not exist", () => {
    const result = checkActiveMonitoring("pdf", join(tmpDir, "missing.jsonl"));
    expect(result).toBe(false);
  });

  test("returns false when audit log has no deployed entries for skill", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const entries = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        proposal_id: "p1",
        action: "created",
        details: "test",
        skill_name: "other-skill",
      },
      {
        timestamp: "2025-01-02T00:00:00Z",
        proposal_id: "p1",
        action: "validated",
        details: "test",
        skill_name: "other-skill",
      },
    ];
    writeFileSync(logPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");

    const result = checkActiveMonitoring("pdf", logPath);
    expect(result).toBe(false);
  });

  test("returns true when audit log has deployed entry for skill", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const entries = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        proposal_id: "p1",
        action: "created",
        details: "test",
        skill_name: "pdf",
      },
      {
        timestamp: "2025-01-02T00:00:00Z",
        proposal_id: "p1",
        action: "deployed",
        details: "test",
        skill_name: "pdf",
      },
    ];
    writeFileSync(logPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");

    const result = checkActiveMonitoring("pdf", logPath);
    expect(result).toBe(true);
  });

  test("returns false when last action for skill is rolled_back", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const entries = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        proposal_id: "p1",
        action: "deployed",
        details: "test",
        skill_name: "pdf",
      },
      {
        timestamp: "2025-01-02T00:00:00Z",
        proposal_id: "p1",
        action: "rolled_back",
        details: "test",
        skill_name: "pdf",
      },
    ];
    writeFileSync(logPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");

    const result = checkActiveMonitoring("pdf", logPath);
    expect(result).toBe(false);
  });

  test("handles corrupt audit log gracefully", () => {
    const logPath = join(tmpDir, "bad-audit.jsonl");
    writeFileSync(logPath, "not json at all!!!\n", "utf-8");
    const result = checkActiveMonitoring("pdf", logPath);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasRecentWatchSnapshot — checks for a recent monitoring snapshot
// ---------------------------------------------------------------------------

describe("hasRecentWatchSnapshot", () => {
  test("returns false when no snapshot directory exists", () => {
    const result = hasRecentWatchSnapshot("pdf", join(tmpDir, "nonexistent"), 24);
    expect(result).toBe(false);
  });

  test("returns false when snapshot is older than maxAgeHours", () => {
    const snapshotDir = join(tmpDir, "monitoring");
    mkdirSync(snapshotDir, { recursive: true });

    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago
    const snapshot = {
      timestamp: oldTimestamp,
      skill_name: "pdf",
      regression_detected: false,
    };
    writeFileSync(join(snapshotDir, "latest-snapshot.json"), JSON.stringify(snapshot), "utf-8");

    const result = hasRecentWatchSnapshot("pdf", tmpDir, 24);
    expect(result).toBe(false);
  });

  test("returns true when snapshot is recent and matches skill", () => {
    const snapshotDir = join(tmpDir, "monitoring");
    mkdirSync(snapshotDir, { recursive: true });

    const recentTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    const snapshot = {
      timestamp: recentTimestamp,
      skill_name: "pdf",
      regression_detected: false,
    };
    writeFileSync(join(snapshotDir, "latest-snapshot.json"), JSON.stringify(snapshot), "utf-8");

    const result = hasRecentWatchSnapshot("pdf", tmpDir, 24);
    expect(result).toBe(true);
  });

  test("returns false when snapshot is for a different skill", () => {
    const snapshotDir = join(tmpDir, "monitoring");
    mkdirSync(snapshotDir, { recursive: true });

    const recentTimestamp = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const snapshot = {
      timestamp: recentTimestamp,
      skill_name: "other-skill",
      regression_detected: false,
    };
    writeFileSync(join(snapshotDir, "latest-snapshot.json"), JSON.stringify(snapshot), "utf-8");

    const result = hasRecentWatchSnapshot("pdf", tmpDir, 24);
    expect(result).toBe(false);
  });

  test("handles corrupt snapshot file gracefully", () => {
    const snapshotDir = join(tmpDir, "monitoring");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, "latest-snapshot.json"), "bad json!!!", "utf-8");

    const result = hasRecentWatchSnapshot("pdf", tmpDir, 24);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processEvolutionGuard — full hook processing
// ---------------------------------------------------------------------------

describe("processEvolutionGuard", () => {
  function makePayload(overrides?: Partial<PreToolUsePayload>): PreToolUsePayload {
    return {
      tool_name: "Write",
      tool_input: { file_path: "/skills/pdf/SKILL.md" },
      session_id: "sess-1",
      ...overrides,
    };
  }

  test("returns null for non-Write/Edit tools", () => {
    const result = processEvolutionGuard(makePayload({ tool_name: "Read" }), {
      auditLogPath: join(tmpDir, "audit.jsonl"),
      selftuneDir: tmpDir,
    });
    expect(result).toBeNull();
  });

  test("returns null for non-SKILL.md files", () => {
    const result = processEvolutionGuard(
      makePayload({ tool_input: { file_path: "/src/auth.ts" } }),
      { auditLogPath: join(tmpDir, "audit.jsonl"), selftuneDir: tmpDir },
    );
    expect(result).toBeNull();
  });

  test("returns null when skill is not under active monitoring", () => {
    const auditLogPath = join(tmpDir, "audit.jsonl");
    // No audit log = not monitored
    const result = processEvolutionGuard(makePayload(), {
      auditLogPath,
      selftuneDir: tmpDir,
    });
    expect(result).toBeNull();
  });

  test("returns null when skill has a recent watch snapshot", () => {
    // Set up active monitoring
    const auditLogPath = join(tmpDir, "audit.jsonl");
    writeFileSync(
      auditLogPath,
      `${JSON.stringify({
        timestamp: "2025-01-02T00:00:00Z",
        proposal_id: "p1",
        action: "deployed",
        details: "test",
        skill_name: "pdf",
      })}\n`,
      "utf-8",
    );

    // Set up recent snapshot
    const monitorDir = join(tmpDir, "monitoring");
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      join(monitorDir, "latest-snapshot.json"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        skill_name: "pdf",
        regression_detected: false,
      }),
      "utf-8",
    );

    const result = processEvolutionGuard(makePayload(), {
      auditLogPath,
      selftuneDir: tmpDir,
    });
    expect(result).toBeNull();
  });

  test("returns block message when monitored skill has no recent watch", () => {
    // Set up active monitoring
    const auditLogPath = join(tmpDir, "audit.jsonl");
    writeFileSync(
      auditLogPath,
      `${JSON.stringify({
        timestamp: "2025-01-02T00:00:00Z",
        proposal_id: "p1",
        action: "deployed",
        details: "test",
        skill_name: "pdf",
      })}\n`,
      "utf-8",
    );

    // No snapshot file = no recent watch
    const result = processEvolutionGuard(makePayload(), {
      auditLogPath,
      selftuneDir: tmpDir,
    });
    expect(result).not.toBeNull();
    expect(result?.message).toContain("selftune watch");
    expect(result?.message).toContain("pdf");
    expect(result?.exitCode).toBe(2);
  });

  test("returns block message for Edit tool too", () => {
    const auditLogPath = join(tmpDir, "audit.jsonl");
    writeFileSync(
      auditLogPath,
      `${JSON.stringify({
        timestamp: "2025-01-02T00:00:00Z",
        proposal_id: "p1",
        action: "deployed",
        details: "test",
        skill_name: "pptx",
      })}\n`,
      "utf-8",
    );

    const result = processEvolutionGuard(
      makePayload({
        tool_name: "Edit",
        tool_input: { file_path: "/skills/pptx/SKILL.md", old_string: "x", new_string: "y" },
      }),
      { auditLogPath, selftuneDir: tmpDir },
    );
    expect(result).not.toBeNull();
    expect(result?.exitCode).toBe(2);
    expect(result?.message).toContain("pptx");
  });

  test("handles missing file_path gracefully", () => {
    const result = processEvolutionGuard(makePayload({ tool_input: {} }), {
      auditLogPath: join(tmpDir, "audit.jsonl"),
      selftuneDir: tmpDir,
    });
    expect(result).toBeNull();
  });

  test("returns block when snapshot is stale (older than maxAgeHours)", () => {
    const auditLogPath = join(tmpDir, "audit.jsonl");
    writeFileSync(
      auditLogPath,
      `${JSON.stringify({
        timestamp: "2025-01-02T00:00:00Z",
        proposal_id: "p1",
        action: "deployed",
        details: "test",
        skill_name: "pdf",
      })}\n`,
      "utf-8",
    );

    // Stale snapshot (48 hours ago)
    const monitorDir = join(tmpDir, "monitoring");
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      join(monitorDir, "latest-snapshot.json"),
      JSON.stringify({
        timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        skill_name: "pdf",
        regression_detected: false,
      }),
      "utf-8",
    );

    const result = processEvolutionGuard(makePayload(), {
      auditLogPath,
      selftuneDir: tmpDir,
      maxSnapshotAgeHours: 24,
    });
    expect(result).not.toBeNull();
    expect(result?.exitCode).toBe(2);
  });
});
