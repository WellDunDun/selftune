import * as Schema from "effect/Schema";

import { MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES } from "./portable-skill-set";

export const MAXIMUM_HOSTED_SKILL_SET_CONTRIBUTIONS = 100;
export const MAXIMUM_HOSTED_SKILL_SET_CONTRIBUTION_CHANGES = 500;

const OpaqueIdentifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
);
const SkillSetIdentifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const BoundedCount = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(10_000),
);
const BoundedName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const BoundedTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const BoundedMessage = Schema.String.check(Schema.isMaxLength(4_000));
const BoundedSummary = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));
const BoundedPackagePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((path) => !path.includes("\0") && !path.includes("\\"), {
    message: "Package paths must not contain NUL or backslash characters.",
  }),
);
const BoundedReviewDiff = Schema.String.check(Schema.isMaxLength(200_000));

/**
 * An explicit submit action references package bytes that were already uploaded.
 * Computed change metadata is intentionally absent: the server derives it from
 * the base release and proposed package rather than trusting a client summary.
 */
const HostedSkillSetContributionSubmitCommon = {
  request_id: OpaqueIdentifier,
  skill_set_id: SkillSetIdentifier,
  base_release_id: OpaqueIdentifier,
  proposed_skill_set_revision_sha256: Sha256,
  proposed_envelope_sha256: Sha256,
  proposed_byte_length: PositiveInteger.check(
    Schema.isLessThanOrEqualTo(MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES),
  ),
  title: BoundedTitle,
  message: BoundedMessage,
} as const;

export const HostedSkillSetContributionUploadIntentRequest = Schema.Struct({
  ...HostedSkillSetContributionSubmitCommon,
});
export type HostedSkillSetContributionUploadIntentRequest =
  typeof HostedSkillSetContributionUploadIntentRequest.Type;

export const HostedSkillSetContributionUploadIntentReceipt = Schema.Struct({
  request_id: OpaqueIdentifier,
  upload_url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
  expires_at: PositiveInteger,
});
export type HostedSkillSetContributionUploadIntentReceipt =
  typeof HostedSkillSetContributionUploadIntentReceipt.Type;

export const HostedSkillSetContributionUploadReceipt = Schema.Struct({
  storageId: OpaqueIdentifier,
});
export type HostedSkillSetContributionUploadReceipt =
  typeof HostedSkillSetContributionUploadReceipt.Type;

export const HostedSkillSetContributionSubmitRequest = Schema.Struct({
  ...HostedSkillSetContributionSubmitCommon,
  package_storage_id: OpaqueIdentifier,
});
export type HostedSkillSetContributionSubmitRequest =
  typeof HostedSkillSetContributionSubmitRequest.Type;

const HostedSkillSetContributionChangeCommon = {
  component_name: BoundedName,
  package_path: BoundedPackagePath,
  summary: BoundedSummary,
} as const;

export const HostedSkillSetContributionChange = Schema.Union([
  Schema.Struct({
    ...HostedSkillSetContributionChangeCommon,
    change_type: Schema.Literal("added"),
    base_sha256: Schema.Null,
    proposed_sha256: Sha256,
  }),
  Schema.Struct({
    ...HostedSkillSetContributionChangeCommon,
    change_type: Schema.Literal("modified"),
    base_sha256: Sha256,
    proposed_sha256: Sha256,
  }).check(
    Schema.makeFilter((change) => change.base_sha256 !== change.proposed_sha256, {
      message: "Expected a modified file to have distinct base and proposed hashes",
    }),
  ),
  Schema.Struct({
    ...HostedSkillSetContributionChangeCommon,
    change_type: Schema.Literal("removed"),
    base_sha256: Sha256,
    proposed_sha256: Schema.Null,
  }),
]);
export type HostedSkillSetContributionChange = typeof HostedSkillSetContributionChange.Type;

/** Server-derived, bounded review metadata; never accepted on submit. */
export const HostedSkillSetContributionChangeManifest = Schema.Struct({
  base_skill_set_revision_sha256: Sha256,
  proposed_skill_set_revision_sha256: Sha256,
  added_files: BoundedCount,
  modified_files: BoundedCount,
  removed_files: BoundedCount,
  changes: Schema.Array(HostedSkillSetContributionChange).check(
    Schema.isMaxLength(MAXIMUM_HOSTED_SKILL_SET_CONTRIBUTION_CHANGES),
  ),
});
export type HostedSkillSetContributionChangeManifest =
  typeof HostedSkillSetContributionChangeManifest.Type;

export const HostedSkillSetContributionReadiness = Schema.Struct({
  status: Schema.Literals(["ready", "blocked", "not_recorded"]),
  checked_components: BoundedCount,
  blocked_components: BoundedCount,
  summary: Schema.NullOr(BoundedSummary),
});
export type HostedSkillSetContributionReadiness = typeof HostedSkillSetContributionReadiness.Type;

