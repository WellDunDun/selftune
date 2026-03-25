/**
 * Tests for post-deploy monitoring (TASK-16).
 *
 * Tests computeMonitoringSnapshot as a pure function with deterministic inputs,
 * and tests watch() with dependency injection (no mock.module).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";
import type { WatchOptions, WatchResult } from "../../cli/selftune/monitoring/watch.js";
import { computeMonitoringSnapshot } from "../../cli/selftune/monitoring/watch.js";
import type {
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeTelemetryRecord(
  overrides: Partial<SessionTelemetryRecord> = {},
): SessionTelemetryRecord {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    cwd: "/tmp/project",
    transcript_path: "/tmp/transcript.jsonl",
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [],
    assistant_turns: 1,
    errors_encountered: 0,
    transcript_chars: 100,
    last_user_query: "test query",
    ...overrides,
  };
}

function makeSkillUsageRecord(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    skill_name: "test-skill",
    skill_path: "/tmp/skills/test-skill/SKILL.md",
    query: "test query",
    triggered: true,
    ...overrides,
  };
}

function makeQueryLogRecord(overrides: Partial<QueryLogRecord> = {}): QueryLogRecord {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    query: "test query",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: write JSONL temp files
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-watch-test-"));
});

afterEach(() => {
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl<T>(records: T[]): string {
  const filePath = join(tmpDir, `log-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  const content = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// computeMonitoringSnapshot - pure function tests
// ---------------------------------------------------------------------------

describe("computeMonitoringSnapshot", () => {
  // 1. Basic pass rate calculation
  test("computes pass rate from skill usage and query records", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
    ];
    const queryRecords: QueryLogRecord[] = [
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
    ];
    const telemetry: SessionTelemetryRecord[] = [
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: [] }),
    ];

    const snapshot = computeMonitoringSnapshot(
      "my-skill",
      telemetry,
      skillRecords,
      queryRecords,
      20,
      0.8,
    );

    // 2 triggered out of 3 explicit skill checks = 0.666...
    expect(snapshot.pass_rate).toBeCloseTo(2 / 3, 2);
    expect(snapshot.skill_checks).toBe(3);
    expect(snapshot.skill_name).toBe("my-skill");
    expect(snapshot.baseline_pass_rate).toBe(0.8);
    expect(snapshot.window_sessions).toBe(20);
  });

  // 2. Regression detected when pass rate drops below threshold
  test("detects regression when pass rate below baseline minus threshold", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
    ];
    const queryRecords: QueryLogRecord[] = [
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
    ];
    const telemetry: SessionTelemetryRecord[] = [
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
    ];

    // pass_rate = 1/3, baseline = 0.8, threshold = 0.10
    // 0.33 < (0.8 - 0.10) = 0.7 => regression
    const snapshot = computeMonitoringSnapshot(
      "my-skill",
      telemetry,
      skillRecords,
      queryRecords,
      20,
      0.8,
    );

    expect(snapshot.regression_detected).toBe(true);
    expect(snapshot.pass_rate).toBeCloseTo(1 / 3, 2);
  });

  // 3. No regression when pass rate is within threshold
  test("no regression when pass rate within acceptable range", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
    ];
    const queryRecords: QueryLogRecord[] = [
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
    ];
    const telemetry: SessionTelemetryRecord[] = [
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
    ];

    // pass_rate = 4/4 = 1.0, baseline = 0.8, threshold = 0.10
    // 1.0 >= (0.8 - 0.10) = 0.7 => no regression
    const snapshot = computeMonitoringSnapshot(
      "my-skill",
      telemetry,
      skillRecords,
      queryRecords,
      20,
      0.8,
    );

    expect(snapshot.regression_detected).toBe(false);
    expect(snapshot.pass_rate).toBeCloseTo(1.0, 2);
  });

  // 4. Filters skill usage records by skill name
  test("filters skill usage records by skill name", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({
        skill_name: "other-skill",
        triggered: true,
      }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
    ];
    const queryRecords: QueryLogRecord[] = [
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
    ];
    const telemetry: SessionTelemetryRecord[] = [
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["other-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
    ];

    const snapshot = computeMonitoringSnapshot(
      "my-skill",
      telemetry,
      skillRecords,
      queryRecords,
      20,
      0.5,
    );

    // 2 triggered for "my-skill" out of 2 explicit skill checks = 1.0
    expect(snapshot.pass_rate).toBeCloseTo(1.0, 2);
  });

  // 5. Empty records produce pass rate of 0
  test("returns pass rate 0 when no skill checks exist", () => {
    const snapshot = computeMonitoringSnapshot("my-skill", [], [], [], 20, 0.8);

    expect(snapshot.pass_rate).toBe(0);
    expect(snapshot.skill_checks).toBe(0);
    expect(snapshot.regression_detected).toBe(false);
  });

  // 6. Window limiting - only considers last N sessions from telemetry
  test("limits telemetry to last windowSessions entries", () => {
    // Create 5 telemetry records but window is 3
    const telemetry: SessionTelemetryRecord[] = [
      makeTelemetryRecord({
        session_id: "old-1",
        skills_triggered: [],
        timestamp: "2026-02-28T10:00:00Z",
      }),
      makeTelemetryRecord({
        session_id: "old-2",
        skills_triggered: [],
        timestamp: "2026-02-28T11:00:00Z",
      }),
      makeTelemetryRecord({
        session_id: "recent-1",
        skills_triggered: ["my-skill"],
        timestamp: "2026-02-28T12:00:00Z",
      }),
      makeTelemetryRecord({
        session_id: "recent-2",
        skills_triggered: ["my-skill"],
        timestamp: "2026-02-28T13:00:00Z",
      }),
      makeTelemetryRecord({
        session_id: "recent-3",
        skills_triggered: ["my-skill"],
        timestamp: "2026-02-28T14:00:00Z",
      }),
    ];

    // Skill records matching the recent sessions
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({
        session_id: "recent-1",
        skill_name: "my-skill",
        triggered: true,
      }),
      makeSkillUsageRecord({
        session_id: "recent-2",
        skill_name: "my-skill",
        triggered: true,
      }),
      makeSkillUsageRecord({
        session_id: "recent-3",
        skill_name: "my-skill",
        triggered: true,
      }),
    ];

    // Query records matching the recent sessions
    const queryRecords: QueryLogRecord[] = [
      makeQueryLogRecord({ session_id: "old-1" }),
      makeQueryLogRecord({ session_id: "old-2" }),
      makeQueryLogRecord({ session_id: "recent-1" }),
      makeQueryLogRecord({ session_id: "recent-2" }),
      makeQueryLogRecord({ session_id: "recent-3" }),
    ];

    const snapshot = computeMonitoringSnapshot(
      "my-skill",
      telemetry,
      skillRecords,
      queryRecords,
      3, // window of 3
      0.8,
    );

    // Only 3 query records from the windowed sessions, all 3 triggered
    // pass_rate = 3/3 = 1.0
    expect(snapshot.pass_rate).toBeCloseTo(1.0, 2);
    expect(snapshot.window_sessions).toBe(3);
  });

  // 7. false_negative_rate calculation
  test("computes false negative rate from skill usage records", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
    ];
    const queryRecords: QueryLogRecord[] = [
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
    ];
    const telemetry: SessionTelemetryRecord[] = [];

    const snapshot = computeMonitoringSnapshot(
      "my-skill",
      telemetry,
      skillRecords,
      queryRecords,
      20,
      0.8,
    );

    // false negatives: 2 out of 4 skill usage records => 0.5
    expect(snapshot.false_negative_rate).toBeCloseTo(0.5, 2);
  });

  // 8. by_invocation_type defaults to implicit for MVP
  test("classifies all entries as implicit for MVP", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
    ];
    const queryRecords: QueryLogRecord[] = [makeQueryLogRecord(), makeQueryLogRecord()];
    const telemetry: SessionTelemetryRecord[] = [];

    const snapshot = computeMonitoringSnapshot(
      "my-skill",
      telemetry,
      skillRecords,
      queryRecords,
      20,
      0.8,
    );

    expect(snapshot.by_invocation_type.implicit).toBeDefined();
    expect(snapshot.by_invocation_type.implicit.passed).toBe(1);
    expect(snapshot.by_invocation_type.implicit.total).toBe(2);
  });

  // 9. Timestamp is ISO format
  test("snapshot timestamp is valid ISO string", () => {
    const snapshot = computeMonitoringSnapshot("my-skill", [], [], [], 20, 0.8);

    expect(snapshot.timestamp).toBeTruthy();
    const parsed = new Date(snapshot.timestamp);
    expect(parsed.toISOString()).toBe(snapshot.timestamp);
  });

  // 10. Regression boundary: exactly at threshold is NOT a regression
  test("pass rate exactly at threshold boundary is not a regression", () => {
    // baseline = 0.8, threshold = 0.10
    // acceptable minimum = 0.8 - 0.10 = 0.70
    // pass_rate = 7/10 = 0.70 => exactly at boundary => NOT regression
    const skillRecords: SkillUsageRecord[] = [
      ...Array.from({ length: 7 }, () =>
        makeSkillUsageRecord({
          skill_name: "my-skill",
          triggered: true,
        }),
      ),
      ...Array.from({ length: 3 }, () =>
        makeSkillUsageRecord({
          skill_name: "my-skill",
          triggered: false,
        }),
      ),
    ];
    const queryRecords: QueryLogRecord[] = Array.from({ length: 10 }, () => makeQueryLogRecord());

    const snapshot = computeMonitoringSnapshot("my-skill", [], skillRecords, queryRecords, 20, 0.8);

    expect(snapshot.pass_rate).toBeCloseTo(0.7, 2);
    expect(snapshot.regression_detected).toBe(false);
  });

  test("does not flag regression when sample count is below the minimum", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
    ];

    const snapshot = computeMonitoringSnapshot("my-skill", [], skillRecords, [], 20, 0.8);

    expect(snapshot.pass_rate).toBe(0);
    expect(snapshot.skill_checks).toBe(2);
    expect(snapshot.regression_detected).toBe(false);
  });

  test("flags zero-trigger regression when enough actionable queries exist", () => {
    const queryRecords: QueryLogRecord[] = Array.from({ length: 5 }, (_, index) =>
      makeQueryLogRecord({ session_id: `sess-zero-${index}` }),
    );
    const telemetry: SessionTelemetryRecord[] = Array.from({ length: 5 }, (_, index) =>
      makeTelemetryRecord({
        session_id: `sess-zero-${index}`,
        skills_triggered: [],
      }),
    );

    const snapshot = computeMonitoringSnapshot("my-skill", telemetry, [], queryRecords, 20, 0.8);

    expect(snapshot.pass_rate).toBe(0);
    expect(snapshot.skill_checks).toBe(0);
    expect(snapshot.regression_detected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// watch() integration tests with dependency injection
// ---------------------------------------------------------------------------

describe("watch", () => {
  // We test watch() by providing log file paths via injection.
  // The watch function reads from log files and computes the snapshot.

  // 11. No regression produces null alert and no rollback
  test("no regression produces null alert and no rollback", async () => {
    const skillRecords = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
    ];
    const queryRecords = [
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
    ];
    const telemetry = [
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
    ];
    // Audit log with a deployed entry that has eval_snapshot
    const auditEntries = [
      {
        timestamp: "2026-02-28T10:00:00Z",
        proposal_id: "evo-my-skill-001",
        action: "deployed" as const,
        details: "Deployed my-skill proposal",
        eval_snapshot: {
          total: 10,
          passed: 8,
          failed: 2,
          pass_rate: 0.8,
        },
      },
    ];

    const telemetryPath = writeJsonl(telemetry);
    const skillLogPath = writeJsonl(skillRecords);
    const queryLogPath = writeJsonl(queryRecords);
    const auditLogPath = writeJsonl(auditEntries);

    // Import the watch function with injectable paths
    const { watch } = await import("../../cli/selftune/monitoring/watch.js");

    const result: WatchResult = await watch({
      skillName: "my-skill",
      skillPath: "/tmp/skills/my-skill/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
    } as unknown as WatchOptions);

    expect(result.alert).toBeNull();
    expect(result.rolledBack).toBe(false);
    expect(result.snapshot.regression_detected).toBe(false);
    expect(result.recommendation).toBeTruthy();
  });

  // 12. Regression detected produces alert string
  test("regression detected produces alert string", async () => {
    const skillRecords = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
    ];
    const queryRecords = Array.from({ length: 10 }, () => makeQueryLogRecord());
    const telemetry = [makeTelemetryRecord({ skills_triggered: ["my-skill"] })];
    const auditEntries = [
      {
        timestamp: "2026-02-28T10:00:00Z",
        proposal_id: "evo-my-skill-001",
        action: "deployed" as const,
        details: "Deployed my-skill proposal",
        eval_snapshot: {
          total: 10,
          passed: 8,
          failed: 2,
          pass_rate: 0.8,
        },
      },
    ];

    const telemetryPath = writeJsonl(telemetry);
    const skillLogPath = writeJsonl(skillRecords);
    const queryLogPath = writeJsonl(queryRecords);
    const auditLogPath = writeJsonl(auditEntries);

    const { watch } = await import("../../cli/selftune/monitoring/watch.js");

    const result: WatchResult = await watch({
      skillName: "my-skill",
      skillPath: "/tmp/skills/my-skill/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
    } as unknown as WatchOptions);

    expect(result.alert).not.toBeNull();
    expect(result.alert).toContain("regression");
    expect(result.snapshot.regression_detected).toBe(true);
    expect(result.rolledBack).toBe(false);
  });

  // 13. Auto-rollback invoked when enabled and regression detected
  test("auto-rollback invoked when enabled and regression detected", async () => {
    const skillRecords = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
    ];
    const queryRecords = Array.from({ length: 10 }, () => makeQueryLogRecord());
    const telemetry = [makeTelemetryRecord({ skills_triggered: ["my-skill"] })];
    const auditEntries = [
      {
        timestamp: "2026-02-28T10:00:00Z",
        proposal_id: "evo-my-skill-001",
        action: "deployed" as const,
        details: "Deployed my-skill proposal",
        eval_snapshot: {
          total: 10,
          passed: 8,
          failed: 2,
          pass_rate: 0.8,
        },
      },
    ];

    const telemetryPath = writeJsonl(telemetry);
    const skillLogPath = writeJsonl(skillRecords);
    const queryLogPath = writeJsonl(queryRecords);
    const auditLogPath = writeJsonl(auditEntries);

    const { watch } = await import("../../cli/selftune/monitoring/watch.js");

    // Provide a mock rollback function via dependency injection
    let rollbackCalled = false;
    const mockRollback = async () => {
      rollbackCalled = true;
      return {
        rolledBack: true,
        restoredDescription: "Original description",
        reason: "Regression detected",
      };
    };

    const result: WatchResult = await watch({
      skillName: "my-skill",
      skillPath: "/tmp/skills/my-skill/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: true,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
      _rollbackFn: mockRollback,
    } as unknown as WatchOptions);

    expect(rollbackCalled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(result.alert).not.toBeNull();
  });

  // 14. Auto-rollback not invoked when disabled even with regression
  test("auto-rollback not invoked when disabled even with regression", async () => {
    const skillRecords = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
    ];
    const queryRecords = Array.from({ length: 10 }, () => makeQueryLogRecord());
    const telemetry = [makeTelemetryRecord({ skills_triggered: ["my-skill"] })];
    const auditEntries = [
      {
        timestamp: "2026-02-28T10:00:00Z",
        proposal_id: "evo-my-skill-001",
        action: "deployed" as const,
        details: "Deployed my-skill proposal",
        eval_snapshot: {
          total: 10,
          passed: 8,
          failed: 2,
          pass_rate: 0.8,
        },
      },
    ];

    const telemetryPath = writeJsonl(telemetry);
    const skillLogPath = writeJsonl(skillRecords);
    const queryLogPath = writeJsonl(queryRecords);
    const auditLogPath = writeJsonl(auditEntries);

    const { watch } = await import("../../cli/selftune/monitoring/watch.js");

    let rollbackCalled = false;
    const mockRollback = async () => {
      rollbackCalled = true;
      return {
        rolledBack: true,
        restoredDescription: "Original description",
        reason: "Regression detected",
      };
    };

    const result: WatchResult = await watch({
      skillName: "my-skill",
      skillPath: "/tmp/skills/my-skill/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
      _rollbackFn: mockRollback,
    } as unknown as WatchOptions);

    expect(rollbackCalled).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.alert).not.toBeNull();
    expect(result.snapshot.regression_detected).toBe(true);
  });

  // 15. Uses default baseline of 0.5 when no audit entry with eval_snapshot
  test("uses default baseline when no deployed audit entry exists", async () => {
    const skillRecords = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
    ];
    const queryRecords = [
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
    ];
    const telemetry = [
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
    ];
    // Empty audit log
    const auditEntries: unknown[] = [];

    const telemetryPath = writeJsonl(telemetry);
    const skillLogPath = writeJsonl(skillRecords);
    const queryLogPath = writeJsonl(queryRecords);
    const auditLogPath = writeJsonl(auditEntries);

    const { watch } = await import("../../cli/selftune/monitoring/watch.js");

    const result: WatchResult = await watch({
      skillName: "my-skill",
      skillPath: "/tmp/skills/my-skill/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
    } as unknown as WatchOptions);

    // pass_rate = 2/2 = 1.0, default baseline = 0.5
    // 1.0 >= (0.5 - 0.1) = 0.4 => no regression
    expect(result.snapshot.baseline_pass_rate).toBe(0.5);
    expect(result.snapshot.regression_detected).toBe(false);
  });

  // 16. Recommendation text varies by scenario
  test("recommendation suggests rollback when regression detected", async () => {
    const skillRecords = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: false }),
    ];
    const queryRecords = Array.from({ length: 10 }, () => makeQueryLogRecord());
    const telemetry = [makeTelemetryRecord({ skills_triggered: ["my-skill"] })];
    const auditEntries = [
      {
        timestamp: "2026-02-28T10:00:00Z",
        proposal_id: "evo-my-skill-001",
        action: "deployed" as const,
        details: "Deployed my-skill proposal",
        eval_snapshot: {
          total: 10,
          passed: 8,
          failed: 2,
          pass_rate: 0.8,
        },
      },
    ];

    const telemetryPath = writeJsonl(telemetry);
    const skillLogPath = writeJsonl(skillRecords);
    const queryLogPath = writeJsonl(queryRecords);
    const auditLogPath = writeJsonl(auditEntries);

    const { watch } = await import("../../cli/selftune/monitoring/watch.js");

    const result: WatchResult = await watch({
      skillName: "my-skill",
      skillPath: "/tmp/skills/my-skill/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
    } as unknown as WatchOptions);

    expect(result.recommendation.toLowerCase()).toContain("rollback");
  });

  test("recommendation says stable when no regression", async () => {
    const skillRecords = [
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
      makeSkillUsageRecord({ skill_name: "my-skill", triggered: true }),
    ];
    const queryRecords = [
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
      makeQueryLogRecord(),
    ];
    const telemetry = [
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
      makeTelemetryRecord({ skills_triggered: ["my-skill"] }),
    ];
    const auditEntries = [
      {
        timestamp: "2026-02-28T10:00:00Z",
        proposal_id: "evo-my-skill-001",
        action: "deployed" as const,
        details: "Deployed my-skill proposal",
        eval_snapshot: {
          total: 10,
          passed: 8,
          failed: 2,
          pass_rate: 0.8,
        },
      },
    ];

    const telemetryPath = writeJsonl(telemetry);
    const skillLogPath = writeJsonl(skillRecords);
    const queryLogPath = writeJsonl(queryRecords);
    const auditLogPath = writeJsonl(auditEntries);

    const { watch } = await import("../../cli/selftune/monitoring/watch.js");

    const result: WatchResult = await watch({
      skillName: "my-skill",
      skillPath: "/tmp/skills/my-skill/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
    } as unknown as WatchOptions);

    expect(result.recommendation.toLowerCase()).toContain("stable");
  });

  test("recommendation reports insufficient data below the minimum sample gate", async () => {
    const skillRecords = [makeSkillUsageRecord({ skill_name: "my-skill", triggered: false })];
    const queryRecords = [makeQueryLogRecord()];
    const telemetry = [makeTelemetryRecord({ skills_triggered: ["my-skill"] })];
    const auditEntries = [
      {
        timestamp: "2026-02-28T10:00:00Z",
        proposal_id: "evo-my-skill-001",
        action: "deployed" as const,
        details: "Deployed my-skill proposal",
        eval_snapshot: {
          total: 10,
          passed: 8,
          failed: 2,
          pass_rate: 0.8,
        },
      },
    ];

    const telemetryPath = writeJsonl(telemetry);
    const skillLogPath = writeJsonl(skillRecords);
    const queryLogPath = writeJsonl(queryRecords);
    const auditLogPath = writeJsonl(auditEntries);

    const { watch } = await import("../../cli/selftune/monitoring/watch.js");

    const result: WatchResult = await watch({
      skillName: "my-skill",
      skillPath: "/tmp/skills/my-skill/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
    } as unknown as WatchOptions);

    expect(result.snapshot.regression_detected).toBe(false);
    expect(result.recommendation.toLowerCase()).toContain("need at least");
  });

  test("sync-first refreshes source truth before reading watch inputs", async () => {
    const sessionIds = ["sess-sync-0", "sess-sync-1", "sess-sync-2"];
    const telemetryPath = writeJsonl(
      sessionIds.map((sid) => makeTelemetryRecord({ session_id: sid })),
    );
    const skillLogPath = writeJsonl(
      sessionIds.map((sid, index) =>
        makeSkillUsageRecord({
          session_id: sid,
          skill_name: "my-skill",
          triggered: index < 2,
        }),
      ),
    );
    const queryLogPath = writeJsonl(
      sessionIds.map((sid) => makeQueryLogRecord({ session_id: sid })),
    );

    const syncMock = mock(() => ({
      since: null,
      dry_run: false,
      sources: {
        claude: { available: true, scanned: 3, synced: 2, skipped: 0 },
        codex: { available: true, scanned: 1, synced: 1, skipped: 0 },
        opencode: { available: false, scanned: 0, synced: 0, skipped: 0 },
        openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
      },
      repair: {
        ran: true,
        repaired_sessions: 2,
        repaired_records: 3,
        codex_repaired_records: 1,
      },
    }));

    const { watch } = await import("../../cli/selftune/monitoring/watch.js");

    const result: WatchResult = await watch({
      skillName: "my-skill",
      skillPath: "/tmp/skills/my-skill/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      syncFirst: true,
      syncForce: true,
      _syncFn: syncMock,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
    } as WatchOptions);

    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock.mock.calls[0]?.[0]).toMatchObject({
      force: true,
      dryRun: false,
      syncClaude: true,
      syncCodex: true,
      rebuildSkillUsage: true,
    });
    expect(result.sync_result?.repair.repaired_records).toBe(3);
  });
});
