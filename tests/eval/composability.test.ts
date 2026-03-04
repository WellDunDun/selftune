import { describe, expect, test } from "bun:test";
import { analyzeComposability } from "../../cli/selftune/eval/composability.js";
import type { SessionTelemetryRecord } from "../../cli/selftune/types.js";

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
// analyzeComposability
// ---------------------------------------------------------------------------
describe("analyzeComposability", () => {
  test("returns empty pairs when skill is never triggered", () => {
    const telemetry = [makeSession("s1", ["other"], 0)];
    const report = analyzeComposability("pptx", telemetry);
    expect(report.pairs).toEqual([]);
    expect(report.total_sessions_analyzed).toBe(0);
    expect(report.conflict_count).toBe(0);
  });

  test("returns empty pairs when skill is only used alone", () => {
    const telemetry = [
      makeSession("s1", ["pptx"], 0),
      makeSession("s2", ["pptx"], 1),
    ];
    const report = analyzeComposability("pptx", telemetry);
    expect(report.pairs).toEqual([]);
    expect(report.total_sessions_analyzed).toBe(2);
    expect(report.conflict_count).toBe(0);
  });

  test("detects no conflict when co-occurring skill does not increase errors", () => {
    const telemetry = [
      // pptx alone: 1 error
      makeSession("s1", ["pptx"], 1),
      makeSession("s2", ["pptx"], 1),
      // pptx + slides together: also 1 error (no increase)
      makeSession("s3", ["pptx", "slides"], 1),
      makeSession("s4", ["pptx", "slides"], 1),
    ];
    const report = analyzeComposability("pptx", telemetry);
    expect(report.pairs.length).toBe(1);
    expect(report.pairs[0].skill_b).toBe("slides");
    expect(report.pairs[0].conflict_detected).toBe(false);
    expect(report.conflict_count).toBe(0);
  });

  test("detects conflict when co-occurring skill significantly increases errors", () => {
    const telemetry = [
      // pptx alone: 0 errors
      makeSession("s1", ["pptx"], 0),
      makeSession("s2", ["pptx"], 0),
      // pptx + buggy-skill together: 3 errors each
      makeSession("s3", ["pptx", "buggy-skill"], 3),
      makeSession("s4", ["pptx", "buggy-skill"], 3),
    ];
    const report = analyzeComposability("pptx", telemetry);
    expect(report.pairs.length).toBe(1);
    expect(report.pairs[0].skill_b).toBe("buggy-skill");
    expect(report.pairs[0].conflict_detected).toBe(true);
    expect(report.pairs[0].conflict_reason).toBeDefined();
    expect(report.conflict_count).toBe(1);
  });

  test("handles multiple co-occurring skills with mixed conflict status", () => {
    const telemetry = [
      // pptx alone: 1 error average
      makeSession("s1", ["pptx"], 1),
      makeSession("s2", ["pptx"], 1),
      // pptx + safe-skill: 1 error (no conflict)
      makeSession("s3", ["pptx", "safe-skill"], 1),
      // pptx + bad-skill: 5 errors (conflict)
      makeSession("s4", ["pptx", "bad-skill"], 5),
      makeSession("s5", ["pptx", "bad-skill"], 5),
    ];
    const report = analyzeComposability("pptx", telemetry);
    expect(report.pairs.length).toBe(2);
    expect(report.conflict_count).toBe(1);

    const badPair = report.pairs.find((p) => p.skill_b === "bad-skill");
    const safePair = report.pairs.find((p) => p.skill_b === "safe-skill");
    expect(badPair?.conflict_detected).toBe(true);
    expect(safePair?.conflict_detected).toBe(false);
  });

  test("respects window parameter to limit sessions", () => {
    const telemetry = [
      // Older sessions: pptx alone with 0 errors
      makeSession("s1", ["pptx"], 0, "2025-01-01T00:00:00Z"),
      makeSession("s2", ["pptx"], 0, "2025-01-02T00:00:00Z"),
      // Newer sessions: pptx + buggy together with 5 errors
      makeSession("s3", ["pptx", "buggy"], 5, "2025-01-03T00:00:00Z"),
      makeSession("s4", ["pptx", "buggy"], 5, "2025-01-04T00:00:00Z"),
    ];

    // Window=2: only newest 2 sessions (s3, s4 -- both have buggy co-occurrence)
    const report = analyzeComposability("pptx", telemetry, 2);
    expect(report.total_sessions_analyzed).toBe(2);
    // All sessions in window have buggy, no alone sessions
    expect(report.pairs.length).toBe(1);
    expect(report.pairs[0].skill_b).toBe("buggy");
  });

  test("handles empty telemetry array", () => {
    const report = analyzeComposability("pptx", []);
    expect(report.pairs).toEqual([]);
    expect(report.total_sessions_analyzed).toBe(0);
    expect(report.conflict_count).toBe(0);
  });

  test("handles sessions with missing skills_triggered", () => {
    const telemetry = [
      makeSession("s1", ["pptx"], 0),
      // Simulated malformed record (null skills_triggered)
      {
        ...makeSession("s2", [], 0),
        skills_triggered: null as unknown as string[],
      },
    ];
    const report = analyzeComposability("pptx", telemetry);
    // Should not crash; malformed record is filtered out
    expect(report.total_sessions_analyzed).toBe(1);
  });

  test("co_occurrence_count is correct", () => {
    const telemetry = [
      makeSession("s1", ["pptx", "charts"], 0),
      makeSession("s2", ["pptx", "charts"], 1),
      makeSession("s3", ["pptx", "charts"], 0),
      makeSession("s4", ["pptx"], 0),
    ];
    const report = analyzeComposability("pptx", telemetry);
    const chartPair = report.pairs.find((p) => p.skill_b === "charts");
    expect(chartPair?.co_occurrence_count).toBe(3);
  });

  test("conflict_score is clamped between 0 and 1", () => {
    const telemetry = [
      // pptx alone: 0 errors
      makeSession("s1", ["pptx"], 0),
      // pptx + extreme: 100 errors (very high -- score should clamp to 1)
      makeSession("s2", ["pptx", "extreme"], 100),
    ];
    const report = analyzeComposability("pptx", telemetry);
    expect(report.pairs[0].conflict_detected).toBe(true);
    // Score = clamp((100 - 0) / (0 + 1), 0, 1) = clamp(100, 0, 1) = 1
    expect(report.pairs[0].conflict_reason).toContain("conflict_score=1.000");
  });

  test("pairs are sorted by co_occurrence_count descending", () => {
    const telemetry = [
      makeSession("s1", ["pptx", "a"], 0),
      makeSession("s2", ["pptx", "b"], 0),
      makeSession("s3", ["pptx", "b"], 0),
      makeSession("s4", ["pptx", "c"], 0),
      makeSession("s5", ["pptx", "c"], 0),
      makeSession("s6", ["pptx", "c"], 0),
      makeSession("s7", ["pptx"], 0),
    ];
    const report = analyzeComposability("pptx", telemetry);
    expect(report.pairs.length).toBe(3);
    expect(report.pairs[0].skill_b).toBe("c");
    expect(report.pairs[0].co_occurrence_count).toBe(3);
    expect(report.pairs[1].skill_b).toBe("b");
    expect(report.pairs[1].co_occurrence_count).toBe(2);
    expect(report.pairs[2].skill_b).toBe("a");
    expect(report.pairs[2].co_occurrence_count).toBe(1);
  });

  test("report includes generated_at timestamp", () => {
    const report = analyzeComposability("pptx", []);
    expect(report.generated_at).toBeDefined();
    expect(typeof report.generated_at).toBe("string");
    // Should be valid ISO date
    expect(Number.isNaN(Date.parse(report.generated_at))).toBe(false);
  });

  test("conflict threshold is exactly 0.3 (boundary test)", () => {
    // We need conflict_score = exactly 0.3 to NOT flag
    // conflict_score = (errors_together - errors_alone) / (errors_alone + 1)
    // If errors_alone=0: score = errors_together / 1 = errors_together
    // score=0.3 means errors_together=0.3 -- not possible with integers
    // Instead: errors_alone=10, errors_together= 10 + 0.3*11 = 13.3
    // We can't get exactly 0.3 with integers, so test just above and below

    // Just below 0.3: errors_alone=3, errors_together=4
    // score = (4-3)/(3+1) = 0.25 -> no conflict
    const belowThreshold = [
      makeSession("s1", ["pptx"], 3),
      makeSession("s2", ["pptx", "borderline"], 4),
    ];
    const reportBelow = analyzeComposability("pptx", belowThreshold);
    expect(reportBelow.pairs[0].conflict_detected).toBe(false);

    // Just above 0.3: errors_alone=2, errors_together=3
    // score = (3-2)/(2+1) = 0.333 -> conflict
    const aboveThreshold = [
      makeSession("s1", ["pptx"], 2),
      makeSession("s2", ["pptx", "borderline"], 3),
    ];
    const reportAbove = analyzeComposability("pptx", aboveThreshold);
    expect(reportAbove.pairs[0].conflict_detected).toBe(true);
  });
});
