import { describe, expect, it } from "bun:test";

import { analyzeComposabilityV2 } from "../../cli/selftune/eval/composability-v2.js";
import type { SessionTelemetryRecord, SkillUsageRecord } from "../../cli/selftune/types.js";

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
// analyzeComposabilityV2
// ---------------------------------------------------------------------------
describe("analyzeComposabilityV2", () => {
  function assertDefined<T>(
    value: T | undefined | null,
    msg = "Expected value to be defined",
  ): asserts value is T {
    if (value == null) throw new Error(msg);
  }

  // -------------------------------------------------------------------------
  // 1. Synergy detection
  // -------------------------------------------------------------------------
  it("detects positive synergy when skills have lower error rate together", () => {
    const telemetry = [
      // SkillA alone: 5 errors average
      makeSession("s1", ["SkillA"], 5),
      makeSession("s2", ["SkillA"], 5),
      makeSession("s3", ["SkillA"], 5),
      // SkillA + SkillB together: 1 error average
      makeSession("s4", ["SkillA", "SkillB"], 1),
      makeSession("s5", ["SkillA", "SkillB"], 1),
      makeSession("s6", ["SkillA", "SkillB"], 1),
    ];

    const usage = [
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillB", timestamp: "2025-01-04T00:01:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillA", timestamp: "2025-01-05T00:00:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillB", timestamp: "2025-01-05T00:01:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillA", timestamp: "2025-01-06T00:00:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillB", timestamp: "2025-01-06T00:01:00Z" }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    const pair = report.pairs.find((p) => p.skill_b === "SkillB");
    assertDefined(pair);
    expect(pair.synergy_score).toBeGreaterThan(0);
    // synergy = (avg_errors_alone - avg_errors_together) / (avg_errors_alone + 1)
    // = (5 - 1) / (5 + 1) = 4/6 ≈ 0.667
    expect(pair.avg_errors_together).toBe(1);
    expect(pair.avg_errors_alone).toBe(5);
  });

  it("uses true solo sessions for the co-skill baseline", () => {
    const telemetry = [
      makeSession("s1", ["SkillA"], 5),
      makeSession("s2", ["SkillA"], 5),
      makeSession("s3", ["SkillB", "SkillC"], 9),
      makeSession("s4", ["SkillA", "SkillB"], 1),
      makeSession("s5", ["SkillA", "SkillB"], 1),
      makeSession("s6", ["SkillA", "SkillB"], 1),
    ];

    const usage = [
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillB", timestamp: "2025-01-04T00:01:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillA", timestamp: "2025-01-05T00:00:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillB", timestamp: "2025-01-05T00:01:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillA", timestamp: "2025-01-06T00:00:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillB", timestamp: "2025-01-06T00:01:00Z" }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    const pair = report.pairs.find((p) => p.skill_b === "SkillB");
    assertDefined(pair);
    expect(pair.avg_errors_alone).toBe(5);
    expect(pair.synergy_score).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 2. Conflict preserved
  // -------------------------------------------------------------------------
  it("detects conflict when skills have higher error rate together", () => {
    const telemetry = [
      // SkillA alone: 1 error average
      makeSession("s1", ["SkillA"], 1),
      makeSession("s2", ["SkillA"], 1),
      makeSession("s3", ["SkillA"], 1),
      // SkillA + ConflictSkill together: 8 errors average
      makeSession("s4", ["SkillA", "ConflictSkill"], 8),
      makeSession("s5", ["SkillA", "ConflictSkill"], 8),
      makeSession("s6", ["SkillA", "ConflictSkill"], 8),
    ];

    const usage = [
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({
        session_id: "s4",
        skill_name: "ConflictSkill",
        timestamp: "2025-01-04T00:01:00Z",
      }),
      makeUsage({ session_id: "s5", skill_name: "SkillA", timestamp: "2025-01-05T00:00:00Z" }),
      makeUsage({
        session_id: "s5",
        skill_name: "ConflictSkill",
        timestamp: "2025-01-05T00:01:00Z",
      }),
      makeUsage({ session_id: "s6", skill_name: "SkillA", timestamp: "2025-01-06T00:00:00Z" }),
      makeUsage({
        session_id: "s6",
        skill_name: "ConflictSkill",
        timestamp: "2025-01-06T00:01:00Z",
      }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    const pair = report.pairs.find((p) => p.skill_b === "ConflictSkill");
    assertDefined(pair);
    expect(pair.synergy_score).toBeLessThan(0);
    expect(pair.conflict_detected).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Sequence extraction
  // -------------------------------------------------------------------------
  it("extracts correct ordered sequence from timestamps", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB", "SkillC"], 0),
      makeSession("s2", ["SkillA", "SkillB", "SkillC"], 0),
      makeSession("s3", ["SkillA", "SkillB", "SkillC"], 0),
    ];

    const usage = [
      // Session s1: A at t1, B at t2, C at t3
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillC", timestamp: "2025-01-01T00:02:00Z" }),
      // Session s2: same order
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillC", timestamp: "2025-01-02T00:02:00Z" }),
      // Session s3: same order
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillC", timestamp: "2025-01-03T00:02:00Z" }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    const seq = report.sequences.find(
      (s) =>
        s.skills.length === 3 &&
        s.skills[0] === "SkillA" &&
        s.skills[1] === "SkillB" &&
        s.skills[2] === "SkillC",
    );
    assertDefined(seq);
    expect(seq.skills).toEqual(["SkillA", "SkillB", "SkillC"]);
    expect(seq.occurrence_count).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 4. Workflow candidate detection
  // -------------------------------------------------------------------------
  it("flags pair as workflow candidate when synergy > 0.3 and count >= minOccurrences", () => {
    const telemetry = [
      // SkillA alone: 5 errors avg
      makeSession("s1", ["SkillA"], 5),
      makeSession("s2", ["SkillA"], 5),
      // SkillA + SkillB together: 1 error avg (high synergy)
      makeSession("s3", ["SkillA", "SkillB"], 1),
      makeSession("s4", ["SkillA", "SkillB"], 1),
      makeSession("s5", ["SkillA", "SkillB"], 1),
    ];

    const usage = [
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillB", timestamp: "2025-01-04T00:01:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillA", timestamp: "2025-01-05T00:00:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillB", timestamp: "2025-01-05T00:01:00Z" }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage, { minOccurrences: 3 });

    const pair = report.pairs.find((p) => p.skill_b === "SkillB");
    assertDefined(pair);
    expect(pair.synergy_score).toBeGreaterThan(0.3);
    expect(pair.workflow_candidate).toBe(true);

    // Also verify it appears in report.workflow_candidates
    const candidate = report.workflow_candidates.find((p) => p.skill_b === "SkillB");
    assertDefined(candidate);
    expect(candidate.workflow_candidate).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Threshold filtering
  // -------------------------------------------------------------------------
  it("does not flag workflow candidate when count < minOccurrences", () => {
    const telemetry = [
      // SkillA alone: 5 errors avg
      makeSession("s1", ["SkillA"], 5),
      makeSession("s2", ["SkillA"], 5),
      // Only 2 sessions together (below minOccurrences=3)
      makeSession("s3", ["SkillA", "SkillB"], 1),
      makeSession("s4", ["SkillA", "SkillB"], 1),
    ];

    const usage = [
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillB", timestamp: "2025-01-04T00:01:00Z" }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage, { minOccurrences: 3 });

    const pair = report.pairs.find((p) => p.skill_b === "SkillB");
    assertDefined(pair);
    // Synergy is still high, but below minOccurrences threshold
    expect(pair.synergy_score).toBeGreaterThan(0.3);
    expect(pair.workflow_candidate).toBe(false);
    expect(report.workflow_candidates).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 6. Sequence consistency
  // -------------------------------------------------------------------------
  it("computes sequence consistency correctly for mixed orderings", () => {
    const telemetry = [
      // 4 sessions with SkillA + SkillB
      makeSession("s1", ["SkillA", "SkillB"], 0),
      makeSession("s2", ["SkillA", "SkillB"], 0),
      makeSession("s3", ["SkillA", "SkillB"], 0),
      makeSession("s4", ["SkillA", "SkillB"], 0),
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
      // s4: B then A (reversed order)
      makeUsage({ session_id: "s4", skill_name: "SkillB", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:01:00Z" }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage, { minOccurrences: 1 });

    // Should have two separate sequences
    const seqAB = report.sequences.find(
      (s) => s.skills.length === 2 && s.skills[0] === "SkillA" && s.skills[1] === "SkillB",
    );
    const seqBA = report.sequences.find(
      (s) => s.skills.length === 2 && s.skills[0] === "SkillB" && s.skills[1] === "SkillA",
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
  // 7. Backwards compatibility
  // -------------------------------------------------------------------------
  it("preserves all v1 report fields in v2 output", () => {
    const telemetry = [
      makeSession("s1", ["SkillA"], 0),
      makeSession("s2", ["SkillA", "SkillB"], 1),
      makeSession("s3", ["SkillA", "SkillB"], 1),
      makeSession("s4", ["SkillA", "SkillB"], 1),
    ];

    const usage = [
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillB", timestamp: "2025-01-04T00:01:00Z" }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    // V1 report fields
    expect(report.pairs).toBeDefined();
    expect(Array.isArray(report.pairs)).toBe(true);
    expect(typeof report.total_sessions_analyzed).toBe("number");
    expect(typeof report.conflict_count).toBe("number");
    expect(typeof report.generated_at).toBe("string");
    expect(Number.isNaN(Date.parse(report.generated_at))).toBe(false);

    // V1 pair fields
    const pair = report.pairs[0];
    expect(pair).toBeDefined();
    expect(typeof pair.skill_a).toBe("string");
    expect(typeof pair.skill_b).toBe("string");
    expect(typeof pair.co_occurrence_count).toBe("number");
    expect(typeof pair.conflict_detected).toBe("boolean");

    // V2 extension fields
    expect(typeof pair.synergy_score).toBe("number");
    expect(typeof pair.avg_errors_together).toBe("number");
    expect(typeof pair.avg_errors_alone).toBe("number");
    expect(typeof pair.workflow_candidate).toBe("boolean");
    expect(Array.isArray(report.sequences)).toBe(true);
    expect(Array.isArray(report.workflow_candidates)).toBe(true);
    expect(typeof report.synergy_count).toBe("number");
  });

  // -------------------------------------------------------------------------
  // 8. Empty usage log
  // -------------------------------------------------------------------------
  it("returns empty sequences when usage array is empty", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 0),
      makeSession("s2", ["SkillA", "SkillB"], 0),
      makeSession("s3", ["SkillA", "SkillB"], 0),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, []);

    expect(report.sequences).toEqual([]);
    // Pairs should still be computed from telemetry
    expect(report.pairs.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 9. Single session sequence filtered by default minOccurrences
  // -------------------------------------------------------------------------
  it("filters out sequences with fewer occurrences than minOccurrences", () => {
    const telemetry = [makeSession("s1", ["SkillA", "SkillB"], 0)];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
    ];

    // Default minOccurrences is 3, only 1 session has this sequence
    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    // Sequence should be filtered out by default threshold
    const seq = report.sequences.find(
      (s) => s.skills.length === 2 && s.skills[0] === "SkillA" && s.skills[1] === "SkillB",
    );
    expect(seq).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 10. No co-occurring skills
  // -------------------------------------------------------------------------
  it("returns empty pairs and sequences when skill is always used alone", () => {
    const telemetry = [
      makeSession("s1", ["SkillA"], 0),
      makeSession("s2", ["SkillA"], 1),
      makeSession("s3", ["SkillA"], 0),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "SkillA", timestamp: "2025-01-01T00:00:00Z" }),
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    expect(report.pairs).toEqual([]);
    expect(report.sequences).toEqual([]);
    expect(report.workflow_candidates).toEqual([]);
    expect(report.synergy_count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 11. synergy_count matches number of positive synergy pairs
  // -------------------------------------------------------------------------
  it("reports correct synergy_count for mixed synergy/conflict pairs", () => {
    const telemetry = [
      // SkillA alone: 3 errors avg
      makeSession("s1", ["SkillA"], 3),
      makeSession("s2", ["SkillA"], 3),
      // SkillA + GoodSkill: 1 error (positive synergy)
      makeSession("s3", ["SkillA", "GoodSkill"], 1),
      makeSession("s4", ["SkillA", "GoodSkill"], 1),
      makeSession("s5", ["SkillA", "GoodSkill"], 1),
      // SkillA + BadSkill: 8 errors (negative synergy / conflict)
      makeSession("s6", ["SkillA", "BadSkill"], 8),
      makeSession("s7", ["SkillA", "BadSkill"], 8),
      makeSession("s8", ["SkillA", "BadSkill"], 8),
      // SkillA + NeutralSkill: 3 errors (no effect)
      makeSession("s9", ["SkillA", "NeutralSkill"], 3),
      makeSession("s10", ["SkillA", "NeutralSkill"], 3),
      makeSession("s11", ["SkillA", "NeutralSkill"], 3),
    ];

    const usage = [
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "GoodSkill", timestamp: "2025-01-03T00:01:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "GoodSkill", timestamp: "2025-01-04T00:01:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "SkillA", timestamp: "2025-01-05T00:00:00Z" }),
      makeUsage({ session_id: "s5", skill_name: "GoodSkill", timestamp: "2025-01-05T00:01:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "SkillA", timestamp: "2025-01-06T00:00:00Z" }),
      makeUsage({ session_id: "s6", skill_name: "BadSkill", timestamp: "2025-01-06T00:01:00Z" }),
      makeUsage({ session_id: "s7", skill_name: "SkillA", timestamp: "2025-01-07T00:00:00Z" }),
      makeUsage({ session_id: "s7", skill_name: "BadSkill", timestamp: "2025-01-07T00:01:00Z" }),
      makeUsage({ session_id: "s8", skill_name: "SkillA", timestamp: "2025-01-08T00:00:00Z" }),
      makeUsage({ session_id: "s8", skill_name: "BadSkill", timestamp: "2025-01-08T00:01:00Z" }),
      makeUsage({ session_id: "s9", skill_name: "SkillA", timestamp: "2025-01-09T00:00:00Z" }),
      makeUsage({
        session_id: "s9",
        skill_name: "NeutralSkill",
        timestamp: "2025-01-09T00:01:00Z",
      }),
      makeUsage({ session_id: "s10", skill_name: "SkillA", timestamp: "2025-01-10T00:00:00Z" }),
      makeUsage({
        session_id: "s10",
        skill_name: "NeutralSkill",
        timestamp: "2025-01-10T00:01:00Z",
      }),
      makeUsage({ session_id: "s11", skill_name: "SkillA", timestamp: "2025-01-11T00:00:00Z" }),
      makeUsage({
        session_id: "s11",
        skill_name: "NeutralSkill",
        timestamp: "2025-01-11T00:01:00Z",
      }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    // GoodSkill has positive synergy, BadSkill negative, NeutralSkill near zero
    const goodPair = report.pairs.find((p) => p.skill_b === "GoodSkill");
    const badPair = report.pairs.find((p) => p.skill_b === "BadSkill");

    assertDefined(goodPair);
    assertDefined(badPair);
    expect(goodPair.synergy_score).toBeGreaterThan(0);
    expect(badPair.synergy_score).toBeLessThan(0);

    // synergy_count should count pairs with positive synergy_score
    expect(report.synergy_count).toBe(report.pairs.filter((p) => p.synergy_score > 0).length);
  });

  // -------------------------------------------------------------------------
  // 12. Window parameter filters sessions by recency
  // -------------------------------------------------------------------------
  it("respects window parameter to limit sessions by recency", () => {
    const telemetry = [
      // Old sessions: SkillA alone, 0 errors
      makeSession("s1", ["SkillA"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["SkillA"], 0, "2025-01-02T00:00:00Z"),
      // Newer sessions: SkillA + SkillB together, 5 errors
      makeSession("s3", ["SkillA", "SkillB"], 5, "2025-01-03T00:00:00Z"),
      makeSession("s4", ["SkillA", "SkillB"], 5, "2025-01-04T00:00:00Z"),
    ];

    const usage = [
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({ session_id: "s4", skill_name: "SkillB", timestamp: "2025-01-04T00:01:00Z" }),
    ];

    // Window=2: only newest 2 sessions (s3, s4 with SkillB co-occurrence)
    const report = analyzeComposabilityV2("SkillA", telemetry, usage, { window: 2 });

    expect(report.total_sessions_analyzed).toBe(2);
    expect(report.pairs.length).toBe(1);
    expect(report.pairs[0].skill_b).toBe("SkillB");
  });

  // -------------------------------------------------------------------------
  // 13. Empty telemetry array
  // -------------------------------------------------------------------------
  it("handles empty telemetry array", () => {
    const report = analyzeComposabilityV2("SkillA", [], []);

    expect(report.pairs).toEqual([]);
    expect(report.sequences).toEqual([]);
    expect(report.workflow_candidates).toEqual([]);
    expect(report.total_sessions_analyzed).toBe(0);
    expect(report.conflict_count).toBe(0);
    expect(report.synergy_count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 14. Skill never triggered
  // -------------------------------------------------------------------------
  it("returns empty report when target skill is never triggered", () => {
    const telemetry = [
      makeSession("s1", ["OtherSkill"], 0),
      makeSession("s2", ["AnotherSkill"], 1),
    ];

    const usage = [
      makeUsage({ session_id: "s1", skill_name: "OtherSkill", timestamp: "2025-01-01T00:00:00Z" }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    expect(report.pairs).toEqual([]);
    expect(report.sequences).toEqual([]);
    expect(report.total_sessions_analyzed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 15. Sequence representative_query is populated
  // -------------------------------------------------------------------------
  it("populates representative_query for detected sequences", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 0),
      makeSession("s2", ["SkillA", "SkillB"], 0),
      makeSession("s3", ["SkillA", "SkillB"], 0),
    ];

    const usage = [
      makeUsage({
        session_id: "s1",
        skill_name: "SkillA",
        timestamp: "2025-01-01T00:00:00Z",
        query: "write a blog post",
      }),
      makeUsage({
        session_id: "s1",
        skill_name: "SkillB",
        timestamp: "2025-01-01T00:01:00Z",
        query: "publish it",
      }),
      makeUsage({
        session_id: "s2",
        skill_name: "SkillA",
        timestamp: "2025-01-02T00:00:00Z",
        query: "write a blog post",
      }),
      makeUsage({
        session_id: "s2",
        skill_name: "SkillB",
        timestamp: "2025-01-02T00:01:00Z",
        query: "publish it",
      }),
      makeUsage({
        session_id: "s3",
        skill_name: "SkillA",
        timestamp: "2025-01-03T00:00:00Z",
        query: "draft content",
      }),
      makeUsage({
        session_id: "s3",
        skill_name: "SkillB",
        timestamp: "2025-01-03T00:01:00Z",
        query: "publish it",
      }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage, { minOccurrences: 3 });

    const seq = report.sequences.find((s) => s.skills[0] === "SkillA" && s.skills[1] === "SkillB");
    assertDefined(seq);
    expect(typeof seq.representative_query).toBe("string");
    expect(seq.representative_query.length).toBeGreaterThan(0);
  });

  it("uses the most frequent initiating query as representative_query", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillB"], 0),
      makeSession("s2", ["SkillA", "SkillB"], 0),
      makeSession("s3", ["SkillA", "SkillB"], 0),
    ];

    const usage = [
      makeUsage({
        session_id: "s1",
        skill_name: "SkillA",
        timestamp: "2025-01-01T00:00:00Z",
        query: "publish blog",
      }),
      makeUsage({ session_id: "s1", skill_name: "SkillB", timestamp: "2025-01-01T00:01:00Z" }),
      makeUsage({
        session_id: "s2",
        skill_name: "SkillA",
        timestamp: "2025-01-02T00:00:00Z",
        query: "publish blog",
      }),
      makeUsage({ session_id: "s2", skill_name: "SkillB", timestamp: "2025-01-02T00:01:00Z" }),
      makeUsage({
        session_id: "s3",
        skill_name: "SkillA",
        timestamp: "2025-01-03T00:00:00Z",
        query: "draft content",
      }),
      makeUsage({ session_id: "s3", skill_name: "SkillB", timestamp: "2025-01-03T00:01:00Z" }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage, { minOccurrences: 3 });

    const seq = report.sequences.find((s) => s.skills[0] === "SkillA" && s.skills[1] === "SkillB");
    assertDefined(seq);
    expect(seq.representative_query).toBe("publish blog");
  });

  // -------------------------------------------------------------------------
  // 16. Synergy score is clamped between -1 and 1
  // -------------------------------------------------------------------------
  it("clamps synergy_score between -1 and 1", () => {
    const telemetry = [
      // SkillA alone: 0 errors
      makeSession("s1", ["SkillA"], 0),
      // SkillA + ExtremeSkill: 100 errors (extreme conflict)
      makeSession("s2", ["SkillA", "ExtremeSkill"], 100),
      makeSession("s3", ["SkillA", "ExtremeSkill"], 100),
      makeSession("s4", ["SkillA", "ExtremeSkill"], 100),
    ];

    const usage = [
      makeUsage({ session_id: "s2", skill_name: "SkillA", timestamp: "2025-01-02T00:00:00Z" }),
      makeUsage({
        session_id: "s2",
        skill_name: "ExtremeSkill",
        timestamp: "2025-01-02T00:01:00Z",
      }),
      makeUsage({ session_id: "s3", skill_name: "SkillA", timestamp: "2025-01-03T00:00:00Z" }),
      makeUsage({
        session_id: "s3",
        skill_name: "ExtremeSkill",
        timestamp: "2025-01-03T00:01:00Z",
      }),
      makeUsage({ session_id: "s4", skill_name: "SkillA", timestamp: "2025-01-04T00:00:00Z" }),
      makeUsage({
        session_id: "s4",
        skill_name: "ExtremeSkill",
        timestamp: "2025-01-04T00:01:00Z",
      }),
    ];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    const pair = report.pairs.find((p) => p.skill_b === "ExtremeSkill");
    assertDefined(pair);
    expect(pair.synergy_score).toBeGreaterThanOrEqual(-1);
    expect(pair.synergy_score).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 17. Pairs sorted by co_occurrence_count descending
  // -------------------------------------------------------------------------
  it("sorts pairs by co_occurrence_count descending", () => {
    const telemetry = [
      makeSession("s1", ["SkillA", "SkillX"], 0),
      makeSession("s2", ["SkillA", "SkillY"], 0),
      makeSession("s3", ["SkillA", "SkillY"], 0),
      makeSession("s4", ["SkillA", "SkillZ"], 0),
      makeSession("s5", ["SkillA", "SkillZ"], 0),
      makeSession("s6", ["SkillA", "SkillZ"], 0),
      makeSession("s7", ["SkillA"], 0),
    ];

    const usage: SkillUsageRecord[] = [];

    const report = analyzeComposabilityV2("SkillA", telemetry, usage);

    expect(report.pairs.length).toBe(3);
    expect(report.pairs[0].skill_b).toBe("SkillZ");
    expect(report.pairs[0].co_occurrence_count).toBe(3);
    expect(report.pairs[1].skill_b).toBe("SkillY");
    expect(report.pairs[1].co_occurrence_count).toBe(2);
    expect(report.pairs[2].skill_b).toBe("SkillX");
    expect(report.pairs[2].co_occurrence_count).toBe(1);
  });
});
