import { describe, expect, it } from "bun:test";

import type { SessionTelemetryRecord, SkillUsageRecord } from "../../cli/selftune/types.js";
import { discoverWorkflows } from "../../cli/selftune/workflows/discover.js";

// ---------------------------------------------------------------------------
// Helper to build minimal SessionTelemetryRecord fixtures
// ---------------------------------------------------------------------------
function makeSession(
  id: string,
  skills: string[],
  errors: number,
  timestamp = "2025-01-01T00:00:00Z",
): SessionTelemetryRecord {
  return {
    timestamp,
    session_id: id,
    cwd: "/tmp",
    transcript_path: `/tmp/${id}.jsonl`,
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: skills,
    assistant_turns: 1,
    errors_encountered: errors,
    transcript_chars: 100,
    last_user_query: "test",
  };
}

// ---------------------------------------------------------------------------
// Helper to build minimal SkillUsageRecord fixtures
// ---------------------------------------------------------------------------
function makeUsage(overrides: Partial<SkillUsageRecord>): SkillUsageRecord {
  return {
    timestamp: new Date().toISOString(),
    session_id: "s1",
    skill_name: "TestSkill",
    skill_path: "/skills/test/SKILL.md",
    query: "test query",
    triggered: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// discoverWorkflows
// ---------------------------------------------------------------------------
describe("discoverWorkflows", () => {
  function assertDefined<T>(
    value: T | undefined | null,
    msg = "Expected value to be defined",
  ): asserts value is T {
    if (value == null) throw new Error(msg);
  }

  // -------------------------------------------------------------------------
  // 1. Empty data returns empty workflows
  // -------------------------------------------------------------------------
  it("returns empty workflows for empty data", () => {
    const report = discoverWorkflows([], []);

    expect(report.workflows).toEqual([]);
    expect(report.total_sessions_analyzed).toBe(0);
    expect(typeof report.generated_at).toBe("string");
  });

  // -------------------------------------------------------------------------
  // 2. Single workflow detection (3+ occurrences of same sequence)
  // -------------------------------------------------------------------------
  it("detects a single workflow with 3+ occurrences", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 1, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 1, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 1, "2025-01-03T00:00:00Z"),
    ];

    const usage = [
      makeUsage({
        session_id: "s1",
        skill_name: "SkillA",
        timestamp: "2025-01-01T00:00:00Z",
        query: "build feature",
      }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({
        session_id: "s2",
        skill_name: "SkillA",
        timestamp: "2025-01-02T00:00:00Z",
        query: "build feature",
      }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({
        session_id: "s3",
        skill_name: "SkillA",
        timestamp: "2025-01-03T00:00:00Z",
        query: "build feature",
      }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage);

    expect(report.workflows.length).toBe(1);
    expect(report.workflows[0].skills).toEqual(["SkillA", "SkillB"]);
    expect(report.workflows[0].occurrence_count).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 3. Multiple workflows detected and sorted by occurrence
  // -------------------------------------------------------------------------
  it("detects multiple workflows sorted by occurrence count", () => {
    const telemetry = [
      // A->B workflow: 4 occurrences
      makeSession("s1", ["SkillA", "SkillB"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 0, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 0, "2025-01-03T00:00:00Z"),
      makeSession("s4", ["SkillA", "SkillB"], 0, "2025-01-04T00:00:00Z"),
      // C->D workflow: 3 occurrences
      makeSession("s5", ["SkillC", "SkillD"], 0, "2025-01-05T00:00:00Z"),
      makeSession("s6", ["SkillC", "SkillD"], 0, "2025-01-06T00:00:00Z"),
      makeSession("s7", ["SkillC", "SkillD"], 0, "2025-01-07T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillB", timestamp: "2025-01-04T00:01:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillC", timestamp: "2025-01-05T00:00:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillD", timestamp: "2025-01-05T00:01:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillC", timestamp: "2025-01-06T00:00:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillD", timestamp: "2025-01-06T00:01:00Z" }),
      makeUsage({ session_id: "s7", skill_name: "SkillC", timestamp: "2025-01-07T00:00:00Z" }),
      makeUsage({ session_id: "s7", skill_name: "SkillD", timestamp: "2025-01-07T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage);

    expect(report.workflows.length).toBe(2);
    // Sorted by occurrence_count descending
    expect(report.workflows[0].occurrence_count).toBe(4);
    expect(report.workflows[0].skills).toEqual(["SkillA", "SkillB"]);
    expect(report.workflows[1].occurrence_count).toBe(3);
    expect(report.workflows[1].skills).toEqual(["SkillC", "SkillD"]);
  });

  // -------------------------------------------------------------------------
  // 4. --skill filter only returns workflows containing that skill
  // -------------------------------------------------------------------------
  it("filters workflows by skill when --skill is provided", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 0, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 0, "2025-01-03T00:00:00Z"),
      makeSession("s5", ["SkillC", "SkillD"], 0, "2025-01-05T00:00:00Z"),
      makeSession("s6", ["SkillC", "SkillD"], 0, "2025-01-06T00:00:00Z"),
      makeSession("s7", ["SkillC", "SkillD"], 0, "2025-01-07T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillC", timestamp: "2025-01-05T00:00:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillD", timestamp: "2025-01-05T00:01:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillC", timestamp: "2025-01-06T00:00:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillD", timestamp: "2025-01-06T00:01:00Z" }),
      makeUsage({ session_id: "s7", skill_name: "SkillC", timestamp: "2025-01-07T00:00:00Z" }),
      makeUsage({ session_id: "s7", skill_name: "SkillD", timestamp: "2025-01-07T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage, { skill: "SkillC" });

    expect(report.workflows.length).toBe(1);
    expect(report.workflows[0].skills).toEqual(["SkillC", "SkillD"]);
  });

  // -------------------------------------------------------------------------
  // 5. --window filter limits sessions analyzed
  // -------------------------------------------------------------------------
  it("respects window parameter to limit sessions by recency", () => {
    const telemetry = [
      // Old sessions
      makeSession("s1", ["SkillA", "SkillB"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 0, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 0, "2025-01-03T00:00:00Z"),
      // Newer sessions with different workflow
      makeSession("s4", ["SkillC", "SkillD"], 0, "2025-01-04T00:00:00Z"),
      makeSession("s5", ["SkillC", "SkillD"], 0, "2025-01-05T00:00:00Z"),
      makeSession("s6", ["SkillC", "SkillD"], 0, "2025-01-06T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillC", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillD", timestamp: "2025-01-04T00:01:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillC", timestamp: "2025-01-05T00:00:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillD", timestamp: "2025-01-05T00:01:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillC", timestamp: "2025-01-06T00:00:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillD", timestamp: "2025-01-06T00:01:00Z" }),
    ];

    // Window=3: only newest 3 sessions (s4, s5, s6 with C->D)
    const report = discoverWorkflows(telemetry, usage, { window: 3 });

    expect(report.total_sessions_analyzed).toBe(3);
    expect(report.workflows.length).toBe(1);
    expect(report.workflows[0].skills).toEqual(["SkillC", "SkillD"]);
  });

  // -------------------------------------------------------------------------
  // 6. --min-occurrences threshold works
  // -------------------------------------------------------------------------
  it("respects minOccurrences threshold", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 0, "2025-01-02T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
    ];

    // Default minOccurrences=3, only 2 sessions -> no workflows
    const reportDefault = discoverWorkflows(telemetry, usage);
    expect(reportDefault.workflows.length).toBe(0);

    // minOccurrences=2 -> workflow found
    const reportLower = discoverWorkflows(telemetry, usage, { minOccurrences: 2 });
    expect(reportLower.workflows.length).toBe(1);
    expect(reportLower.workflows[0].occurrence_count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 7. Mixed orderings compute correct consistency score
  // -------------------------------------------------------------------------
  it("computes sequence consistency correctly for mixed orderings", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 0, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 0, "2025-01-03T00:00:00Z"),
      makeSession("s4", ["SkillA", "SkillB"], 0, "2025-01-04T00:00:00Z"),
    ];

    const usage = [
      // s1: A then B
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      // s2: A then B
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      // s3: A then B
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
      // s4: B then A (reversed)
      makeUsage({ session_id: "s4", skill_name: "SkillB", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage, { minOccurrences: 1 });

    const seqAB = report.workflows.find(
      (w) => w.skills[0] === "SkillA" && w.skills[1] === "SkillB",
    );
    const seqBA = report.workflows.find(
      (w) => w.skills[0] === "SkillB" && w.skills[1] === "SkillA",
    );

    assertDefined(seqAB);
    assertDefined(seqBA);

    // A->B appears 3 out of 4 times = 0.75 consistency
    expect(seqAB.occurrence_count).toBe(3);
    expect(seqAB.sequence_consistency).toBe(0.75);

    // B->A appears 1 out of 4 times = 0.25 consistency
    expect(seqBA.occurrence_count).toBe(1);
    expect(seqBA.sequence_consistency).toBe(0.25);
  });

  // -------------------------------------------------------------------------
  // 8. Completion rate calculation
  // -------------------------------------------------------------------------
  it("calculates completion rate correctly", () => {
    const telemetry = [
      // 3 sessions with BOTH SkillA and SkillB
      makeSession("s1", ["SkillA", "SkillB"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 0, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 0, "2025-01-03T00:00:00Z"),
      // 1 session with only SkillA (not both)
      makeSession("s4", ["SkillA"], 0, "2025-01-04T00:00:00Z"),
      // 1 session with only SkillB (not both)
      makeSession("s5", ["SkillB"], 0, "2025-01-05T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage);

    expect(report.workflows.length).toBe(1);
    // 3 sessions with ALL skills / 5 sessions with ANY skill = 3/5 = 0.6
    expect(report.workflows[0].completion_rate).toBe(0.6);
  });

  // -------------------------------------------------------------------------
  // 9. first_seen/last_seen correctness
  // -------------------------------------------------------------------------
  it("computes first_seen and last_seen correctly", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 0, "2025-01-10T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 0, "2025-01-20T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 0, "2025-01-15T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-10T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-10T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-20T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-20T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-15T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-15T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage);

    expect(report.workflows.length).toBe(1);
    expect(report.workflows[0].first_seen).toBe("2025-01-10T00:00:00Z");
    expect(report.workflows[0].last_seen).toBe("2025-01-20T00:00:00Z");
  });

  // -------------------------------------------------------------------------
  // 10. workflow_id determinism (same skills -> same id)
  // -------------------------------------------------------------------------
  it("generates deterministic workflow_id from skill sequence", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 0, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 0, "2025-01-03T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
    ];

    // Run twice with same data
    const report1 = discoverWorkflows(telemetry, usage);
    const report2 = discoverWorkflows(telemetry, usage);

    expect(report1.workflows[0].workflow_id).toBe(report2.workflows[0].workflow_id);
    // workflow_id should be skills.join("->")
    expect(report1.workflows[0].workflow_id).toBe("SkillA\u2192SkillB");
  });

  // -------------------------------------------------------------------------
  // 11. Synergy score computation
  // -------------------------------------------------------------------------
  it("computes synergy_score correctly from error rates", () => {
    const telemetry = [
      // SkillA alone: 6 errors avg
      makeSession("s1", ["SkillA"], 6, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA"], 6, "2025-01-02T00:00:00Z"),
      // SkillB alone: 4 errors avg
      makeSession("s3", ["SkillB"], 4, "2025-01-03T00:00:00Z"),
      makeSession("s4", ["SkillB"], 4, "2025-01-04T00:00:00Z"),
      // Together: 2 errors avg
      makeSession("s5", ["SkillA", "SkillB"], 2, "2025-01-05T00:00:00Z"),
      makeSession("s6", ["SkillA", "SkillB"], 2, "2025-01-06T00:00:00Z"),
      makeSession("s7", ["SkillA", "SkillB"], 2, "2025-01-07T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s5", skill_name: "SkillA", timestamp: "2025-01-05T00:00:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillB", timestamp: "2025-01-05T00:01:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillA", timestamp: "2025-01-06T00:00:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillB", timestamp: "2025-01-06T00:01:00Z" }),
      makeUsage({ session_id: "s7", skill_name: "SkillA", timestamp: "2025-01-07T00:00:00Z" }),
      makeUsage({ session_id: "s7", skill_name: "SkillB", timestamp: "2025-01-07T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage);

    expect(report.workflows.length).toBe(1);
    const wf = report.workflows[0];

    // avg_errors_individual = max(6, 4) = 6
    expect(wf.avg_errors_individual).toBe(6);
    // avg_errors = 2
    expect(wf.avg_errors).toBe(2);
    // synergy = clamp((6 - 2) / (6 + 1), -1, 1) = 4/7 ~= 0.571
    expect(wf.synergy_score).toBeCloseTo(4 / 7, 5);
    expect(wf.synergy_score).toBeGreaterThan(0);
    expect(wf.synergy_score).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 12. Synergy score clamped between -1 and 1
  // -------------------------------------------------------------------------
  it("clamps synergy_score between -1 and 1", () => {
    const telemetry = [
      // SkillA alone: 0 errors
      makeSession("s1", ["SkillA"], 0, "2025-01-01T00:00:00Z"),
      // Together: 100 errors (extreme conflict)
      makeSession("s2", ["SkillA", "SkillB"], 100, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 100, "2025-01-03T00:00:00Z"),
      makeSession("s4", ["SkillA", "SkillB"], 100, "2025-01-04T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillB", timestamp: "2025-01-04T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage);

    expect(report.workflows.length).toBe(1);
    expect(report.workflows[0].synergy_score).toBeGreaterThanOrEqual(-1);
    expect(report.workflows[0].synergy_score).toBeLessThanOrEqual(1);
  });

  it("uses neutral synergy when no solo baselines exist", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 1, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 1, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 1, "2025-01-03T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage);

    expect(report.workflows).toHaveLength(1);
    expect(report.workflows[0].avg_errors_individual).toBe(0);
    expect(report.workflows[0].synergy_score).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 13. Consecutive same-skill deduplication
  // -------------------------------------------------------------------------
  it("deduplicates consecutive same-skill entries in a session", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 0, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 0, "2025-01-03T00:00:00Z"),
    ];

    const usage = [
      // s1: A, A, B (consecutive A should dedup to A, B)
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:30Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage);

    expect(report.workflows.length).toBe(1);
    expect(report.workflows[0].skills).toEqual(["SkillA", "SkillB"]);
    expect(report.workflows[0].occurrence_count).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 14. Single-skill sessions produce no workflows
  // -------------------------------------------------------------------------
  it("produces no workflows when all sessions have single skills", () => {
    const telemetry = [
      makeSession("s1", ["SkillA"], 0),
      makeSession("s2", ["SkillB"], 0),
      makeSession("s3", ["SkillC"], 0),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillC", timestamp: "2025-01-03T00:00:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage);

    expect(report.workflows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 15. Report has correct total_sessions_analyzed
  // -------------------------------------------------------------------------
  it("reports correct total_sessions_analyzed", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA", "SkillB"], 0, "2025-01-02T00:00:00Z"),
      makeSession("s3", ["SkillA", "SkillB"], 0, "2025-01-03T00:00:00Z"),
      makeSession("s4", ["SkillA"], 0, "2025-01-04T00:00:00Z"),
      makeSession("s5", ["SkillC"], 0, "2025-01-05T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
    ];

    const report = discoverWorkflows(telemetry, usage);

    // total_sessions_analyzed counts ALL sessions in scope, not just multi-skill ones
    expect(report.total_sessions_analyzed).toBe(5);
  });
});
