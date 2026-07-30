import { describe, expect, test } from "bun:test";

import { calibrateSkillIntelligence } from "@selftune/skill-intelligence/calibration";

const algorithmVersion = "skill-intelligence-v2-temporal-holdout";

describe("skill intelligence feedback calibration", () => {
  test("does not adjust thresholds before the minimum labeled sample", () => {
    const calibration = calibrateSkillIntelligence({
      algorithmVersion,
      reviews: Array.from({ length: 19 }, (_, index) => ({
        algorithm_version: algorithmVersion,
        decision: index % 2 === 0 ? ("accepted" as const) : ("dismissed" as const),
        reason_code:
          index % 2 === 0 ? ("accepted_as_suggested" as const) : ("not_a_real_pattern" as const),
        edit_distance: 0,
        evidence_score: index % 2 === 0 ? 0.8 : 0.4,
      })),
      corrections: [],
      minLabeledReviews: 20,
    });

    expect(calibration.status).toBe("insufficient_evidence");
    expect(calibration.applied_min_evidence_score).toBe(0);
    expect(calibration.minimum_labeled_reviews).toBe(20);
  });

  test("calibrates a versioned evidence floor after balanced human labels", () => {
    const positive = Array.from({ length: 10 }, (_, index) => ({
      algorithm_version: algorithmVersion,
      decision: index < 6 ? ("accepted" as const) : ("edited" as const),
      reason_code:
        index < 6 ? ("accepted_as_suggested" as const) : ("edited_before_creation" as const),
      edit_distance: index < 6 ? 0 : 0.2,
      evidence_score: 0.72 + index * 0.02,
    }));
    const negative = Array.from({ length: 10 }, (_, index) => ({
      algorithm_version: algorithmVersion,
      decision: "dismissed" as const,
      reason_code:
        index % 2 === 0
          ? ("not_a_real_pattern" as const)
          : ("skills_should_remain_separate" as const),
      edit_distance: null,
      evidence_score: 0.3 + index * 0.02,
    }));
    const calibration = calibrateSkillIntelligence({
      algorithmVersion,
      reviews: [...positive, ...negative],
      corrections: [
        { algorithm_version: algorithmVersion, category: "research" },
        { algorithm_version: algorithmVersion, category: null },
      ],
      minLabeledReviews: 20,
    });

    expect(calibration.status).toBe("calibrated");
    expect(calibration.labeled_reviews).toBe(20);
    expect(calibration.acceptance_rate).toBe(0.5);
    expect(calibration.exact_acceptance_rate).toBe(0.3);
    expect(calibration.mean_edit_distance).toBe(0.08);
    expect(calibration.dismissal_reasons).toEqual({
      not_a_real_pattern: 5,
      skills_should_remain_separate: 5,
    });
    expect(calibration.category_corrections).toBe(2);
    expect(calibration.applied_min_evidence_score).toBeGreaterThan(0.48);
    expect(calibration.applied_min_evidence_score).toBeLessThanOrEqual(0.72);
  });

  test("requires both positive and negative examples before calibration", () => {
    const calibration = calibrateSkillIntelligence({
      algorithmVersion,
      reviews: Array.from({ length: 25 }, (_, index) => ({
        algorithm_version: algorithmVersion,
        decision: "accepted" as const,
        reason_code: "accepted_as_suggested" as const,
        edit_distance: 0,
        evidence_score: 0.6 + index / 100,
      })),
      corrections: [],
      minLabeledReviews: 20,
    });

    expect(calibration.status).toBe("insufficient_evidence");
    expect(calibration.applied_min_evidence_score).toBe(0);
  });
});
