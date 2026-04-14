/**
 * Tests for selftune status command (computeStatus pure function).
 *
 * Validates skill health summaries, trend detection, unmatched queries,
 * and pending proposals aggregation.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { computeStatus, formatStatus, formatStatusSummary } from "../../cli/selftune/status.js";
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

let fixtureCounter = 0;

beforeEach(() => {
  fixtureCounter = 0;
});

function makeTelemetry(overrides: Partial<SessionTelemetryRecord> = {}): SessionTelemetryRecord {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    session_id: `sess-${++fixtureCounter}`,
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
    session_id: `sess-${++fixtureCounter}`,
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
    session_id: `sess-${++fixtureCounter}`,
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
    expect(result.skills[0].passRate).toBeCloseTo(1.0, 2);
    expect(result.skills[0].status).toBe("HEALTHY");
  });

  test("critical skill with regression detected", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid, skills_triggered: ["my-skill"] })];
    const skillRecords = [
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: true }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: false }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: false }),
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
    expect(result.skills[0].status).toBe("CRITICAL");
  });

  test("critical skill with pass rate below 0.4", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid, skills_triggered: ["my-skill"] })];
    const skillRecords = [
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: true }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: false }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: false }),
    ];
    // 1 triggered out of 3 skill checks = 0.33 pass rate
    const queryRecords = Array.from({ length: 10 }, () => makeQuery({ session_id: sid }));

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    expect(result.skills.length).toBe(1);
    expect(result.skills[0].status).toBe("CRITICAL");
    expect(result.skills[0].passRate).toBeLessThan(0.4);
  });

  test("warning skill with pass rate between 0.4 and 0.7", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid, skills_triggered: ["my-skill"] })];
    // 2 triggered out of 3 skill checks = 0.67 pass rate
    const skillRecords = [
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: true }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: true }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: false }),
    ];
    const queryRecords = Array.from({ length: 5 }, () => makeQuery({ session_id: sid }));

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    expect(result.skills.length).toBe(1);
    expect(result.skills[0].status).toBe("WARNING");
    expect(result.skills[0].passRate).toBeGreaterThanOrEqual(0.4);
    expect(result.skills[0].passRate).toBeLessThan(0.7);
  });

  test("ungraded status when skill has records but no triggered sessions", () => {
    const telemetry = [makeTelemetry({ skills_triggered: ["empty-skill"] })];
    const skillRecords = [
      makeSkillRecord({ skill_name: "empty-skill", triggered: false, query: "unused" }),
    ];
    // No query records match, no triggered records
    const queryRecords: QueryLogRecord[] = [];

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    const skill = result.skills.find((s) => s.name === "empty-skill");
    expect(skill).toBeDefined();
    expect(skill?.status).toBe("UNGRADED");
    expect(skill?.passRate).toBe(0);
  });

  test("ungraded status when queries exist globally but skill has no triggered records", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid, skills_triggered: [] })];
    const skillRecords = [
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: false }),
    ];
    // Many global queries exist but none are graded for this skill
    const queryRecords = Array.from({ length: 100 }, () => makeQuery({ session_id: sid }));

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    const skill = result.skills.find((s) => s.name === "my-skill");
    expect(skill).toBeDefined();
    expect(skill?.status).toBe("UNGRADED");
    expect(skill?.passRate).toBe(0);
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

  test("ignores non-user query payloads when counting unmatched queries", () => {
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
      makeQuery({ session_id: sid, query: "<system_instruction> internal prompt" }),
      makeQuery({ session_id: sid, query: "<local-command-stdout> noisy shell output" }),
      makeQuery({ session_id: sid, query: "unmatched query" }),
    ];

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    expect(result.unmatchedQueries).toBe(1);
  });

  test("filters wrapper/system-reminder noise from unmatched query counts", () => {
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
      // Wrapper/system noise that should NOT inflate unmatched counts
      makeQuery({
        session_id: sid,
        query: "<system-reminder>\nPAI Dynamic Context\n</system-reminder>",
      }),
      makeQuery({
        session_id: sid,
        query: "<available-deferred-tools>\nNotebookEdit\n</available-deferred-tools>",
      }),
      makeQuery({
        session_id: sid,
        query: "SessionStart:startup hook success: loaded",
      }),
      makeQuery({
        session_id: sid,
        query: "UserPromptSubmit:Callback hook success: Success",
      }),
      makeQuery({
        session_id: sid,
        query: "gitStatus: This is the git status at the start",
      }),
      // This IS a real unmatched user query
      makeQuery({ session_id: sid, query: "real unmatched prompt" }),
    ];

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    // Only "real unmatched prompt" should count — all noise should be filtered
    expect(result.unmatchedQueries).toBe(1);
  });

  test("all-false skill checks become critical once sample threshold is met", () => {
    const sid = "sess-1";
    const telemetry = [makeTelemetry({ session_id: sid, skills_triggered: [] })];
    const skillRecords = [
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: false }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: false }),
      makeSkillRecord({ session_id: sid, skill_name: "my-skill", triggered: false }),
    ];
    const queryRecords = Array.from({ length: 3 }, () => makeQuery({ session_id: sid }));

    const result = computeStatus(telemetry, skillRecords, queryRecords, [], makeDoctorResult());

    expect(result.skills[0].passRate).toBe(0);
    expect(result.skills[0].status).toBe("CRITICAL");
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

describe("formatStatus", () => {
  test("renders compact trust highlights before the skills table", () => {
    const result = {
      skills: [],
      unmatchedQueries: 0,
      pendingProposals: 0,
      lastSession: null,
      system: { healthy: true, pass: 3, fail: 0, warn: 0 },
    };
    const trustSummaries = [
      {
        skill_name: "Art",
        total_checks: 12,
        triggered_count: 8,
        miss_rate: 4 / 12,
        system_like_count: 0,
        system_like_rate: 0,
        prompt_link_rate: 1,
        latest_action: null,
        pass_rate: 8 / 12,
        last_seen: "2026-04-01T10:00:00Z",
      },
      {
        skill_name: "pptx",
        total_checks: 20,
        triggered_count: 17,
        miss_rate: 0.15,
        system_like_count: 0,
        system_like_rate: 0,
        prompt_link_rate: 1,
        latest_action: "validated",
        pass_rate: 0.85,
        last_seen: "2026-04-01T11:00:00Z",
      },
    ];

    const output = formatStatus(result, trustSummaries);
    expect(output).toContain("Highlights");
    expect(output).toContain("Attention: Art (High miss rate");
    expect(output).toContain("Improving: pptx (Proposal validated, pending deploy)");
    expect(output.indexOf("Highlights")).toBeLessThan(output.indexOf("Skills (0)"));
  });

  test("renders creator loop readiness when testing artifacts are present", () => {
    const result = {
      skills: [],
      unmatchedQueries: 0,
      pendingProposals: 0,
      lastSession: null,
      system: { healthy: true, pass: 3, fail: 0, warn: 0 },
    };

    const output = formatStatus(
      result,
      [],
      [
        {
          skill_name: "Research",
          eval_readiness: "log_ready",
          next_step: "run_unit_tests",
          summary: "Eval coverage is present (24 entries), but no unit tests are stored yet.",
          recommended_command:
            "selftune eval unit-test --skill Research --generate --skill-path /tmp/Research/SKILL.md",
          skill_path: "/tmp/Research/SKILL.md",
          trusted_trigger_count: 12,
          trusted_session_count: 8,
          eval_set_entries: 24,
          latest_eval_at: "2026-04-12T10:00:00Z",
          unit_test_cases: 0,
          unit_test_pass_rate: null,
          unit_test_ran_at: null,
          replay_check_count: 0,
          latest_validation_mode: null,
          baseline_sample_size: 0,
          baseline_pass_rate: null,
          latest_baseline_at: null,
          deployment_readiness: "blocked",
          deployment_summary: "Finish the creator test loop before shipping this skill.",
          deployment_command: null,
          latest_evolution_action: null,
          latest_evolution_at: null,
        },
      ],
    );

    expect(output).toContain("Creator loop");
    expect(output).toContain("Generate evals: 0");
    expect(output).toContain("Unit tests: 1");
    expect(output).toContain("Deploy: 0");
    expect(output).toContain("Research: run unit tests");
  });
});

describe("formatStatusSummary", () => {
  test("summarizes watched, improving, and attention counts", () => {
    const summary = formatStatusSummary({
      skills: [
        {
          name: "healthy-skill",
          passRate: 0.9,
          trend: "up",
          missedQueries: 0,
          status: "HEALTHY",
          snapshot: null,
        },
        {
          name: "warning-skill",
          passRate: 0.55,
          trend: "stable",
          missedQueries: 2,
          status: "WARNING",
          snapshot: null,
        },
      ],
      unmatchedQueries: 0,
      pendingProposals: 0,
      lastSession: "2026-02-28T12:00:00Z",
      system: { healthy: true, pass: 1, fail: 0, warn: 0 },
    });

    expect(summary).toContain("2 skills watched");
    expect(summary).toContain("1 improving");
    expect(summary).toContain("1 needing attention");
  });

  test("uses calm zero-state copy when nothing is tracked", () => {
    const summary = formatStatusSummary({
      skills: [],
      unmatchedQueries: 0,
      pendingProposals: 0,
      lastSession: null,
      system: { healthy: true, pass: 0, fail: 0, warn: 0 },
    });

    expect(summary).toBe("0 skills watched | no recent data | nothing tracked yet");
  });

  test("prefers shared trust summaries when provided", () => {
    const summary = formatStatusSummary(
      {
        skills: [
          {
            name: "legacy-view",
            passRate: 1,
            trend: "up",
            missedQueries: 0,
            status: "HEALTHY",
            snapshot: null,
          },
        ],
        unmatchedQueries: 0,
        pendingProposals: 0,
        lastSession: "2026-02-28T12:00:00Z",
        system: { healthy: true, pass: 1, fail: 0, warn: 0 },
      },
      [
        {
          skill_name: "skill-a",
          total_checks: 12,
          triggered_count: 11,
          miss_rate: 1 / 12,
          system_like_count: 0,
          system_like_rate: 0,
          prompt_link_rate: 1,
          latest_action: "validated",
          pass_rate: 11 / 12,
          last_seen: "2026-02-28T12:00:00Z",
        },
        {
          skill_name: "skill-b",
          total_checks: 12,
          triggered_count: 8,
          miss_rate: 4 / 12,
          system_like_count: 0,
          system_like_rate: 0,
          prompt_link_rate: 1,
          latest_action: null,
          pass_rate: 8 / 12,
          last_seen: "2026-02-28T12:00:00Z",
        },
      ],
    );

    expect(summary).toBe("2 skills watched | 1 improving | 1 needing attention");
  });
});
