import type {
  SkillSetSuggestionReviewDecision,
  SkillSetSuggestionReviewReasonCode,
} from "./contract.js";

export type SkillIntelligenceCalibrationStatus = "insufficient_evidence" | "calibrated";

export interface SkillIntelligenceCalibrationReview {
  algorithm_version: string;
  decision: SkillSetSuggestionReviewDecision;
  reason_code: SkillSetSuggestionReviewReasonCode;
  edit_distance: number | null;
  evidence_score: number;
}

export interface SkillIntelligenceCalibrationCorrection {
  algorithm_version: string;
  category: string | null;
}

export interface SkillIntelligenceCalibration {
  algorithm_version: string;
  status: SkillIntelligenceCalibrationStatus;
  minimum_labeled_reviews: number;
  labeled_reviews: number;
  positive_labels: number;
  negative_labels: number;
  total_reviews: number;
  acceptance_rate: number;
  exact_acceptance_rate: number;
  edit_rate: number;
  mean_edit_distance: number | null;
  dismissal_reasons: Partial<Record<SkillSetSuggestionReviewReasonCode, number>>;
  category_corrections: number;
  applied_min_evidence_score: number;
  balanced_accuracy: number | null;
}

export interface CalibrateSkillIntelligenceInput {
  algorithmVersion: string;
  reviews: ReadonlyArray<SkillIntelligenceCalibrationReview>;
  corrections: ReadonlyArray<SkillIntelligenceCalibrationCorrection>;
  minLabeledReviews?: number;
  minClassLabels?: number;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function balancedAccuracy(
  threshold: number,
  positiveScores: ReadonlyArray<number>,
  negativeScores: ReadonlyArray<number>,
): number {
  const truePositiveRate =
    positiveScores.filter((score) => score >= threshold).length / positiveScores.length;
  const trueNegativeRate =
    negativeScores.filter((score) => score < threshold).length / negativeScores.length;
  return (truePositiveRate + trueNegativeRate) / 2;
}

function isNegativeLabel(reasonCode: SkillSetSuggestionReviewReasonCode): boolean {
  return reasonCode === "not_a_real_pattern" || reasonCode === "skills_should_remain_separate";
}

export function calibrateSkillIntelligence(
  input: CalibrateSkillIntelligenceInput,
): SkillIntelligenceCalibration {
  const minimumLabeledReviews = Math.max(1, input.minLabeledReviews ?? 20);
  const minimumClassLabels = Math.max(1, input.minClassLabels ?? 5);
  const reviews = input.reviews.filter(
    (review) => review.algorithm_version === input.algorithmVersion,
  );
  const accepted = reviews.filter(
    (review) => review.decision === "accepted" || review.decision === "edited",
  );
  const exactAccepted = reviews.filter((review) => review.decision === "accepted");
  const edited = reviews.filter((review) => review.decision === "edited");
  const positiveScores = accepted.map((review) => review.evidence_score);
  const negativeScores = reviews
    .filter((review) => review.decision === "dismissed" && isNegativeLabel(review.reason_code))
    .map((review) => review.evidence_score);
  const editDistances = accepted.flatMap((review) =>
    review.edit_distance === null ? [] : [review.edit_distance],
  );
  const dismissalReasons: Partial<Record<SkillSetSuggestionReviewReasonCode, number>> = {};
  for (const review of reviews) {
    if (review.decision !== "dismissed") continue;
    dismissalReasons[review.reason_code] = (dismissalReasons[review.reason_code] ?? 0) + 1;
  }
  const labeledReviews = positiveScores.length + negativeScores.length;
  const enoughEvidence =
    labeledReviews >= minimumLabeledReviews &&
    positiveScores.length >= minimumClassLabels &&
    negativeScores.length >= minimumClassLabels;

  let appliedMinEvidenceScore = 0;
  let bestBalancedAccuracy: number | null = null;
  if (enoughEvidence) {
    for (const threshold of [...new Set([...positiveScores, ...negativeScores])].toSorted()) {
      const accuracy = balancedAccuracy(threshold, positiveScores, negativeScores);
      if (bestBalancedAccuracy === null || accuracy > bestBalancedAccuracy) {
        bestBalancedAccuracy = accuracy;
        appliedMinEvidenceScore = threshold;
      }
    }
  }

  return {
    algorithm_version: input.algorithmVersion,
    status: enoughEvidence ? "calibrated" : "insufficient_evidence",
    minimum_labeled_reviews: minimumLabeledReviews,
    labeled_reviews: labeledReviews,
    positive_labels: positiveScores.length,
    negative_labels: negativeScores.length,
    total_reviews: reviews.length,
    acceptance_rate: reviews.length > 0 ? round(accepted.length / reviews.length) : 0,
    exact_acceptance_rate: reviews.length > 0 ? round(exactAccepted.length / reviews.length) : 0,
    edit_rate: reviews.length > 0 ? round(edited.length / reviews.length) : 0,
    mean_edit_distance:
      editDistances.length > 0
        ? round(editDistances.reduce((total, value) => total + value, 0) / editDistances.length)
        : null,
    dismissal_reasons: dismissalReasons,
    category_corrections: input.corrections.filter(
      (correction) => correction.algorithm_version === input.algorithmVersion,
    ).length,
    applied_min_evidence_score: round(appliedMinEvidenceScore),
    balanced_accuracy: bestBalancedAccuracy === null ? null : round(bestBalancedAccuracy),
  };
}
