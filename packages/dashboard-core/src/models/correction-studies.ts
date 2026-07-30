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

export interface CorrectionStudyReviewInput {
  readonly candidateId: string;
  readonly action: Exclude<CorrectionReviewAction, "edit">;
  readonly reason: string;
  readonly manifestDigest: string;
}
