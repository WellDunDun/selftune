import { Schema } from "effect";

export const CorrectionReviewRequest = Schema.Struct({
  candidate_id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)),
  action: Schema.Literals(["accept", "reject", "defer"]),
  reason: Schema.String.check(Schema.isMaxLength(512), Schema.isPattern(/\S/)),
  manifest_digest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
});

export type CorrectionReviewRequest = typeof CorrectionReviewRequest.Type;
