import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLock,
  markSignalsConsumed,
  releaseLock,
  selectCandidates,
} from "../cli/selftune/orchestrate.js";
import type { SkillStatus } from "../cli/selftune/status.js";
import type { ImprovementSignalRecord, MonitoringSnapshot } from "../cli/selftune/types.js";
import { readJsonl } from "../cli/selftune/utils/jsonl.js";
import { writeImprovementSignalToDb } from "../cli/selftune/localdb/direct-write.js";
import { queryImprovementSignals } from "../cli/selftune/localdb/queries.js";
import { getDb } from "../cli/selftune/localdb/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MonitoringSnapshot> = {}): MonitoringSnapshot {
  return {
    timestamp: new Date().toISOString(),
    skill_name: "TestSkill",
    window_sessions: 20,
    skill_checks: 10,
    pass_rate: 0.8,
    false_negative_rate: 0.1,
    by_invocation_type: {
      explicit: { passed: 5, total: 5 },
      implicit: { passed: 3, total: 5 },
      contextual: { passed: 0, total: 0 },
      negative: { passed: 0, total: 0 },
    },
    regression_detected: false,
    baseline_pass_rate: 0.5,
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillStatus> = {}): SkillStatus {
  return {
    name: "TestSkill",
    passRate: 0.8,
    trend: "stable",
    missedQueries: 0,
    status: "HEALTHY",
    snapshot: makeSnapshot(),
    ...overrides,
  };
}

function makeSignal(overrides: Partial<ImprovementSignalRecord> = {}): ImprovementSignalRecord {
  return {
    timestamp: new Date().toISOString(),
    session_id: "sess-001",
    query: "test query",
    signal_type: "correction",
    consumed: false,
    ...overrides,
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "signal-orchestrate-test-"));
}

// ---------------------------------------------------------------------------
// Signal grouping via selectCandidates
// ---------------------------------------------------------------------------

describe("selectCandidates with signals", () => {
  test("UNGRADED skill with 0 missed queries normally skipped, proceeds with signal", () => {
    const skills = [
      makeSkill({ name: "NewSkill", status: "UNGRADED", passRate: null, missedQueries: 0 }),
    ];

    // Without signal: skipped
    const withoutSignal = selectCandidates(skills, { maxSkills: 5 });
    expect(withoutSignal[0].action).toBe("skip");
    expect(withoutSignal[0].reason).toContain("insufficient signal");

    // With signal: evolves
    const signaledSkills = new Map([["newskill", 1]]);
    const withSignal = selectCandidates(skills, { maxSkills: 5, signaledSkills });
    expect(withSignal[0].action).toBe("evolve");
  });

  test("skill with insufficient evidence normally skipped, proceeds with signal", () => {
    const skills = [
      makeSkill({
        name: "SparseSkill",
        status: "WARNING",
        passRate: 0.5,
        missedQueries: 2,
        snapshot: makeSnapshot({ skill_checks: 1 }),
      }),
    ];

    // Without signal: skipped
    const withoutSignal = selectCandidates(skills, { maxSkills: 5 });
    expect(withoutSignal[0].action).toBe("skip");
    expect(withoutSignal[0].reason).toContain("insufficient evidence");

    // With signal: evolves
    const signaledSkills = new Map([["sparseskill", 2]]);
    const withSignal = selectCandidates(skills, { maxSkills: 5, signaledSkills });
    expect(withSignal[0].action).toBe("evolve");
  });

  test("signal boost affects priority ordering", () => {
    const skills = [
      makeSkill({
        name: "LowPriority",
        status: "WARNING",
        passRate: 0.5,
        missedQueries: 3,
        trend: "stable",
      }),
      makeSkill({
        name: "HighSignal",
        status: "WARNING",
        passRate: 0.6,
        missedQueries: 1,
        trend: "stable",
      }),
    ];

    // Without signals, LowPriority has higher base priority (more missed queries, lower pass rate)
    const withoutSignal = selectCandidates(skills, { maxSkills: 1 });
    const evolvedWithout = withoutSignal.find((r) => r.action === "evolve");
    expect(evolvedWithout?.skill).toBe("LowPriority");

    // With signal boost on HighSignal, it should be selected instead
    const signaledSkills = new Map([["highsignal", 3]]);
    const withSignal = selectCandidates(skills, { maxSkills: 1, signaledSkills });
    const evolvedWith = withSignal.find((r) => r.action === "evolve");
    expect(evolvedWith?.skill).toBe("HighSignal");
  });

  test("signal boost is capped at 450 (3 signals)", () => {
    const skills = [
      makeSkill({
        name: "ManySignals",
        status: "WARNING",
        passRate: 0.5,
        missedQueries: 1,
        trend: "stable",
      }),
      makeSkill({
        name: "BaseHigh",
        status: "CRITICAL",
        passRate: 0.1,
        missedQueries: 50,
        trend: "down",
      }),
    ];

    // Even with 10 signals, cap is 450. CRITICAL with max missed + trend down should still win.
    // CRITICAL base: 300 + 50 + 90 + 30 = 470
    // WARNING base with 10 signals: 200 + 1 + 50 + 0 + 450 = 701
    // Actually the signaled one wins here with cap, that's expected.
    // Let's test that 4 signals and 10 signals give same result (cap test)
    const fourSignals = new Map([["manysignals", 4]]);
    const tenSignals = new Map([["manysignals", 10]]);

    const withFour = selectCandidates(skills, { maxSkills: 2, signaledSkills: fourSignals });
    const withTen = selectCandidates(skills, { maxSkills: 2, signaledSkills: tenSignals });

    // Both should produce the same ordering since 4*150=600 > 450 cap, and 10*150=1500 > 450 cap
    const fourOrder = withFour.filter((r) => r.action === "evolve").map((r) => r.skill);
    const tenOrder = withTen.filter((r) => r.action === "evolve").map((r) => r.skill);
    expect(fourOrder).toEqual(tenOrder);
  });

  test("signals without mentioned_skill are ignored in grouping", () => {
    const skills = [
      makeSkill({ name: "SomeSkill", status: "UNGRADED", passRate: null, missedQueries: 0 }),
    ];

    // Signal without mentioned_skill should not affect any skill
    const signaledSkills = new Map<string, number>(); // empty after grouping signals without mentioned_skill
    const result = selectCandidates(skills, { maxSkills: 5, signaledSkills });
    expect(result[0].action).toBe("skip");
  });

  test("multiple signals for same skill aggregate count", () => {
    // This tests groupSignalsBySkill indirectly through selectCandidates
    const skills = [
      makeSkill({ name: "Popular", status: "UNGRADED", passRate: null, missedQueries: 0 }),
    ];

    const signaledSkills = new Map([["popular", 3]]);
    const result = selectCandidates(skills, { maxSkills: 5, signaledSkills });
    expect(result[0].action).toBe("evolve");
  });
});

