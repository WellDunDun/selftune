import * as Schema from "effect/Schema";

export const SynthesisCandidateKind = Schema.Literals([
  "coverage_gap",
  "workflow_combination",
  "routing_problem",
  "stale_skill",
]);
export type SynthesisCandidateKind = typeof SynthesisCandidateKind.Type;

export const SynthesisCandidateStatus = Schema.Literals([
  "pending",
  "accepted",
  "rejected",
  "snoozed",
  "drafted",
  "released",
]);
export type SynthesisCandidateStatus = typeof SynthesisCandidateStatus.Type;

export const EvidenceSession = Schema.Struct({
  sessionId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
  successful: Schema.Boolean,
  outcomeScore: Schema.NullOr(Schema.Number),
  orderedSkills: Schema.Array(Schema.String),
  query: Schema.String,
});
export type EvidenceSession = typeof EvidenceSession.Type;

export const CandidateEvidence = Schema.Struct({
  evidenceVersion: Schema.Literal(1),
  supportSessions: Schema.Number,
  projectDiversity: Schema.Number,
  temporalSpanDays: Schema.Number,
  outcomeQuality: Schema.Number,
  coUsageLift: Schema.NullOr(Schema.Number),
  sequenceConsistency: Schema.NullOr(Schema.Number),
  completionRate: Schema.NullOr(Schema.Number),
  confidence: Schema.Number,
  uncertainty: Schema.Number,
  exploratory: Schema.Boolean,
});
export type CandidateEvidence = typeof CandidateEvidence.Type;

export const SynthesisDecision = Schema.Struct({
  action: Schema.Literals(["accept", "reject", "snooze", "edit"]),
  reason: Schema.String,
  decidedAt: Schema.String,
  snoozedUntil: Schema.NullOr(Schema.String),
});
export type SynthesisDecision = typeof SynthesisDecision.Type;

export const CandidateEvidenceExample = Schema.Struct({
  sessionId: Schema.String,
  excerpt: Schema.String,
});
export type CandidateEvidenceExample = typeof CandidateEvidenceExample.Type;

export const SynthesisCandidate = Schema.Struct({
  candidateId: Schema.String,
  kind: SynthesisCandidateKind,
  title: Schema.String,
  summary: Schema.String,
  skillNames: Schema.Array(Schema.String),
  evidence: CandidateEvidence,
  supportingSessionIds: Schema.Array(Schema.String),
  heldOutSessionIds: Schema.Array(Schema.String),
  supportingExamples: Schema.optionalKey(Schema.Array(CandidateEvidenceExample)),
  heldOutExamples: Schema.optionalKey(Schema.Array(CandidateEvidenceExample)),
  redactedExcerpts: Schema.Array(Schema.String),
  generatedAt: Schema.String,
  status: SynthesisCandidateStatus,
  decision: Schema.NullOr(SynthesisDecision),
  decisionHistory: Schema.Array(SynthesisDecision),
});
export type SynthesisCandidate = typeof SynthesisCandidate.Type;

export const CandidateSnapshot = Schema.Struct({
  snapshotId: Schema.String,
  evidenceVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  candidates: Schema.Array(SynthesisCandidate),
});
export type CandidateSnapshot = typeof CandidateSnapshot.Type;

export class CandidateNotFound extends Schema.TaggedErrorClass<CandidateNotFound>()(
  "CandidateNotFound",
  { candidateId: Schema.String },
) {}

export class CandidateStoreUnavailable extends Schema.TaggedErrorClass<CandidateStoreUnavailable>()(
  "CandidateStoreUnavailable",
  { operation: Schema.String, message: Schema.String },
) {}
