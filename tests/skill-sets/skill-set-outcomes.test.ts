import { describe, expect, test } from "bun:test";

import {
  measureSkillSetOutcome,
  type SkillSetOutcomeSession,
} from "@selftune/skill-intelligence/outcomes";

function sessions(
  prefix: string,
  startDay: number,
  count: number,
  values: {
    completion: "completed" | "failed";
    errors: number;
    tokens: number;
  },
): SkillSetOutcomeSession[] {
  return Array.from({ length: count }, (_, index) => ({
    session_id: `${prefix}-${index + 1}`,
    timestamp: `2026-05-${String(startDay + index).padStart(2, "0")}T00:00:00.000Z`,
    cwd: "/work/atlas",
    completion_status: values.completion,
    errors_encountered: values.errors,
    input_tokens: Math.round(values.tokens * 0.8),
    output_tokens: Math.round(values.tokens * 0.2),
  }));
}

function measure(input: {
  before: SkillSetOutcomeSession[];
  after: SkillSetOutcomeSession[];
  beforeTriggered?: number;
  afterTriggered?: number;
  beforeGrade?: number;
  afterGrade?: number;
}) {
  const allSessions = [...input.before, ...input.after];
  const observations = allSessions.flatMap((session, index) => [
    {
      session_id: session.session_id,
      skill_name: "research",
      triggered:
        index < input.before.length
          ? index < (input.beforeTriggered ?? input.before.length)
          : index - input.before.length < (input.afterTriggered ?? input.after.length),
    },
  ]);
  const gradingResults = allSessions.map((session, index) => ({
    session_id: session.session_id,
    skill_name: "research",
    pass_rate: index < input.before.length ? (input.beforeGrade ?? 0.7) : (input.afterGrade ?? 0.7),
  }));
  return measureSkillSetOutcome({
    activation: {
      review_id: "review-one",
      receipt_id: "receipt-one",
      set_id: "research-set",
      algorithm_version: "skill-intelligence-v2-temporal-holdout",
      project_root: "/work/atlas",
      activated_at: "2026-05-10T00:00:00.000Z",
      skill_names: ["research"],
    },
    sessions: allSessions,
    observations,
    gradingResults,
    minSessions: 5,
    now: new Date("2026-05-20T00:00:00.000Z"),
  });
}

describe("accepted Skill Set outcomes", () => {
  test("reports improvement only when enough sessions improve across several metrics", () => {
    const outcome = measure({
      before: sessions("before", 1, 6, { completion: "failed", errors: 2, tokens: 1_000 }),
      after: sessions("after", 10, 6, { completion: "completed", errors: 0, tokens: 700 }),
      beforeTriggered: 3,
      afterTriggered: 6,
      beforeGrade: 0.6,
      afterGrade: 0.9,
    });

    expect(outcome.status).toBe("improved");
    expect(outcome.before_session_count).toBe(6);
    expect(outcome.after_session_count).toBe(6);
    expect(outcome.metrics.completion_quality).toMatchObject({
      before: 0,
      after: 1,
      direction: "improved",
    });
    expect(outcome.metrics.trigger_coverage).toMatchObject({
      before: 0.5,
      after: 1,
      direction: "improved",
    });
    expect(outcome.metrics.token_cost.direction).toBe("improved");
    expect(outcome.metrics.grading.direction).toBe("improved");
    expect(outcome.causal_claim).toBe(false);
  });

  test("keeps small samples inconclusive", () => {
    const outcome = measure({
      before: sessions("before", 1, 2, { completion: "failed", errors: 3, tokens: 1_500 }),
      after: sessions("after", 10, 2, { completion: "completed", errors: 0, tokens: 500 }),
      beforeTriggered: 0,
      afterTriggered: 2,
      beforeGrade: 0.2,
      afterGrade: 1,
    });

    expect(outcome.status).toBe("inconclusive");
    expect(outcome.reason).toContain("at least 5 sessions");
  });

  test("reports regression only when enough metrics consistently worsen", () => {
    const outcome = measure({
      before: sessions("before", 1, 6, { completion: "completed", errors: 0, tokens: 600 }),
      after: sessions("after", 10, 6, { completion: "failed", errors: 2, tokens: 1_200 }),
      beforeTriggered: 6,
      afterTriggered: 2,
      beforeGrade: 0.9,
      afterGrade: 0.5,
    });

    expect(outcome.status).toBe("regressed");
    expect(outcome.metrics.error_rate.direction).toBe("regressed");
    expect(outcome.metrics.token_cost.direction).toBe("regressed");
  });

  test("includes sessions run in project subdirectories and excludes sibling projects", () => {
    const before = sessions("before", 1, 5, {
      completion: "failed",
      errors: 2,
      tokens: 1_000,
    }).map((session) => ({ ...session, cwd: "/work/atlas/packages/api" }));
    const after = sessions("after", 10, 5, {
      completion: "completed",
      errors: 0,
      tokens: 700,
    }).map((session) => ({ ...session, cwd: "/work/atlas/apps/dashboard" }));
    after.push({
      ...after[0],
      session_id: "sibling-project",
      cwd: "/work/atlas-other",
    });

    const outcome = measure({ before, after });

    expect(outcome.before_session_count).toBe(5);
    expect(outcome.after_session_count).toBe(5);
    expect(outcome.status).toBe("improved");
  });
});
