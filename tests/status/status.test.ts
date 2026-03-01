/**
 * Tests for selftune status command (computeStatus pure function).
 *
 * Validates skill health summaries, trend detection, unmatched queries,
 * and pending proposals aggregation.
 */

import { describe, expect, test } from "bun:test";
import { computeStatus } from "../../cli/selftune/status.js";
import type {
  DoctorResult,
  EvolutionAuditEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeTelemetry(overrides: Partial<SessionTelemetryRecord> = {}): SessionTelemetryRecord {
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

function makeSkillRecord(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
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

function makeQuery(overrides: Partial<QueryLogRecord> = {}): QueryLogRecord {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    query: "test query",
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<EvolutionAuditEntry> = {}): EvolutionAuditEntry {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    proposal_id: "evo-001",
    action: "created",
    details: "Created proposal for test-skill",
    ...overrides,
  };
}

function makeDoctorResult(overrides: Partial<DoctorResult> = {}): DoctorResult {
  return {
    command: "doctor",
    timestamp: "2026-02-28T12:00:00Z",
    checks: [
      { name: "config", path: "/tmp/config.json", status: "pass", message: "OK" },
      { name: "log_telemetry", path: "/tmp/telemetry.jsonl", status: "pass", message: "OK" },
      { name: "log_skill", path: "/tmp/skill.jsonl", status: "pass", message: "OK" },
      { name: "log_query", path: "/tmp/query.jsonl", status: "pass", message: "OK" },
      { name: "hook_prompt", path: "/tmp/hook1", status: "pass", message: "OK" },
      { name: "hook_session", path: "/tmp/hook2", status: "pass", message: "OK" },
      { name: "hook_skill", path: "/tmp/hook3", status: "pass", message: "OK" },
      { name: "hook_settings", path: "/tmp/settings", status: "pass", message: "OK" },
      { name: "evolution", path: "/tmp/evolution.jsonl", status: "pass", message: "OK" },
    ],
    summary: { pass: 9, fail: 0, warn: 0, total: 9 },
    healthy: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeStatus tests
// ---------------------------------------------------------------------------

describe("computeStatus", () => {
  test("healthy skill with pass rate above baseline", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid, skills_triggered: ["my-skill"] })];
    const skillRecords = [
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: true }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: true }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: true }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: true }),
    ];
    const queryRecords = [
      makeQuery({ session_id: sid }),
      makeQuery({ session_id: sid }),
      makeQuery({ session_id: sid }),
      makeQuery({ session_id: sid }),
      makeQuery({ session_id: sid }),
    ];

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    expect(result.skills.length).toBe(1);
    expect(result.skills[0].name).toBe("my-skill");
    expect(result.skills[0].passRate).toBeCloseTo(0.8, 2);
    expect(result.skills[0].status).toBe("HEALTHY");
  });

  test("regressed skill with pass rate below baseline minus threshold", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid, skills_triggered: ["my-skill"] })];
    const skillRecords = [
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: true }),
    ];
    const queryRecords = Array.from({ length: 10 }, () => makeQuery({ session_id: sid }));
    const auditEntries = [
      makeAuditEntry({
        action: "deployed",
        details: "Deployed my-skill proposal",
        eval_snapshot: { total: 10, passed: 8, failed: 2, pass_rate: 0.8 },
      }),
    ];

    const result = computeStatus(
      telemetry,
      skillRecords,
      queryRecords,
      auditEntries,
      makeDoctorResult(),
    );

    expect(result.skills.length).toBe(1);
    expect(result.skills[0].status).toBe("REGRESSED");
  });

  test("no data skill shows NO DATA status", () => {
    const telemetry = [makeTelemetry({ skills_triggered: ["empty-skill"] })];
    const skillRecords = [
      makeSkillRecord({ skill_name: "empty-skill", triggered: false, query: "unused" }),
    ];
    // No query records match, no triggered records
    const queryRecords: QueryLogRecord[] = [];

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    const skill = result.skills.find((s) => s.name === "empty-skill");
    expect(skill).toBeDefined();
    expect(skill!.status).toBe("NO DATA");
  });

  test("empty logs produce empty skills list", () => {
    const result = computeStatus([], [], [], [], makeDoctorResult());

    expect(result.skills).toEqual([]);
    expect(result.unmatchedQueries).toBe(0);
    expect(result.pendingProposals).toBe(0);
  });

  test("detects unmatched queries", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid })];
    const skillRecords = [
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: true,
        query: "matched query",
      }),
    ];
    const queryRecords = [
      makeQuery({ session_id: sid, query: "matched query" }),
      makeQuery({ session_id: sid, query: "unmatched query 1" }),
      makeQuery({ session_id: sid, query: "unmatched query 2" }),
    ];

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    expect(result.unmatchedQueries).toBe(2);
  });

  test("detects pending proposals", () => {
    const auditEntries = [
      makeAuditEntry({ proposal_id: "evo-001", action: "created", details: "skill-a proposal" }),
      makeAuditEntry({
        proposal_id: "evo-001",
        action: "validated",
        details: "skill-a proposal",
      }),
      // evo-001 has no deployed/rejected/rolled_back => pending
      makeAuditEntry({ proposal_id: "evo-002", action: "created", details: "skill-b proposal" }),
      makeAuditEntry({ proposal_id: "evo-002", action: "deployed", details: "skill-b proposal" }),
      // evo-002 was deployed => not pending
      makeAuditEntry({ proposal_id: "evo-003", action: "created", details: "skill-c proposal" }),
      // evo-003 has no terminal action => pending
    ];

    const result = computeStatus([], [], [], auditEntries, makeDoctorResult());

    expect(result.pendingProposals).toBe(2);
  });

  test("trend detection: up when second half is better", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid, skills_triggered: ["my-skill"] })];
    // First half: mostly not triggered, second half: mostly triggered
    const skillRecords = [
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: false,
        timestamp: "2026-02-20T01:00:00Z",
      }),
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: false,
        timestamp: "2026-02-21T01:00:00Z",
      }),
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: true,
        timestamp: "2026-02-25T01:00:00Z",
      }),
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: true,
        timestamp: "2026-02-26T01:00:00Z",
      }),
    ];
    const queryRecords = Array.from({ length: 4 }, () => makeQuery({ session_id: sid }));

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    expect(result.skills[0].trend).toBe("up");
  });

  test("trend detection: down when second half is worse", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid, skills_triggered: ["my-skill"] })];
    // First half: mostly triggered, second half: mostly not triggered
    const skillRecords = [
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: true,
        timestamp: "2026-02-20T01:00:00Z",
      }),
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: true,
        timestamp: "2026-02-21T01:00:00Z",
      }),
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: false,
        timestamp: "2026-02-25T01:00:00Z",
      }),
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: false,
        timestamp: "2026-02-26T01:00:00Z",
      }),
    ];
    const queryRecords = Array.from({ length: 4 }, () => makeQuery({ session_id: sid }));

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    expect(result.skills[0].trend).toBe("down");
  });

  test("trend detection: stable when halves are equal", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid, skills_triggered: ["my-skill"] })];
    const skillRecords = [
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: true,
        timestamp: "2026-02-20T01:00:00Z",
      }),
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: false,
        timestamp: "2026-02-21T01:00:00Z",
      }),
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: true,
        timestamp: "2026-02-25T01:00:00Z",
      }),
      makeSkillRecord({
        session_id: sid,
        skill_name: "my-skill",
        triggered: false,
        timestamp: "2026-02-26T01:00:00Z",
      }),
    ];
    const queryRecords = Array.from({ length: 4 }, () => makeQuery({ session_id: sid }));

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    expect(result.skills[0].trend).toBe("stable");
  });

  test("system health reflects doctor result", () => {
    const doctorResult = makeDoctorResult({
      summary: { pass: 7, fail: 1, warn: 2, total: 10 },
      healthy: false,
    });

    const result = computeStatus([], [], [], [], doctorResult);

    expect(result.system.healthy).toBe(false);
    expect(result.system.pass).toBe(7);
    expect(result.system.fail).toBe(1);
    expect(result.system.warn).toBe(2);
  });

  test("lastSession returns most recent telemetry timestamp", () => {
    const telemetry = [
      makeTelemetry({ timestamp: "2026-02-27T10:00:00Z" }),
      makeTelemetry({ timestamp: "2026-02-28T14:32:00Z" }),
      makeTelemetry({ timestamp: "2026-02-26T08:00:00Z" }),
    ];

    const result = computeStatus(telemetry, [], [], [], makeDoctorResult());

    expect(result.lastSession).toBe("2026-02-28T14:32:00Z");
  });

  test("lastSession is null when no telemetry exists", () => {
    const result = computeStatus([], [], [], [], makeDoctorResult());
    expect(result.lastSession).toBeNull();
  });

  test("multiple skills each get independent status", () => {
    const sid = "sess-1";
    const telemetry = [
      makeTelemetry({ session_id: sid, skills_triggered: ["skill-a", "skill-b"] }),
    ];
    const skillRecords = [
      makeSkillRecord({ session_id: sid, skill_name: "skill-a", triggered: true }),
      makeSkillRecord({ session_id: sid, skill_name: "skill-a", triggered: true }),
      makeSkillRecord({ session_id: sid, skill_name: "skill-b", triggered: true }),
      makeSkillRecord({ session_id: sid, skill_name: "skill-b", triggered: false }),
    ];
    const queryRecords = [
      makeQuery({ session_id: sid }),
      makeQuery({ session_id: sid }),
      makeQuery({ session_id: sid }),
      makeQuery({ session_id: sid }),
    ];

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    expect(result.skills.length).toBe(2);
    const skillA = result.skills.find((s) => s.name === "skill-a");
    const skillB = result.skills.find((s) => s.name === "skill-b");
    expect(skillA).toBeDefined();
    expect(skillB).toBeDefined();
  });
});
