export type CorrectionReviewAction = "accept" | "edit" | "reject" | "defer";

export interface CorrectionStudyReviewModel {
  readonly candidateId: string;
  readonly evidenceLevel: "E0" | "E0.5" | "E1" | "E2";
  readonly observedFailure: string;
  readonly correctionIntent: string;
  readonly proposedChange: { readonly diff?: string; readonly summary?: string } | null;
  readonly evaluation: { readonly summary: string; readonly regressions: readonly string[] } | null;
  readonly limitations: readonly string[];
  readonly manifestDigest: string;
  readonly provenance: readonly string[];
  readonly actions: Readonly<
    Record<CorrectionReviewAction, { readonly available: boolean; readonly reason?: string }>
  >;
}

/**
 * Evidence levels that may ask a reviewer for a decision.
 *
 * E0 and E0.5 are hypotheses: a correlated trace, optionally with a stated
 * correction intent, but no replay. Presenting one in a decision queue asks the
 * reviewer to judge whether a change is an improvement using nothing at all,
 * which is the evaluation work this product exists to perform on their behalf.
 * They remain in the evidence ledger and belong on the skill's own surface as
 * watched signals.
 */
const DECISION_READY_EVIDENCE: ReadonlySet<CorrectionStudyReviewModel["evidenceLevel"]> = new Set<
  CorrectionStudyReviewModel["evidenceLevel"]
>(["E1", "E2"]);

/**
 * Whether a study has enough evidence to be worth a human decision. A replayed
 * level without an evaluation result is also excluded: the level claims a
 * comparison that the payload cannot show.
 */
export function isDecisionReady(review: CorrectionStudyReviewModel): boolean {
  return DECISION_READY_EVIDENCE.has(review.evidenceLevel) && review.evaluation !== null;
}

export interface CorrectionStudyReviewInput {
  readonly candidateId: string;
  readonly action: Exclude<CorrectionReviewAction, "edit">;
  readonly reason: string;
  readonly manifestDigest: string;
}
