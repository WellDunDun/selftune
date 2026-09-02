import * as Schema from "effect/Schema";

import { MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES } from "./portable-skill-set";

export const MAXIMUM_HOSTED_SKILL_SET_ASSIGNMENTS = 100;
export const MAXIMUM_HOSTED_SKILL_SET_COMPONENTS = 500;
export const MAXIMUM_HOSTED_TARGET_AGENTS = 8;

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
const BoundedDescription = Schema.String.check(Schema.isMaxLength(2_000));
const LicenseExpression = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const HostedSkillSetUpdatePolicy = Schema.Literals([
  "manual",
  "notify",
  "automatic",
  "ask_before_updating",
]);
export type HostedSkillSetUpdatePolicy = typeof HostedSkillSetUpdatePolicy.Type;

export type CanonicalHostedSkillSetUpdatePolicy = "manual" | "notify" | "automatic";

export function canonicalHostedSkillSetUpdatePolicy(
  policy: HostedSkillSetUpdatePolicy,
): CanonicalHostedSkillSetUpdatePolicy {
  return policy === "ask_before_updating" ? "manual" : policy;
}

export const HostedSkillSetAssignmentCreateRequest = Schema.Struct({
  request_id: OpaqueIdentifier,
  release_id: OpaqueIdentifier,
  target_member_id: OpaqueIdentifier,
  target_device_id: OpaqueIdentifier,
  update_policy: HostedSkillSetUpdatePolicy,
});
export type HostedSkillSetAssignmentCreateRequest =
  typeof HostedSkillSetAssignmentCreateRequest.Type;

export const HostedSkillSetAssignmentCreateReceipt = Schema.Struct({
  assignment_id: OpaqueIdentifier,
  release_id: OpaqueIdentifier,
  skill_set_id: SkillSetIdentifier,
  sequence: PositiveInteger,
  target_member_id: OpaqueIdentifier,
  target_device_id: OpaqueIdentifier,
  supersedes_assignment_id: Schema.NullOr(OpaqueIdentifier),
  assigned_at: PositiveInteger,
  idempotent: Schema.Boolean,
});
export type HostedSkillSetAssignmentCreateReceipt =
  typeof HostedSkillSetAssignmentCreateReceipt.Type;

export const HostedSkillSetAssignmentListRequest = Schema.Struct({
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(MAXIMUM_HOSTED_SKILL_SET_ASSIGNMENTS),
    ),
  ),
});
export type HostedSkillSetAssignmentListRequest = typeof HostedSkillSetAssignmentListRequest.Type;

export const HostedSkillSetAssignmentComponent = Schema.Struct({
  name: BoundedName,
  license_expression: LicenseExpression,
});
export type HostedSkillSetAssignmentComponent = typeof HostedSkillSetAssignmentComponent.Type;

export const HostedSkillSetReadinessSummary = Schema.Struct({
  status: Schema.Literals(["ready", "blocked", "not_recorded"]),
  checked_components: BoundedCount,
  blocked_components: BoundedCount,
});
export type HostedSkillSetReadinessSummary = typeof HostedSkillSetReadinessSummary.Type;

export const HostedSkillSetReceiptFailureCode = Schema.Literals([
  "INSTALL_FAILED",
  "INSTALL_CONFLICT",
  "PACKAGE_INTEGRITY_FAILED",
  "LOCAL_STATE_CHANGED",
  "RECOVERY_FAILED",
]);
export type HostedSkillSetReceiptFailureCode = typeof HostedSkillSetReceiptFailureCode.Type;

export const HostedSkillSetObservedState = Schema.Struct({
  status: Schema.Literals(["unknown", "current", "failed", "rolled_back"]),
  lifecycle_sequence: Schema.NullOr(PositiveInteger),
  receipt_id: Schema.NullOr(OpaqueIdentifier),
  observed_release_id: Schema.NullOr(OpaqueIdentifier),
  observed_at: Schema.NullOr(PositiveInteger),
  failure_code: Schema.NullOr(HostedSkillSetReceiptFailureCode),
});
export type HostedSkillSetObservedState = typeof HostedSkillSetObservedState.Type;