/** Immutable proposal projection. Review decisions are separate records. */
export const HostedSkillSetContributionProposal = Schema.Struct({
  contribution_id: OpaqueIdentifier,
  request_id: OpaqueIdentifier,
  skill_set_id: SkillSetIdentifier,
  base_release_id: OpaqueIdentifier,
  proposed_skill_set_revision_sha256: Sha256,
  proposed_envelope_sha256: Sha256,
  proposed_byte_length: PositiveInteger.check(
    Schema.isLessThanOrEqualTo(MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES),
  ),
  title: BoundedTitle,
  message: BoundedMessage,
  submitted_by_member_id: OpaqueIdentifier,
  submitted_by_name: Schema.NullOr(BoundedName),
  submitted_at: PositiveInteger,
  change_manifest: HostedSkillSetContributionChangeManifest,
  readiness: HostedSkillSetContributionReadiness,
  review_diff: BoundedReviewDiff,
});
export type HostedSkillSetContributionProposal = typeof HostedSkillSetContributionProposal.Type;

export const HostedSkillSetContributionSubmitReceipt = Schema.Struct({
  proposal: HostedSkillSetContributionProposal,
  idempotent: Schema.Boolean,
});
export type HostedSkillSetContributionSubmitReceipt =
  typeof HostedSkillSetContributionSubmitReceipt.Type;

export const HostedSkillSetContributionListRequest = Schema.Struct({
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(MAXIMUM_HOSTED_SKILL_SET_CONTRIBUTIONS),
    ),
  ),
});
export type HostedSkillSetContributionListRequest =
  typeof HostedSkillSetContributionListRequest.Type;

export const HostedSkillSetContributionListReceipt = Schema.Struct({
  proposals: Schema.Array(HostedSkillSetContributionProposal).check(
    Schema.isMaxLength(MAXIMUM_HOSTED_SKILL_SET_CONTRIBUTIONS),
  ),
});
export type HostedSkillSetContributionListReceipt =
  typeof HostedSkillSetContributionListReceipt.Type;

export const HostedSkillSetContributionDecisionRequest = Schema.Struct({
  request_id: OpaqueIdentifier,
  contribution_id: OpaqueIdentifier,
  decision: Schema.Literals(["approved", "rejected"]),
  review_note: BoundedMessage,
});
export type HostedSkillSetContributionDecisionRequest =
  typeof HostedSkillSetContributionDecisionRequest.Type;

export const HostedSkillSetContributionReleaseReference = Schema.Struct({
  release_id: OpaqueIdentifier,
  skill_set_id: SkillSetIdentifier,
  sequence: PositiveInteger,
  skill_set_revision_sha256: Sha256,
  envelope_sha256: Sha256,
  published_at: PositiveInteger,
});
export type HostedSkillSetContributionReleaseReference =
  typeof HostedSkillSetContributionReleaseReference.Type;

const HostedSkillSetContributionDecisionCommon = {
  decision_id: OpaqueIdentifier,
  request_id: OpaqueIdentifier,
  contribution_id: OpaqueIdentifier,
  base_release_id: OpaqueIdentifier,
  review_note: BoundedMessage,
  decided_by_member_id: OpaqueIdentifier,
  decided_by_name: Schema.NullOr(BoundedName),
  decided_at: PositiveInteger,
  idempotent: Schema.Boolean,
} as const;

const HostedSkillSetContributionApprovalReceipt = Schema.Struct({
  ...HostedSkillSetContributionDecisionCommon,
  decision: Schema.Literal("approved"),
  release: HostedSkillSetContributionReleaseReference,
}).check(
  Schema.makeFilter(
    (receipt) => receipt.release.release_id !== receipt.base_release_id,
    { message: "Expected approval to create a release distinct from the base release" },
    true,
  ),
);

const HostedSkillSetContributionRejectionReceipt = Schema.Struct({
  ...HostedSkillSetContributionDecisionCommon,
  decision: Schema.Literal("rejected"),
  release: Schema.Null,
});

/** Immutable decision receipt. Approval atomically references the new release. */
export const HostedSkillSetContributionDecisionReceipt = Schema.Union([
  HostedSkillSetContributionApprovalReceipt,
  HostedSkillSetContributionRejectionReceipt,
]);
export type HostedSkillSetContributionDecisionReceipt =
  typeof HostedSkillSetContributionDecisionReceipt.Type;

export const HostedSkillSetContributionErrorReceipt = Schema.Struct({
  error: Schema.Literals([
    "unauthorized",
    "invalid_contribution",
    "contribution_conflict",
    "contribution_already_decided",
    "contribution_failed",
  ]),
});
export type HostedSkillSetContributionErrorReceipt =
  typeof HostedSkillSetContributionErrorReceipt.Type;