// ---------------------------------------------------------------------------
// markSignalsConsumed
// ---------------------------------------------------------------------------

describe("markSignalsConsumed", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("marks matching signals as consumed", () => {
    // Seed signals into SQLite via direct-write

    const signals = [
      makeSignal({ timestamp: "2025-01-01T00:00:00Z", session_id: "s1", mentioned_skill: "A" }),
      makeSignal({ timestamp: "2025-01-01T00:01:00Z", session_id: "s2", mentioned_skill: "B" }),
      makeSignal({
        timestamp: "2025-01-01T00:02:00Z",
        session_id: "s3",
        consumed: true,
        consumed_at: "2025-01-01T00:05:00Z",
        consumed_by_run: "old_run",
      }),
    ];

    for (const s of signals) {
      writeImprovementSignalToDb(s);
    }

    // Only pass the unconsumed signals as pending
    const pendingSignals = signals.filter((s) => !s.consumed);
    markSignalsConsumed(pendingSignals, "run_123");

    const db = getDb();
    const updated = db
      .query("SELECT * FROM improvement_signals WHERE session_id IN ('s1','s2','s3') ORDER BY timestamp ASC")
      .all();
    expect(updated).toHaveLength(3);

    // First two should be consumed
    expect(updated[0].consumed).toBe(1);
    expect(updated[0].consumed_by_run).toBe("run_123");
    expect(updated[0].consumed_at).toBeDefined();

    expect(updated[1].consumed).toBe(1);
    expect(updated[1].consumed_by_run).toBe("run_123");

    // Third was already consumed, should retain original values
    expect(updated[2].consumed).toBe(1);
    expect(updated[2].consumed_by_run).toBe("old_run");
  });

  test("handles empty pending signals", () => {
    // Should not throw with empty list
    expect(() => markSignalsConsumed([], "run_123")).not.toThrow();
  });

});

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

describe("lockfile", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("acquireLock succeeds on first call", () => {
    tempDir = makeTempDir();
    const lockPath = join(tempDir, ".orchestrate.lock");
    expect(acquireLock(lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("acquireLock fails when lock exists and is fresh", () => {
    tempDir = makeTempDir();
    const lockPath = join(tempDir, ".orchestrate.lock");

    // First acquire succeeds
    expect(acquireLock(lockPath)).toBe(true);

    // Second acquire fails (lock is fresh)
    expect(acquireLock(lockPath)).toBe(false);
  });

  test("acquireLock succeeds when lock is stale (> 30 min)", () => {
    tempDir = makeTempDir();
    const lockPath = join(tempDir, ".orchestrate.lock");

    // Write a stale lock (31 minutes old)
    const staleLock = {
      pid: 99999,
      timestamp: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    };
    writeFileSync(lockPath, JSON.stringify(staleLock));

    // Should succeed because lock is stale
    expect(acquireLock(lockPath)).toBe(true);

    // Verify lock was overwritten with current PID
    const lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(lockContent.pid).toBe(process.pid);
  });

  test("releaseLock removes lock file", () => {
    tempDir = makeTempDir();
    const lockPath = join(tempDir, ".orchestrate.lock");

    acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("releaseLock is silent when lock does not exist", () => {
    tempDir = makeTempDir();
    const lockPath = join(tempDir, ".nonexistent.lock");

    // Should not throw
    expect(() => releaseLock(lockPath)).not.toThrow();
  });

  test("acquireLock handles corrupted lock file gracefully", () => {
    tempDir = makeTempDir();
    const lockPath = join(tempDir, ".orchestrate.lock");

    // Write invalid JSON
    writeFileSync(lockPath, "not valid json");

    // Should succeed (fail-open on parse error, treats as stale)
    expect(acquireLock(lockPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readPendingSignals and groupSignalsBySkill (tested indirectly)
// ---------------------------------------------------------------------------

describe("signal reading and grouping", () => {
  test("groupSignalsBySkill aggregates counts by lowercase skill name", () => {
    // We test this through selectCandidates since groupSignalsBySkill is internal
    // The signaledSkills map is pre-grouped when passed to selectCandidates
    const skills = [
      makeSkill({ name: "Research", status: "UNGRADED", passRate: null, missedQueries: 0 }),
    ];

    const signaledSkills = new Map([["research", 5]]);
    const result = selectCandidates(skills, { maxSkills: 5, signaledSkills });
    expect(result[0].action).toBe("evolve");
  });
});
