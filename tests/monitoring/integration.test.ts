/**
 * E2E integration tests for post-deploy monitoring (TASK-18).
 *
 * Tests computeMonitoringSnapshot as a pure function with realistic
 * multi-session data spanning regression and improvement scenarios.
 *
 * Does NOT use mock.module() to avoid global state leakage. Uses
 * dependency injection for watch() via injected log file paths.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatchOptions, WatchResult } from "../../cli/selftune/monitoring/watch.js";
import { computeMonitoringSnapshot, watch } from "../../cli/selftune/monitoring/watch.js";
import type {
  EvolutionAuditEntry,
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
    skill_name: "doc-gen",
    skill_path: "/tmp/skills/doc-gen/SKILL.md",
    query: "generate a document",
    triggered: true,
    ...overrides,
  };
}

function makeQueryLogRecord(overrides: Partial<QueryLogRecord> = {}): QueryLogRecord {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    query: "some query",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-monitoring-integ-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl<T>(records: T[], filename?: string): string {
  const filePath = join(tmpDir, filename ?? `log-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  const content = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// E2E: Regression detection across realistic multi-session data
// ---------------------------------------------------------------------------

describe("integration: regression detection with multi-session data", () => {
  test("detects regression when skill performance degrades across multiple sessions", () => {
    // Simulate 10 sessions where the skill only triggered in 1
    // This represents a severe regression from a baseline of 0.8
    const sessionIds = Array.from({ length: 10 }, (_, i) => `sess-regression-${i}`);

    const telemetry: SessionTelemetryRecord[] = sessionIds.map((sid, i) =>
      makeTelemetryRecord({
        session_id: sid,
        timestamp: `2026-02-28T${String(12 + i).padStart(2, "0")}:00:00Z`,
        skills_triggered: i === 0 ? ["doc-gen"] : [],
      }),
    );

    // Only 1 out of 10 sessions triggered the skill
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({
        session_id: sessionIds[0],
        skill_name: "doc-gen",
        triggered: true,
      }),
      ...sessionIds.slice(1).map((sid) =>
        makeSkillUsageRecord({
          session_id: sid,
          skill_name: "doc-gen",
          triggered: false,
        }),
      ),
    ];

    // Every session had a query
    const queryRecords: QueryLogRecord[] = sessionIds.map((sid) =>
      makeQueryLogRecord({ session_id: sid }),
    );

    const snapshot = computeMonitoringSnapshot(
      "doc-gen",
      telemetry,
      skillRecords,
      queryRecords,
      20, // window covers all 10 sessions
      0.8, // baseline from last deploy
      0.1, // threshold
    );

    // pass_rate = 1/10 = 0.1, which is below 0.8 - 0.1 = 0.7
    expect(snapshot.regression_detected).toBe(true);
    expect(snapshot.pass_rate).toBeCloseTo(0.1, 2);
    expect(snapshot.baseline_pass_rate).toBe(0.8);
    expect(snapshot.skill_name).toBe("doc-gen");
    expect(snapshot.false_negative_rate).toBeCloseTo(0.9, 2); // 9 out of 10 not triggered
  });

  test("no regression when performance improves across sessions", () => {
    // Simulate 10 sessions where the skill triggers in 9 (improvement over 0.8 baseline)
    const sessionIds = Array.from({ length: 10 }, (_, i) => `sess-improve-${i}`);

    const telemetry: SessionTelemetryRecord[] = sessionIds.map((sid) =>
      makeTelemetryRecord({
        session_id: sid,
        skills_triggered: ["doc-gen"],
      }),
    );

    // 9 out of 10 triggered
    const skillRecords: SkillUsageRecord[] = sessionIds.map((sid, i) =>
      makeSkillUsageRecord({
        session_id: sid,
        skill_name: "doc-gen",
        triggered: i < 9,
      }),
    );

    const queryRecords: QueryLogRecord[] = sessionIds.map((sid) =>
      makeQueryLogRecord({ session_id: sid }),
    );

    const snapshot = computeMonitoringSnapshot(
      "doc-gen",
      telemetry,
      skillRecords,
      queryRecords,
      20,
      0.8,
      0.1,
    );

    // pass_rate = 9/10 = 0.9, which is above 0.8 - 0.1 = 0.7
    expect(snapshot.regression_detected).toBe(false);
    expect(snapshot.pass_rate).toBeCloseTo(0.9, 2);
  });

  test("handles mixed skill data and filters correctly by skill name", () => {
    const sessionId = "sess-mixed-001";

    const telemetry: SessionTelemetryRecord[] = [
      makeTelemetryRecord({
        session_id: sessionId,
        skills_triggered: ["doc-gen", "code-review"],
      }),
    ];

    // Multiple skills in the same session
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({
        session_id: sessionId,
        skill_name: "doc-gen",
        triggered: true,
      }),
      makeSkillUsageRecord({
        session_id: sessionId,
        skill_name: "code-review",
        triggered: true,
      }),
      makeSkillUsageRecord({
        session_id: sessionId,
        skill_name: "doc-gen",
        triggered: false,
      }),
    ];

    const queryRecords: QueryLogRecord[] = [
      makeQueryLogRecord({ session_id: sessionId }),
      makeQueryLogRecord({ session_id: sessionId }),
      makeQueryLogRecord({ session_id: sessionId }),
    ];

    const snapshot = computeMonitoringSnapshot(
      "doc-gen",
      telemetry,
      skillRecords,
      queryRecords,
      20,
      0.8,
      0.1,
    );

    // Only doc-gen records: 1 triggered out of 2 total skill checks
    // pass_rate = 1 triggered / 3 total queries = 0.333
    expect(snapshot.pass_rate).toBeCloseTo(1 / 3, 2);
    // false_negative_rate: 1 not-triggered / 2 doc-gen checks = 0.5
    expect(snapshot.false_negative_rate).toBeCloseTo(0.5, 2);
  });
});

// ---------------------------------------------------------------------------
// E2E: Windowing across session boundaries
// ---------------------------------------------------------------------------

describe("integration: session windowing across chronological data", () => {
  test("windowed snapshot only considers recent sessions", () => {
    // 20 sessions total, window of 5
    // Old sessions: skill performed poorly (0/10 triggered)
    // Recent sessions: skill performs well (5/5 triggered)
    const oldSessionIds = Array.from({ length: 15 }, (_, i) => `sess-old-${i}`);
    const recentSessionIds = Array.from({ length: 5 }, (_, i) => `sess-recent-${i}`);

    const telemetry: SessionTelemetryRecord[] = [
      ...oldSessionIds.map((sid) => makeTelemetryRecord({ session_id: sid })),
      ...recentSessionIds.map((sid) =>
        makeTelemetryRecord({
          session_id: sid,
          skills_triggered: ["doc-gen"],
        }),
      ),
    ];

    // Old sessions: no triggers
    const oldSkillRecords = oldSessionIds.map((sid) =>
      makeSkillUsageRecord({
        session_id: sid,
        skill_name: "doc-gen",
        triggered: false,
      }),
    );

    // Recent sessions: all triggered
    const recentSkillRecords = recentSessionIds.map((sid) =>
      makeSkillUsageRecord({
        session_id: sid,
        skill_name: "doc-gen",
        triggered: true,
      }),
    );

    const allSkillRecords = [...oldSkillRecords, ...recentSkillRecords];

    // Queries across all sessions
    const queryRecords: QueryLogRecord[] = [
      ...oldSessionIds.map((sid) => makeQueryLogRecord({ session_id: sid })),
      ...recentSessionIds.map((sid) => makeQueryLogRecord({ session_id: sid })),
    ];

    // Window of 5: should only see the recent 5 sessions
    const snapshot = computeMonitoringSnapshot(
      "doc-gen",
      telemetry,
      allSkillRecords,
      queryRecords,
      5, // window
      0.5,
      0.1,
    );

    // Within the window: 5 triggered / 5 queries = 1.0
    expect(snapshot.pass_rate).toBeCloseTo(1.0, 2);
    expect(snapshot.regression_detected).toBe(false);
    expect(snapshot.window_sessions).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// E2E: watch() with file-based log injection
// ---------------------------------------------------------------------------

describe("integration: watch() reads JSONL logs and computes result", () => {
  test("watch detects regression from file-based logs and generates alert", async () => {
    const sessionIds = Array.from({ length: 10 }, (_, i) => `sess-watch-${i}`);

    // Telemetry: 10 sessions
    const telemetry = sessionIds.map((sid) => makeTelemetryRecord({ session_id: sid }));

    // Skill records: only 1 triggered out of 10
    const skillRecords = [
      makeSkillUsageRecord({
        session_id: sessionIds[0],
        skill_name: "doc-gen",
        triggered: true,
      }),
    ];

    // Query records: 10 queries
    const queryRecords = sessionIds.map((sid) => makeQueryLogRecord({ session_id: sid }));

    // Audit log: deployed with 0.8 pass rate baseline
    const auditEntries: EvolutionAuditEntry[] = [
      {
        timestamp: "2026-02-28T10:00:00Z",
        proposal_id: "evo-doc-gen-001",
        action: "deployed",
        details: "Deployed doc-gen proposal",
        eval_snapshot: { total: 20, passed: 16, failed: 4, pass_rate: 0.8 },
      },
    ];

    const telemetryPath = writeJsonl(telemetry, "telemetry.jsonl");
    const skillLogPath = writeJsonl(skillRecords, "skill_usage.jsonl");
    const queryLogPath = writeJsonl(queryRecords, "all_queries.jsonl");
    const auditLogPath = writeJsonl(auditEntries, "audit.jsonl");

    const result: WatchResult = await watch({
      skillName: "doc-gen",
      skillPath: "/tmp/skills/doc-gen/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
    } as unknown as WatchOptions);

    // Regression should be detected
    expect(result.snapshot.regression_detected).toBe(true);
    expect(result.alert).not.toBeNull();
    expect(result.alert).toContain("regression");
    expect(result.rolledBack).toBe(false);
    expect(result.recommendation).toBeTruthy();
  });

  test("watch reports stable when performance is within range", async () => {
    const sessionIds = Array.from({ length: 5 }, (_, i) => `sess-stable-${i}`);

    const telemetry = sessionIds.map((sid) =>
      makeTelemetryRecord({ session_id: sid, skills_triggered: ["doc-gen"] }),
    );

    // 4 out of 5 triggered = 0.8 pass rate
    const skillRecords = sessionIds.slice(0, 4).map((sid) =>
      makeSkillUsageRecord({
        session_id: sid,
        skill_name: "doc-gen",
        triggered: true,
      }),
    );

    const queryRecords = sessionIds.map((sid) => makeQueryLogRecord({ session_id: sid }));

    const auditEntries: EvolutionAuditEntry[] = [
      {
        timestamp: "2026-02-28T10:00:00Z",
        proposal_id: "evo-doc-gen-001",
        action: "deployed",
        details: "Deployed doc-gen proposal",
        eval_snapshot: { total: 20, passed: 16, failed: 4, pass_rate: 0.8 },
      },
    ];

    const telemetryPath = writeJsonl(telemetry, "stable-telemetry.jsonl");
    const skillLogPath = writeJsonl(skillRecords, "stable-skill.jsonl");
    const queryLogPath = writeJsonl(queryRecords, "stable-queries.jsonl");
    const auditLogPath = writeJsonl(auditEntries, "stable-audit.jsonl");

    const result: WatchResult = await watch({
      skillName: "doc-gen",
      skillPath: "/tmp/skills/doc-gen/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
    } as unknown as WatchOptions);

    // No regression: 0.8 >= 0.8 - 0.1 = 0.7
    expect(result.snapshot.regression_detected).toBe(false);
    expect(result.alert).toBeNull();
    expect(result.rolledBack).toBe(false);
    expect(result.recommendation.toLowerCase()).toContain("stable");
  });

  test("watch with auto-rollback triggers rollback on regression", async () => {
    const sessionIds = Array.from({ length: 10 }, (_, i) => `sess-autoroll-${i}`);

    const telemetry = sessionIds.map((sid) => makeTelemetryRecord({ session_id: sid }));

    // Only 1 triggered = severe regression
    const skillRecords = [
      makeSkillUsageRecord({
        session_id: sessionIds[0],
        skill_name: "doc-gen",
        triggered: true,
      }),
    ];

    const queryRecords = sessionIds.map((sid) => makeQueryLogRecord({ session_id: sid }));

    const auditEntries: EvolutionAuditEntry[] = [
      {
        timestamp: "2026-02-28T10:00:00Z",
        proposal_id: "evo-doc-gen-002",
        action: "deployed",
        details: "Deployed doc-gen proposal",
        eval_snapshot: { total: 20, passed: 16, failed: 4, pass_rate: 0.8 },
      },
    ];

    const telemetryPath = writeJsonl(telemetry, "autoroll-telemetry.jsonl");
    const skillLogPath = writeJsonl(skillRecords, "autoroll-skill.jsonl");
    const queryLogPath = writeJsonl(queryRecords, "autoroll-queries.jsonl");
    const auditLogPath = writeJsonl(auditEntries, "autoroll-audit.jsonl");

    // Track rollback invocation via dependency injection
    let rollbackCalledWith: Record<string, unknown> | null = null;
    const mockRollback = async (opts: {
      skillName: string;
      skillPath: string;
      proposalId?: string;
    }) => {
      rollbackCalledWith = opts;
      return {
        rolledBack: true,
        restoredDescription: "Original doc-gen description",
        reason: "Auto-rollback triggered by regression",
      };
    };

    const result: WatchResult = await watch({
      skillName: "doc-gen",
      skillPath: "/tmp/skills/doc-gen/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: true,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
      _rollbackFn: mockRollback,
    } as unknown as WatchOptions);

    // Regression detected and rollback invoked
    expect(result.snapshot.regression_detected).toBe(true);
    expect(result.alert).not.toBeNull();
    expect(result.rolledBack).toBe(true);
    expect(rollbackCalledWith).not.toBeNull();
    expect((rollbackCalledWith as Record<string, unknown>).skillName).toBe("doc-gen");
    expect(result.recommendation.toLowerCase()).toContain("rolled back");
  });
});

// ---------------------------------------------------------------------------
// E2E: Snapshot computation edge cases
// ---------------------------------------------------------------------------

describe("integration: snapshot edge cases with realistic data", () => {
  test("empty logs produce safe defaults", () => {
    const snapshot = computeMonitoringSnapshot("doc-gen", [], [], [], 20, 0.8, 0.1);

    expect(snapshot.pass_rate).toBe(1.0);
    expect(snapshot.false_negative_rate).toBe(0);
    expect(snapshot.regression_detected).toBe(false);
    expect(snapshot.skill_name).toBe("doc-gen");
    expect(snapshot.window_sessions).toBe(20);
  });

  test("boundary: pass rate exactly at threshold is NOT regression", () => {
    // baseline 0.8, threshold 0.1 => minimum acceptable = 0.7
    // 7 triggered out of 10 queries = 0.7 exactly
    const sessionId = "sess-boundary";

    const telemetry = [makeTelemetryRecord({ session_id: sessionId })];

    const skillRecords = Array.from({ length: 7 }, () =>
      makeSkillUsageRecord({
        session_id: sessionId,
        skill_name: "doc-gen",
        triggered: true,
      }),
    );

    const queryRecords = Array.from({ length: 10 }, () =>
      makeQueryLogRecord({ session_id: sessionId }),
    );

    const snapshot = computeMonitoringSnapshot(
      "doc-gen",
      telemetry,
      skillRecords,
      queryRecords,
      20,
      0.8,
      0.1,
    );

    expect(snapshot.pass_rate).toBeCloseTo(0.7, 2);
    expect(snapshot.regression_detected).toBe(false);
  });

  test("snapshot timestamp is valid ISO 8601", () => {
    const snapshot = computeMonitoringSnapshot("doc-gen", [], [], [], 20, 0.8, 0.1);

    expect(snapshot.timestamp).toBeTruthy();
    const parsed = new Date(snapshot.timestamp);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.toISOString()).toBe(snapshot.timestamp);
  });
});
