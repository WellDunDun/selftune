import * as Schema from "effect/Schema";

import { MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES } from "./portable-skill-set";

const HostedIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const HostedUploadUrl = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048));
const SkillSetId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

export const HostedDesktopState = Schema.Struct({
  workspaceId: Schema.String,
  plan: Schema.Literals(["free", "pro", "team"]),
  status: Schema.Literals(["none", "trialing", "active", "past_due", "canceled", "unpaid"]),
  currentPeriodEnd: Schema.NullOr(Schema.Number),
});
export type HostedDesktopState = typeof HostedDesktopState.Type;

export const HostedManifestSkill = Schema.Struct({
  identity: Schema.String,
  revision_hash: Schema.String,
  scope: Schema.String,
  connections: Schema.Array(Schema.String),
  update_status: Schema.Literals(["current", "available", "unknown"]),
  usage_status: Schema.Literals(["recent", "stale", "none"]),
});
export type HostedManifestSkill = typeof HostedManifestSkill.Type;

export const HostedManifestRequest = Schema.Struct({
  revision: Schema.String,
  device_name: Schema.String,
  platform: Schema.String,
  skills: Schema.Array(HostedManifestSkill),
});
export type HostedManifestRequest = typeof HostedManifestRequest.Type;

export const HostedManifestReceipt = Schema.Struct({
  uploaded: Schema.Number,
  unchanged: Schema.Number,
});
export type HostedManifestReceipt = typeof HostedManifestReceipt.Type;

/** Privacy-safe revalidation lifecycle. Detailed evidence and environment metadata stay local. */
export const HostedSkillSetRevalidationSummaryRequest = Schema.Struct({
  request_id: HostedIdentifier,
  assignment_id: HostedIdentifier,
  release_id: HostedIdentifier,
  lifecycle_sequence: PositiveInteger,
  status: Schema.Literals(["ready", "needs_review", "could_not_test"]),
  observed_at: PositiveInteger,
});
export type HostedSkillSetRevalidationSummaryRequest =
  typeof HostedSkillSetRevalidationSummaryRequest.Type;

export const HostedSkillSetRevalidationSummaryReceipt = Schema.Struct({
  summary_id: HostedIdentifier,
  request_id: HostedIdentifier,
  assignment_id: HostedIdentifier,
  release_id: HostedIdentifier,
  lifecycle_sequence: PositiveInteger,
  status: Schema.Literals(["ready", "needs_review", "could_not_test"]),
  recorded_at: PositiveInteger,
  idempotent: Schema.Boolean,
});
export type HostedSkillSetRevalidationSummaryReceipt =
  typeof HostedSkillSetRevalidationSummaryReceipt.Type;

export const HostedSkillSetPublishIntentRequest = Schema.Struct({
  skill_set_id: SkillSetId,
  skill_set_revision_sha256: Sha256,
  envelope_sha256: Sha256,
  byte_length: PositiveInteger.check(
    Schema.isLessThanOrEqualTo(MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES),
  ),
});
export type HostedSkillSetPublishIntentRequest = typeof HostedSkillSetPublishIntentRequest.Type;

export const HostedSkillSetPublishIntentReceipt = Schema.Struct({
  publish_intent_id: HostedIdentifier,
  upload_url: HostedUploadUrl,
  expires_at: PositiveInteger,
});
export type HostedSkillSetPublishIntentReceipt = typeof HostedSkillSetPublishIntentReceipt.Type;

/** The direct object upload keeps the existing Convex storage receipt field. */
export const HostedSkillSetPublishUploadReceipt = Schema.Struct({
  storageId: HostedIdentifier,
});
export type HostedSkillSetPublishUploadReceipt = typeof HostedSkillSetPublishUploadReceipt.Type;

export const HostedSkillSetPublishFinalizeRequest = Schema.Struct({
  publish_intent_id: HostedIdentifier,
  storage_id: HostedIdentifier,
});
export type HostedSkillSetPublishFinalizeRequest = typeof HostedSkillSetPublishFinalizeRequest.Type;

export const HostedSkillSetReleaseReceipt = Schema.Struct({
  release_id: HostedIdentifier,
  skill_set_id: SkillSetId,
  sequence: PositiveInteger,
  skill_set_revision_sha256: Sha256,
  envelope_sha256: Sha256,
  published_at: PositiveInteger,
  idempotent: Schema.Boolean,
});
export type HostedSkillSetReleaseReceipt = typeof HostedSkillSetReleaseReceipt.Type;

export const HostedSkillSetPublishErrorReceipt = Schema.Struct({
  error: Schema.Literals(["unauthorized", "invalid_publish_intent", "publish_failed"]),
});
export type HostedSkillSetPublishErrorReceipt = typeof HostedSkillSetPublishErrorReceipt.Type;

export const HostedContributorSignal = Schema.Struct({
  version: Schema.Literal(1),
  signal_type: Schema.Literal("skill_session"),
  source_key: Schema.String,
  skill_name: Schema.optional(Schema.String),
  relay_destination: Schema.String,
  skill_hash: Schema.String,
  user_cohort: Schema.String,
  signals: Schema.Struct({
    triggered: Schema.optional(Schema.Boolean),
    invocation_type: Schema.optional(
      Schema.Literals(["explicit", "implicit", "contextual", "missed"]),
    ),
    execution_grade: Schema.optional(Schema.Literals(["A", "B", "C", "F"])),
    query_bucket: Schema.optional(Schema.String),
    miss_detected: Schema.optional(Schema.Boolean),
  }),
  timestamp_bucket: Schema.String,
  client_version: Schema.String,
});
export type HostedContributorSignal = typeof HostedContributorSignal.Type;

export const HostedContributorAggregate = Schema.Struct({
  observations: Schema.Number,
  cohorts: Schema.Number,
  triggered: Schema.Number,
  missed: Schema.Number,
  grades: Schema.Struct({
    A: Schema.Number,
    B: Schema.Number,
    C: Schema.Number,
    F: Schema.Number,
  }),
});
export type HostedContributorAggregate = typeof HostedContributorAggregate.Type;
