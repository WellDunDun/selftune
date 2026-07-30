import { Schema } from "effect";

import {
  DistributionBlocker,
  DistributionChannelSchema,
  DistributionIdSchema,
  Sha256Schema,
  UtcTimestampSchema,
} from "./distribution";

export const DistributionReadinessResultSchema = Schema.Literals([
  "ready",
  "blocked",
  "manual_review_required",
  "revoked",
]);
export type DistributionReadinessResult = Schema.Schema.Type<
  typeof DistributionReadinessResultSchema
>;

export class DistributionReadinessItem extends Schema.Class<DistributionReadinessItem>(
  "DistributionReadinessItem",
)({
  distributionId: DistributionIdSchema,
  subjectKind: Schema.Literals(["skill_revision", "skill_set"]),
  subjectId: Schema.NonEmptyString,
  sourceRevisionHash: Sha256Schema,
  channel: DistributionChannelSchema,
  agentSkillsConformance: Schema.Struct({
    status: Schema.Literals(["conformant", "nonconformant", "unknown"]),
    detail: Schema.NonEmptyString,
  }),
  detectedLicense: Schema.Struct({
    status: Schema.Literals(["verified", "missing", "manual_review_required"]),
    expression: Schema.NullOr(Schema.NonEmptyString),
    evidenceSha256: Schema.NullOr(Sha256Schema),
  }),
  termsFile: Schema.Struct({
    status: Schema.Literals(["verified", "not_required", "missing"]),
    path: Schema.NullOr(Schema.NonEmptyString),
    sha256: Schema.NullOr(Sha256Schema),
  }),
  provenance: Schema.Struct({
    kind: Schema.NullOr(Schema.NonEmptyString),
    strength: Schema.Literals(["verified", "self_attested", "unknown"]),
    sourceRepository: Schema.NullOr(Schema.String),
  }),
  rightsHolder: Schema.Struct({
    kind: Schema.NullOr(Schema.Literals(["organization", "user", "external"])),
    label: Schema.NullOr(Schema.NonEmptyString),
    verificationState: Schema.NullOr(Schema.NonEmptyString),
  }),
  channelAttestation: Schema.Struct({
    attested: Schema.Boolean,
    termsVersion: Schema.NullOr(Schema.NonEmptyString),
  }),
  contributorSignals: Schema.Struct({
    state: Schema.Literals(["unconfigured", "disabled", "enabled"]),
    defaultState: Schema.Literal("off"),
    telemetryRecipientOrganizationId: Schema.NullOr(Schema.String),
    allowedFields: Schema.Array(Schema.Literals(["trigger", "grade", "miss_category"])),
  }),
  blockers: Schema.Array(DistributionBlocker),
  finalResult: DistributionReadinessResultSchema,
  technicalChecksLegalNotice: Schema.NonEmptyString,
  assessedAt: UtcTimestampSchema,
}) {}

export class DistributionReadinessInventory extends Schema.Class<DistributionReadinessInventory>(
  "DistributionReadinessInventory",
)({
  generatedAt: UtcTimestampSchema,
  items: Schema.Array(DistributionReadinessItem),
}) {}

export const CreatorSignalCoverageSchema = Schema.Struct({
  status: Schema.Literals(["none", "below_threshold", "available"]),
  eventCount: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  distinctCohorts: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});

export const CreatorSignalAggregateStateSchema = Schema.Literals([
  "zero_usage",
  "no_compatible_host",
  "no_consent",
  "below_threshold",
  "available",
]);

export class CreatorSignalDistribution extends Schema.Class<CreatorSignalDistribution>(
  "CreatorSignalDistribution",
)({
  distributionId: DistributionIdSchema,
  subjectId: Schema.NonEmptyString,
  logicalSkillVersion: Sha256Schema,
  channel: DistributionChannelSchema,
  distributionStatus: Schema.NonEmptyString,
  capability: Schema.Struct({
    status: Schema.Literals(["not_issued", "active", "revoked", "rotated", "expired"]),
    issuedAt: Schema.NullOr(UtcTimestampSchema),
    revokedAt: Schema.NullOr(UtcTimestampSchema),
  }),
  connectedCoverage: CreatorSignalCoverageSchema,
  portableCoverage: CreatorSignalCoverageSchema,
  aggregateState: CreatorSignalAggregateStateSchema,
  aggregates: Schema.NullOr(
    Schema.Struct({
      totalSignals: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      triggeredCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      missedCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      triggerRate: Schema.NullOr(Schema.Number),
      lastSeenAt: Schema.NullOr(UtcTimestampSchema),
    }),
  ),
}) {}

export class CreatorSignalsInventory extends Schema.Class<CreatorSignalsInventory>(
  "CreatorSignalsInventory",
)({
  source: Schema.Literal("contributor_aggregate"),
  generatedAt: UtcTimestampSchema,
  privacyThreshold: Schema.Struct({
    minimumTrustedCohorts: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    portableSignalsCountTowardThreshold: Schema.Literal(false),
  }),
  distributions: Schema.Array(CreatorSignalDistribution),
}) {}
