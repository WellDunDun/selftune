import { Schema } from "effect";

const NullableString = Schema.NullOr(Schema.String);
const NullableNumber = Schema.NullOr(Schema.Number);
const CloudEvaluationId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  // oxlint-disable-next-line no-control-regex -- portable identifiers reject ASCII control bytes.
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
);
const CloudEvaluationName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  // oxlint-disable-next-line no-control-regex -- portable names reject ASCII control bytes.
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
);
const CloudPackageRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const CloudManifestDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
const CloudRepetitionCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }));

export class CloudImproveRun extends Schema.Class<CloudImproveRun>("CloudImproveRun")({
  id: Schema.String,
  sourceId: Schema.String,
  snapshotId: Schema.String,
  evalSuiteId: NullableString,
  status: Schema.String,
  phase: NullableString,
  applyTarget: Schema.String,
  providerModel: NullableString,
  startedAt: NullableString,
  completedAt: NullableString,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

/** Read-only, case-free handoff from a local trace candidate to Cloud evaluation. */
export class CloudEvaluationTarget extends Schema.Class<CloudEvaluationTarget>(
  "CloudEvaluationTarget",
)({
  source_id: CloudEvaluationId,
  snapshot_id: CloudEvaluationId,
  skill_id: CloudEvaluationId,
  skill_name: CloudEvaluationName,
  skill_revision: CloudPackageRevision,
  suite_id: CloudEvaluationId,
  suite_name: CloudEvaluationName,
  lane: Schema.Literals(["structural_validation", "trigger_routing", "outcome_task"]),
  manifest_digest: CloudManifestDigest,
  verifier_kind: CloudEvaluationId,
  min_repetitions: CloudRepetitionCount,
  max_repetitions: CloudRepetitionCount,
  verification_only: Schema.Boolean,
}) {}

export class CloudEvaluationTargetBlocker extends Schema.Class<CloudEvaluationTargetBlocker>(
  "CloudEvaluationTargetBlocker",
)({
  code: CloudEvaluationId,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)),
  suite_id: Schema.optional(CloudEvaluationId),
}) {}

export class CloudEvaluationTargetDiscovery extends Schema.Class<CloudEvaluationTargetDiscovery>(
  "CloudEvaluationTargetDiscovery",
)({
  targets: Schema.Array(CloudEvaluationTarget).check(Schema.isMaxLength(50)),
  blockers: Schema.Array(CloudEvaluationTargetBlocker).check(Schema.isMaxLength(100)),
}) {}

export class CloudEvaluationTargetQuery extends Schema.Class<CloudEvaluationTargetQuery>(
  "CloudEvaluationTargetQuery",
)({
  skill_name: CloudEvaluationName,
  // This is the canonical package-manifest SHA-256, not the archive hash.
  skill_revision: CloudPackageRevision,
}) {}

export class CloudImproveCandidate extends Schema.Class<CloudImproveCandidate>(
  "CloudImproveCandidate",
)({
  id: Schema.String,
  status: Schema.String,
  candidateIndex: Schema.Int,
  diffText: NullableString,
  currentSkillScore: NullableNumber,
  candidateSkillScore: NullableNumber,
  improvementPct: NullableNumber,
}) {}

export class CloudImproveRunDetail extends Schema.Class<CloudImproveRunDetail>(
  "CloudImproveRunDetail",
)({
  ...CloudImproveRun.fields,
  candidates: Schema.Array(CloudImproveCandidate),
  outcome: NullableString,
}) {}

export class CloudImproveRunList extends Schema.Class<CloudImproveRunList>("CloudImproveRunList")({
  runs: Schema.Array(CloudImproveRun),
  total: Schema.Int,
}) {}

export const CloudProposalStatus = Schema.Literals(["pending", "approved", "rejected", "applied"]);
export type CloudProposalStatus = Schema.Schema.Type<typeof CloudProposalStatus>;

export class CloudProposal extends Schema.Class<CloudProposal>("CloudProposal")({
  id: Schema.String,
  skillId: Schema.String,
  skillName: Schema.String,
  proposalType: Schema.String,
  currentValue: Schema.String,
  proposedValue: Schema.String,
  rationale: NullableString,
  passRateBefore: NullableNumber,
  projectedPassRate: NullableNumber,
  status: CloudProposalStatus,
  createdAt: Schema.String,
  reviewedAt: NullableString,
  appliedAt: NullableString,
  runId: NullableString,
  candidateId: NullableString,
  applyTarget: NullableString,
  diffText: NullableString,
}) {}

export class CloudProposalList extends Schema.Class<CloudProposalList>("CloudProposalList")({
  proposals: Schema.Array(CloudProposal),
  total: Schema.Int,
}) {}

export class CloudProposalQuery extends Schema.Class<CloudProposalQuery>("CloudProposalQuery")({
  runId: Schema.optional(Schema.String),
}) {}

export class CloudProposalReviewInput extends Schema.Class<CloudProposalReviewInput>(
  "CloudProposalReviewInput",
)({
  status: Schema.Literals(["approved", "rejected"]),
}) {}

export class CloudProposalApplyInput extends Schema.Class<CloudProposalApplyInput>(
  "CloudProposalApplyInput",
)({
  applyTarget: Schema.optional(Schema.Literals(["draft", "github_pr"])),
}) {}

export class CloudProposalApplyResult extends Schema.Class<CloudProposalApplyResult>(
  "CloudProposalApplyResult",
)({
  proposalId: Schema.String,
  status: CloudProposalStatus,
  applyTarget: Schema.String,
  message: Schema.String,
}) {}

export const CloudImproveApiPaths = {
  evaluationTargets: "/api/v1/cloud/evaluation-targets",
  runs: "/api/v1/cloud/improve-runs",
  run: "/api/v1/cloud/improve-runs/:runId",
  proposals: "/api/v1/cloud/proposals",
  proposal: "/api/v1/cloud/proposals/:proposalId",
  proposalApply: "/api/v1/cloud/proposals/:proposalId/apply",
} as const;
