import { Schema } from "effect";
import { InvocationType } from "./evaluation.js";

export const GradingExpectation = Schema.Struct({
  text: Schema.mutableKey(Schema.String),
  passed: Schema.mutableKey(Schema.Boolean),
  evidence: Schema.mutableKey(Schema.String),
  score: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
  source: Schema.mutableKey(Schema.optionalKey(Schema.Literals(["pre-gate", "llm"]))),
});
export type GradingExpectation = typeof GradingExpectation.Type;

export const GradingClaim = Schema.Struct({
  claim: Schema.mutableKey(Schema.String),
  type: Schema.mutableKey(Schema.Literals(["factual", "process", "quality"])),
  verified: Schema.mutableKey(Schema.Boolean),
  evidence: Schema.mutableKey(Schema.String),
});
export type GradingClaim = typeof GradingClaim.Type;

export const GradingSummary = Schema.Struct({
  passed: Schema.mutableKey(Schema.Number),
  failed: Schema.mutableKey(Schema.Number),
  total: Schema.mutableKey(Schema.Number),
  pass_rate: Schema.mutableKey(Schema.Number),
  mean_score: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
  score_std_dev: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
});
export type GradingSummary = typeof GradingSummary.Type;

export const FailureFeedback = Schema.Struct({
  query: Schema.mutableKey(Schema.String),
  failure_reason: Schema.mutableKey(Schema.String),
  improvement_hint: Schema.mutableKey(Schema.String),
  invocation_type: Schema.mutableKey(Schema.optionalKey(InvocationType)),
});
export type FailureFeedback = typeof FailureFeedback.Type;

export const EvalFeedback = Schema.Struct({
  suggestions: Schema.mutableKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          assertion: Schema.mutableKey(Schema.String),
          reason: Schema.mutableKey(Schema.String),
        }),
      ),
    ),
  ),
  overall: Schema.mutableKey(Schema.String),
});
export type EvalFeedback = typeof EvalFeedback.Type;

export const GraderOutput = Schema.Struct({
  expectations: Schema.mutableKey(Schema.mutable(Schema.Array(GradingExpectation))),
  summary: Schema.mutableKey(GradingSummary),
  claims: Schema.mutableKey(Schema.mutable(Schema.Array(GradingClaim))),
  eval_feedback: Schema.mutableKey(EvalFeedback),
  failure_feedback: Schema.mutableKey(
    Schema.optionalKey(Schema.mutable(Schema.Array(FailureFeedback))),
  ),
});
export type GraderOutput = typeof GraderOutput.Type;