export const HostedSkillSetAssignment = Schema.Struct({
  assignment_id: OpaqueIdentifier,
  request_id: OpaqueIdentifier,
  release_id: OpaqueIdentifier,
  skill_set_id: SkillSetIdentifier,
  name: BoundedName,
  description: BoundedDescription,
  publisher_name: Schema.NullOr(BoundedName),
  sequence: PositiveInteger,
  skill_set_revision_sha256: Sha256,
  envelope_sha256: Sha256,
  byte_length: PositiveInteger.check(
    Schema.isLessThanOrEqualTo(MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES),
  ),
  assigned_at: PositiveInteger,
  update_policy: HostedSkillSetUpdatePolicy,
  components: Schema.Array(HostedSkillSetAssignmentComponent).check(
    Schema.isMaxLength(MAXIMUM_HOSTED_SKILL_SET_COMPONENTS),
  ),
  harnesses: Schema.Array(BoundedName).check(Schema.isMaxLength(MAXIMUM_HOSTED_TARGET_AGENTS)),
  readiness: HostedSkillSetReadinessSummary,
  release_lifecycle: Schema.optionalKey(Schema.Literals(["draft", "promoted", "deprecated"])),
  observed: HostedSkillSetObservedState,
});
export type HostedSkillSetAssignment = typeof HostedSkillSetAssignment.Type;

export const HostedSkillSetAssignmentListReceipt = Schema.Struct({
  assignments: Schema.Array(HostedSkillSetAssignment).check(
    Schema.isMaxLength(MAXIMUM_HOSTED_SKILL_SET_ASSIGNMENTS),
  ),
});
export type HostedSkillSetAssignmentListReceipt = typeof HostedSkillSetAssignmentListReceipt.Type;

export const HostedSkillSetAssignmentPackageRequest = Schema.Struct({
  assignment_id: OpaqueIdentifier,
});
export type HostedSkillSetAssignmentPackageRequest =
  typeof HostedSkillSetAssignmentPackageRequest.Type;

export const HostedSkillSetAssignmentPackageMetadata = Schema.Struct({
  assignment_id: OpaqueIdentifier,
  release_id: OpaqueIdentifier,
  envelope_sha256: Sha256,
  byte_length: PositiveInteger.check(
    Schema.isLessThanOrEqualTo(MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES),
  ),
});
export type HostedSkillSetAssignmentPackageMetadata =
  typeof HostedSkillSetAssignmentPackageMetadata.Type;

export const HostedInstallerAgent = Schema.Literals([
  "codex",
  "claude_code",
  "opencode",
  "openclaw",
  "pi",
]);
export type HostedInstallerAgent = typeof HostedInstallerAgent.Type;

const UniqueHostedInstallerAgents = Schema.Array(HostedInstallerAgent).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAXIMUM_HOSTED_TARGET_AGENTS),
  Schema.makeFilter(
    (agents) => new Set(agents).size === agents.length,
    { message: "Expected unique target agents" },
    true,
  ),
);

const InstallationReceiptCommonFields = {
  request_id: OpaqueIdentifier,
  assignment_id: OpaqueIdentifier,
  release_id: OpaqueIdentifier,
  lifecycle_sequence: PositiveInteger,
  coarse_scope: Schema.Literals(["global", "project"]),
  target_agents: UniqueHostedInstallerAgents,
  changed_skill_count: BoundedCount,
  blocked_skill_count: BoundedCount,
  occurred_at: PositiveInteger,
} as const;

export const HostedSkillSetInstallationReceiptRequest = Schema.Union([
  Schema.Struct({
    ...InstallationReceiptCommonFields,
    result: Schema.Literal("current"),
    rollback_pointer: OpaqueIdentifier,
    failure_code: Schema.Null,
  }),
  Schema.Struct({
    ...InstallationReceiptCommonFields,
    result: Schema.Literal("failed"),
    rollback_pointer: Schema.NullOr(OpaqueIdentifier),
    failure_code: HostedSkillSetReceiptFailureCode,
  }),
  Schema.Struct({
    ...InstallationReceiptCommonFields,
    result: Schema.Literal("rolled_back"),
    rollback_pointer: OpaqueIdentifier,
    failure_code: Schema.Null,
  }),
]);
export type HostedSkillSetInstallationReceiptRequest =
  typeof HostedSkillSetInstallationReceiptRequest.Type;

export const HostedSkillSetInstallationReceiptResponse = Schema.Struct({
  receipt_id: OpaqueIdentifier,
  assignment_id: OpaqueIdentifier,
  release_id: OpaqueIdentifier,
  lifecycle_sequence: PositiveInteger,
  status: Schema.Literals(["current", "failed", "rolled_back"]),
  recorded_at: PositiveInteger,
  idempotent: Schema.Boolean,
});
export type HostedSkillSetInstallationReceiptResponse =
  typeof HostedSkillSetInstallationReceiptResponse.Type;

export const HostedSkillSetAssignmentErrorReceipt = Schema.Struct({
  error: Schema.Literals([
    "unauthorized",
    "invalid_assignment",
    "assignment_conflict",
    "assignment_failed",
  ]),
});
export type HostedSkillSetAssignmentErrorReceipt = typeof HostedSkillSetAssignmentErrorReceipt.Type;
