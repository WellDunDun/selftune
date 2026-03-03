import { describe, expect, it } from "bun:test";
import { aggregateSkillData } from "../../service/aggregation/aggregate.js";
import type { SubmissionRecord } from "../../service/types.js";

function makeSubmission(overrides: Partial<{ passRate: number; sessions: number; contributorId: string; acceptedAt: string }> = {}): SubmissionRecord {
  const { passRate = 0.85, sessions = 10, contributorId = "c1", acceptedAt = "2026-01-15T00:00:00Z" } = overrides;
  return {
    id: 1,
    skill_name: "test-skill",
    contributor_id: contributorId,
    bundle_json: JSON.stringify({
      schema_version: "1.1",
      skill_name: "test-skill",
      contributor_id: contributorId,
      created_at: acceptedAt,
      selftune_version: "0.1.4",
      agent_type: "claude_code",
      sanitization_level: "conservative",
      positive_queries: [],
      eval_entries: [],
      grading_summary: { total_sessions: sessions, graded_sessions: sessions, average_pass_rate: passRate, expectation_count: 20 },
      evolution_summary: null,
      session_metrics: { total_sessions: sessions, avg_assistant_turns: 5, avg_tool_calls: 10, avg_errors: 0, top_tools: [] },
    }),
    ip_hash: "hash1",
    accepted_at: acceptedAt,
  };
}

describe("aggregateSkillData", () => {
  it("returns NO DATA for empty submissions", () => {
    const result = aggregateSkillData("test", []);
    expect(result.status).toBe("NO DATA");
    expect(result.weighted_pass_rate).toBe(0);
    expect(result.contributor_count).toBe(0);
  });

  it("computes weighted pass rate from single submission", () => {
    const sub = makeSubmission({ passRate: 0.85, sessions: 10 });
    const result = aggregateSkillData("test-skill", [sub]);
    expect(result.weighted_pass_rate).toBeCloseTo(0.85, 2);
    expect(result.status).toBe("HEALTHY");
    expect(result.session_count).toBe(10);
    expect(result.contributor_count).toBe(1);
  });

  it("weights by session count across contributors", () => {
    const sub1 = makeSubmission({ passRate: 0.90, sessions: 90, contributorId: "c1" });
    const sub2 = makeSubmission({ passRate: 0.50, sessions: 10, contributorId: "c2" });
    const result = aggregateSkillData("test-skill", [sub1, sub2]);
    // Weighted: (0.90 * 90 + 0.50 * 10) / 100 = 0.86
    expect(result.weighted_pass_rate).toBeCloseTo(0.86, 2);
    expect(result.contributor_count).toBe(2);
    expect(result.session_count).toBe(100);
  });

  it("detects upward trend", () => {
    const sub1 = makeSubmission({ passRate: 0.60, sessions: 5, acceptedAt: "2026-01-01T00:00:00Z" });
    const sub2 = makeSubmission({ passRate: 0.90, sessions: 5, acceptedAt: "2026-01-15T00:00:00Z" });
    const result = aggregateSkillData("test-skill", [sub1, sub2]);
    expect(result.trend).toBe("up");
  });

  it("detects downward trend", () => {
    const sub1 = makeSubmission({ passRate: 0.90, sessions: 5, acceptedAt: "2026-01-01T00:00:00Z" });
    const sub2 = makeSubmission({ passRate: 0.50, sessions: 5, acceptedAt: "2026-01-15T00:00:00Z" });
    const result = aggregateSkillData("test-skill", [sub1, sub2]);
    expect(result.trend).toBe("down");
  });

  it("skips malformed bundle JSON", () => {
    const badSub: SubmissionRecord = {
      id: 1, skill_name: "test", contributor_id: "c1",
      bundle_json: "not json", ip_hash: "h1", accepted_at: "2026-01-01",
    };
    const result = aggregateSkillData("test", [badSub]);
    expect(result.status).toBe("NO DATA");
  });
});
