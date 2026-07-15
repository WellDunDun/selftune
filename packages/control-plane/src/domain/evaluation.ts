import * as Schema from "effect/Schema";

export const EvalCaseKind = Schema.Literals(["positive", "negative", "boundary", "execution"]);
export type EvalCaseKind = typeof EvalCaseKind.Type;

export const GeneratedEvalCase = Schema.Struct({
  evalId: Schema.String,
  kind: EvalCaseKind,
  query: Schema.String,
  expectedSkillNames: Schema.Array(Schema.String),
  sourceSessionIds: Schema.Array(Schema.String),
  evidenceSnapshotId: Schema.String,
  heldOut: Schema.Boolean,
});
export type GeneratedEvalCase = typeof GeneratedEvalCase.Type;

export const BaselineResult = Schema.Struct({
  baseline: Schema.Literals(["no_skill", "existing_skills", "composite", "sibling_bundle"]),
  caseCount: Schema.Number,
  activationAccuracy: Schema.Number,
  routingQuality: Schema.Number,
  outcomeQuality: Schema.Number,
  contextTokens: Schema.Number,
  regressions: Schema.Array(Schema.String),
});
export type BaselineResult = typeof BaselineResult.Type;

export const ReleaseGateInput = Schema.Struct({
  candidateId: Schema.String,
  evidenceSnapshotId: Schema.String,
  packageValid: Schema.Boolean,
  replayPassed: Schema.Boolean,
  draft: BaselineResult,
  baselines: Schema.Array(BaselineResult),
  minimumOutcomeLift: Schema.Number,
  maximumActivationRegression: Schema.Number,
});
export type ReleaseGateInput = typeof ReleaseGateInput.Type;

export const ReleaseRecommendation = Schema.Struct({
  candidateId: Schema.String,
  recommended: Schema.Boolean,
  outcomeLift: Schema.Number,
  contextTokenDelta: Schema.Number,
  blockers: Schema.Array(Schema.String),
});
export type ReleaseRecommendation = typeof ReleaseRecommendation.Type;
