/* eslint-disable max-lines -- the distribution boundary stays in one auditable contract module */
import { Effect, Schema, SchemaAST } from "effect";
import parseSpdxExpression from "spdx-expression-parse";

/** A canonical, lowercase, unprefixed SHA-256 digest. */
export const Sha256Schema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/, {
    identifier: "Sha256",
    description: "a 64-character lowercase hexadecimal SHA-256 digest",
  }),
).pipe(Schema.brand("Sha256"));
export type Sha256 = Schema.Schema.Type<typeof Sha256Schema>;

/** A canonical Git object id for SHA-1 or SHA-256 repositories. */
export const GitObjectHashSchema = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
    identifier: "GitObjectHash",
    description: "a lowercase hexadecimal Git SHA-1 or SHA-256 object id",
  }),
).pipe(Schema.brand("GitObjectHash"));
export type GitObjectHash = Schema.Schema.Type<typeof GitObjectHashSchema>;

// oxlint-disable-next-line no-control-regex -- portable package paths reject controls.
const WINDOWS_FORBIDDEN_PACKAGE_PATH_CHARACTER = /[<>:"|?*\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_PACKAGE_PATH_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
const NON_PORTABLE_ASCII_PACKAGE_PATH_CHARACTER = /[^\x20-\x7e]/;

/** Exact canonical PortablePackagePath predicate shared by API and Cloud boundaries. */
export function isSafeRelativePackagePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    NON_PORTABLE_ASCII_PACKAGE_PATH_CHARACTER.test(path)
  ) {
    return false;
  }
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !WINDOWS_FORBIDDEN_PACKAGE_PATH_CHARACTER.test(segment) &&
        !WINDOWS_RESERVED_PACKAGE_PATH_SEGMENT.test(segment) &&
        !/[ .]$/.test(segment),
    );
}

/** True when paths collide on portable case-insensitive filesystems or as file/ancestor pairs. */
export function hasSafeRelativePackagePathCollision(paths: ReadonlyArray<string>): boolean {
  const identities = new Set<string>();
  for (const path of paths) {
    const identity = path.toLowerCase();
    if (identities.has(identity)) return true;
    identities.add(identity);
  }
  for (const identity of identities) {
    let separator = identity.indexOf("/");
    while (separator !== -1) {
      if (identities.has(identity.slice(0, separator))) return true;
      separator = identity.indexOf("/", separator + 1);
    }
  }
  return false;
}

/** Portable package paths exactly match the canonical PortablePackagePath schema. */
export const SafeRelativePathSchema = Schema.String.check(
  Schema.makeFilter(
    isSafeRelativePackagePath,
    { message: "Expected a canonical portable package path" },
    true,
  ),
).pipe(Schema.brand("SafeRelativePath"));
export type SafeRelativePath = Schema.Schema.Type<typeof SafeRelativePathSchema>;

/** A canonical UTC instant with millisecond precision. */
export const UtcTimestampSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    const epochMillis = Date.parse(value);
    return Number.isFinite(epochMillis) && new Date(epochMillis).toISOString() === value
      ? undefined
      : "Expected a canonical ISO-8601 UTC timestamp with millisecond precision";
  }),
).pipe(Schema.brand("UtcTimestamp"));
export type UtcTimestamp = Schema.Schema.Type<typeof UtcTimestampSchema>;

export const SkillRevisionIdSchema = Schema.NonEmptyString.pipe(Schema.brand("SkillRevisionId"));
export type SkillRevisionId = Schema.Schema.Type<typeof SkillRevisionIdSchema>;

export const SkillSetIdSchema = Schema.NonEmptyString.pipe(Schema.brand("SkillSetId"));
export type SkillSetId = Schema.Schema.Type<typeof SkillSetIdSchema>;

export const DistributionIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DistributionId"),
);
export type DistributionId = Schema.Schema.Type<typeof DistributionIdSchema>;

export const RightsClaimIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RightsClaimId"),
);
export type RightsClaimId = Schema.Schema.Type<typeof RightsClaimIdSchema>;

export const DistributionAuthorizationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DistributionAuthorizationId"),
);
export type DistributionAuthorizationId = Schema.Schema.Type<
  typeof DistributionAuthorizationIdSchema
>;

export const DistributionAuthorizationRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DistributionAuthorizationRequestId"),
);
export type DistributionAuthorizationRequestId = Schema.Schema.Type<
  typeof DistributionAuthorizationRequestIdSchema
>;

export const OrganizationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("OrganizationId"),
);
export type OrganizationId = Schema.Schema.Type<typeof OrganizationIdSchema>;

export const DistributionActorIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DistributionActorId"),
);
export type DistributionActorId = Schema.Schema.Type<typeof DistributionActorIdSchema>;

export class SkillRevisionDistributionSubject extends Schema.TaggedClass<SkillRevisionDistributionSubject>()(
  "skill_revision",
  {
    skillRevisionId: SkillRevisionIdSchema,
    sourceRevisionHash: Sha256Schema,
  },
) {}

export class SkillSetDistributionSubject extends Schema.TaggedClass<SkillSetDistributionSubject>()(
  "skill_set",
  {
    skillSetId: SkillSetIdSchema,
    sourceRevisionHash: Sha256Schema,
  },
) {}

export const DistributionSubjectSchema = Schema.Union([
  SkillRevisionDistributionSubject,
  SkillSetDistributionSubject,
]);
export type DistributionSubject = Schema.Schema.Type<typeof DistributionSubjectSchema>;

function distributionSubjectKey(subject: DistributionSubject): string {
  return subject._tag === "skill_revision"
    ? `${subject._tag}:${subject.skillRevisionId}:${subject.sourceRevisionHash}`
    : `${subject._tag}:${subject.skillSetId}:${subject.sourceRevisionHash}`;
}

/** Every policy channel in the Distribution Profile channel matrix. */
export const DistributionChannelSchema = Schema.Literals([
  "local_authoring",
  "same_org_private_backup",
  "workspace_discovery_install",
  "recipient_scoped_private_share",
  "registry_org_bundle",
  "registry_unlisted",
  "registry_public",
  "portable_skill_set_export",
]);
export type DistributionChannel = Schema.Schema.Type<typeof DistributionChannelSchema>;

/** Channels that cross an organization or installation boundary and require authorization. */
export const AuthorizedDistributionChannelSchema = Schema.Literals([
  "workspace_discovery_install",
  "recipient_scoped_private_share",
  "registry_org_bundle",
  "registry_unlisted",
  "registry_public",
  "portable_skill_set_export",
]);
export type AuthorizedDistributionChannel = Schema.Schema.Type<
  typeof AuthorizedDistributionChannelSchema
>;

export const LicenseKindSchema = Schema.Literals(["spdx", "license_ref", "proprietary"]);
export type LicenseKind = Schema.Schema.Type<typeof LicenseKindSchema>;

/** Policy outcome for valid license evidence; validity and automated approval are independent. */
export const LicensePolicyDispositionSchema = Schema.Literals([
  "automated_approved",
  "manual_review_required",
  "manually_approved",
]);
export type LicensePolicyDisposition = Schema.Schema.Type<typeof LicensePolicyDispositionSchema>;

/** Standalone identifiers eligible for automated readiness; expressions are never inferred. */
export const AutomatedSpdxLicenseIdentifierSchema = Schema.Literals([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
]);
export type AutomatedSpdxLicenseIdentifier = Schema.Schema.Type<
  typeof AutomatedSpdxLicenseIdentifierSchema
>;

const AutomatedSpdxLicenseIdentifiers = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
]);

function hasUniqueValues<T>(values: ReadonlyArray<T>): boolean {
  return new Set(values).size === values.length;
}

function isAutomatedSpdxExpression(expression: string): boolean {
  return AutomatedSpdxLicenseIdentifiers.has(expression);
}

function hasCanonicalSpdxOperatorSyntax(expression: string): boolean {
  const operators = expression.match(/\b(?:and|or|with)\b/gi);
  return (
    operators === null ||
    operators.every((operator) => operator === "AND" || operator === "OR" || operator === "WITH")
  );
}

function isOfficialSpdxExpression(expression: string): boolean {
  if (!hasCanonicalSpdxOperatorSyntax(expression)) return false;
  try {
    parseSpdxExpression(expression);
    return !expression.includes("LicenseRef-") && !expression.includes("DocumentRef-");
  } catch {
    return false;
  }
}

function isOfficialLicenseRefExpression(expression: string): boolean {
  if (!/^LicenseRef-[A-Za-z0-9.-]+$/.test(expression)) return false;
  try {
    parseSpdxExpression(expression);
    return true;
  } catch {
    return false;
  }
}

const LicenseEvidenceFields = Schema.Struct({
  sourceRevisionHash: Sha256Schema,
  expression: Schema.NonEmptyString,
  kind: LicenseKindSchema,
  policyDisposition: LicensePolicyDispositionSchema,
  filePath: Schema.NullOr(SafeRelativePathSchema),
  fileSha256: Schema.NullOr(Sha256Schema),
  noticePaths: Schema.Array(SafeRelativePathSchema),
});

/** License evidence inspected from the immutable source revision. */
export class LicenseEvidence extends Schema.Class<LicenseEvidence>("LicenseEvidence")(
  LicenseEvidenceFields.check(
    Schema.makeFilter((evidence) => {
      if ((evidence.filePath === null) !== (evidence.fileSha256 === null)) {
        return "License file path and hash must either both be present or both be absent";
      }
      if (!hasUniqueValues(evidence.noticePaths)) {
        return "License notice paths must be unique";
      }
      if (evidence.kind === "license_ref") {
        if (!isOfficialLicenseRefExpression(evidence.expression)) {
          return "LicenseRef evidence requires a valid LicenseRef-* expression";
        }
        if (evidence.filePath === null) {
          return "LicenseRef evidence requires a bundled terms file and verified hash";
        }
        return evidence.policyDisposition === "automated_approved"
          ? "LicenseRef evidence cannot receive automated policy approval"
          : undefined;
      }
      if (evidence.kind === "proprietary") {
        if (evidence.expression !== "Proprietary") {
          return 'Proprietary evidence must use the canonical "Proprietary" designation';
        }
        if (evidence.filePath === null) {
          return "Proprietary evidence requires a bundled terms file and verified hash";
        }
        return evidence.policyDisposition === "automated_approved"
          ? "Proprietary evidence cannot receive automated policy approval"
          : undefined;
      }
      if (!isOfficialSpdxExpression(evidence.expression)) {
        return "SPDX evidence requires a valid expression using official identifiers and exceptions";
      }
      if (
        evidence.policyDisposition === "automated_approved" &&
        !isAutomatedSpdxExpression(evidence.expression)
      ) {
        return "Automated approval is limited to one standalone identifier in the automated policy allowlist";
      }
      return undefined;
    }),
  ),
) {}

export class OrganizationRightsHolder extends Schema.TaggedClass<OrganizationRightsHolder>()(
  "organization",
  { organizationId: OrganizationIdSchema },
) {}

export const RightsHolderUserIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RightsHolderUserId"),
);
export type RightsHolderUserId = Schema.Schema.Type<typeof RightsHolderUserIdSchema>;

export class UserRightsHolder extends Schema.TaggedClass<UserRightsHolder>()("user", {
  userId: RightsHolderUserIdSchema,
}) {}

export class ExternalRightsHolder extends Schema.TaggedClass<ExternalRightsHolder>()("external", {
  name: Schema.NonEmptyString,
}) {}

export const RightsHolderSchema = Schema.Union([
  OrganizationRightsHolder,
  UserRightsHolder,
  ExternalRightsHolder,
]);
export type RightsHolder = Schema.Schema.Type<typeof RightsHolderSchema>;

export class DistributionRightsScopes extends Schema.Class<DistributionRightsScopes>(
  "DistributionRightsScopes",
)({
  redistribute: Schema.Boolean,
  modify: Schema.Boolean,
  enableContributorSignals: Schema.Boolean,
}) {}

function sameLicenseEvidence(left: LicenseEvidence, right: LicenseEvidence): boolean {
  return (
    left.sourceRevisionHash === right.sourceRevisionHash &&
    left.expression === right.expression &&
    left.kind === right.kind &&
    left.policyDisposition === right.policyDisposition &&
    left.filePath === right.filePath &&
    left.fileSha256 === right.fileSha256 &&
    left.noticePaths.length === right.noticePaths.length &&
    left.noticePaths.every((path, index) => path === right.noticePaths[index])
  );
}

export class StandaloneLicenseRightsEvidence extends Schema.TaggedClass<StandaloneLicenseRightsEvidence>()(
  "standalone_license",
  { licenseEvidence: LicenseEvidence },
) {}

export class SkillSetCompilationRightsEvidence extends Schema.TaggedClass<SkillSetCompilationRightsEvidence>()(
  "skill_set_compilation",
  {
    sourceRevisionHash: Sha256Schema,
    sourceManifestSha256: Sha256Schema,
    sourceBomSha256: Sha256Schema,
    orderedComponentInspectionEvidenceSha256s: Schema.NonEmptyArray(Sha256Schema),
    inspectionEvidenceSha256: Sha256Schema,
  },
) {}

export const RightsClaimEvidenceSchema = Schema.Union([
  StandaloneLicenseRightsEvidence,
  SkillSetCompilationRightsEvidence,
]);
export type RightsClaimEvidence = Schema.Schema.Type<typeof RightsClaimEvidenceSchema>;

export function rightsClaimLicenseEvidence(claim: {
  readonly evidence: RightsClaimEvidence;
}): LicenseEvidence | null {
  return claim.evidence._tag === "standalone_license" ? claim.evidence.licenseEvidence : null;
}

const RightsClaimFields = Schema.Struct({
  id: RightsClaimIdSchema,
  organizationId: OrganizationIdSchema,
  subject: DistributionSubjectSchema,
  evidence: RightsClaimEvidenceSchema,
  rightsHolder: RightsHolderSchema,
  provenanceKind: Schema.Literals([
    "github_verified",
    "selftune_authored",
    "imported_upstream",
    "self_attested_upload",
  ]),
  sourceRepository: Schema.NullOr(
    Schema.String.check(
      Schema.isPattern(/^https:\/\/[^\s]+$/, {
        description: "an HTTPS source repository URL",
      }),
    ),
  ),
  sourceRef: Schema.NullOr(Schema.NonEmptyString),
  sourceTreeHash: Schema.NullOr(GitObjectHashSchema),
  scopes: DistributionRightsScopes,
  attestedChannels: Schema.Array(DistributionChannelSchema),
  attestedBy: DistributionActorIdSchema,
  attestedAt: UtcTimestampSchema,
  attestationTermsVersion: Schema.NonEmptyString,
  verificationState: Schema.Literals([
    "self_attested",
    "source_verified",
    "manually_verified",
    "rejected",
  ]),
  verifiedBy: Schema.NullOr(DistributionActorIdSchema),
  verifiedAt: Schema.NullOr(UtcTimestampSchema),
  reviewEvidence: Schema.NullOr(Schema.NonEmptyString),
  reviewPolicyVersion: Schema.NullOr(Schema.NonEmptyString),
  supersedesClaimId: Schema.NullOr(RightsClaimIdSchema),
  createdAt: UtcTimestampSchema,
});

/** Immutable, version-specific assertion of the rights needed for distribution. */
export class RightsClaim extends Schema.Class<RightsClaim>("RightsClaim")(
  RightsClaimFields.check(
    Schema.makeFilter((claim) => {
      if (claim.evidence._tag === "standalone_license") {
        if (claim.subject._tag !== "skill_revision") {
          return "Standalone license rights evidence requires a skill revision subject";
        }
        if (
          claim.subject.sourceRevisionHash !== claim.evidence.licenseEvidence.sourceRevisionHash
        ) {
          return "Rights claim and license evidence must bind the same source revision hash";
        }
      } else {
        if (claim.subject._tag !== "skill_set") {
          return "Skill Set compilation rights evidence requires a Skill Set subject";
        }
        if (claim.subject.sourceRevisionHash !== claim.evidence.sourceRevisionHash) {
          return "Rights claim and compilation evidence must bind the same source revision hash";
        }
      }
      if (!hasUniqueValues(claim.attestedChannels)) {
        return "Attested distribution channels must be unique";
      }
      if (Date.parse(claim.attestedAt) > Date.parse(claim.createdAt)) {
        return "Rights attestation cannot occur after claim creation";
      }
      const hasCompleteReview =
        claim.verifiedBy !== null &&
        claim.verifiedAt !== null &&
        claim.reviewEvidence !== null &&
        claim.reviewPolicyVersion !== null;
      const hasAnyReview =
        claim.verifiedBy !== null ||
        claim.verifiedAt !== null ||
        claim.reviewEvidence !== null ||
        claim.reviewPolicyVersion !== null;
      const requiresReview =
        claim.verificationState === "manually_verified" || claim.verificationState === "rejected";
      if (requiresReview && !hasCompleteReview) {
        return "Manual and rejected rights decisions require complete review provenance";
      }
      if (!requiresReview && hasAnyReview) {
        return "Self-attested and source-verified claims cannot carry manual review provenance";
      }
      if (claim.verifiedAt !== null && Date.parse(claim.verifiedAt) > Date.parse(claim.createdAt)) {
        return "Rights verification cannot occur after claim creation";
      }
      if (claim.provenanceKind === "github_verified") {
        return claim.sourceRepository !== null &&
          /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+(?:\.git)?$/.test(claim.sourceRepository) &&
          claim.sourceRef !== null &&
          claim.sourceTreeHash !== null
          ? undefined
          : "GitHub-verified provenance requires a GitHub HTTPS repository, ref, and tree hash";
      }
      if (claim.provenanceKind === "imported_upstream") {
        return claim.sourceRepository !== null &&
          claim.sourceRef !== null &&
          claim.sourceTreeHash !== null
          ? undefined
          : "Imported-upstream provenance requires a repository, ref, and tree hash";
      }
      return undefined;
    }),
  ),
) {}

/** No contributor-signal routing decision has been made. This is the default. */
export class TelemetryUnconfigured extends Schema.TaggedClass<TelemetryUnconfigured>()(
  "unconfigured",
  {},
) {}

/** Contributor signals were explicitly configured off for this distribution profile. */
export class TelemetryDisabled extends Schema.TaggedClass<TelemetryDisabled>()("disabled", {
  configuredBy: DistributionActorIdSchema,
  configuredAt: UtcTimestampSchema,
}) {}

/** Privacy-safe logical categories. Raw prompt, transcript, file, and code fields are absent. */
export const ContributorSignalFieldSchema = Schema.Literals(["trigger", "grade", "miss_category"]);
export type ContributorSignalField = Schema.Schema.Type<typeof ContributorSignalFieldSchema>;

/** Public contributor relay/capability format; independent from canonical push telemetry v2. */
export const ContributorSignalCapabilityVersionSchema = Schema.Literal(1);
export type ContributorSignalCapabilityVersion = Schema.Schema.Type<
  typeof ContributorSignalCapabilityVersionSchema
>;

/** Deterministic logical-category to relay-v1 wire-field mapping. */
export class ContributorSignalWireMapping extends Schema.Class<ContributorSignalWireMapping>(
  "ContributorSignalWireMapping",
)({
  trigger: Schema.Tuple([
    Schema.Literal("triggered"),
    Schema.Literal("invocation_type"),
    Schema.Literal("miss_detected"),
  ]),
  grade: Schema.Tuple([Schema.Literal("execution_grade")]),
  miss_category: Schema.Tuple([Schema.Literal("query_bucket")]),
}) {}

export const DefaultContributorSignalWireMapping = ContributorSignalWireMapping.make({
  trigger: ["triggered", "invocation_type", "miss_detected"],
  grade: ["execution_grade"],
  miss_category: ["query_bucket"],
});

export class ContributorSignalCapability extends Schema.Class<ContributorSignalCapability>(
  "ContributorSignalCapability",
)(
  Schema.Struct({
    version: ContributorSignalCapabilityVersionSchema,
    allowedSignals: Schema.NonEmptyArray(ContributorSignalFieldSchema),
    wireFields: ContributorSignalWireMapping,
  }).check(
    Schema.makeFilter((capability) =>
      hasUniqueValues(capability.allowedSignals)
        ? undefined
        : "Allowed contributor signal categories must be unique",
    ),
  ),
) {}

const TelemetryEnabledFields = Schema.Struct({
  recipientOrganizationId: OrganizationIdSchema,
  capability: ContributorSignalCapability,
  configuredBy: DistributionActorIdSchema,
  configuredAt: UtcTimestampSchema,
});

/** Creator telemetry is version-scoped and routes only to the named organization. */
export class TelemetryEnabled extends Schema.TaggedClass<TelemetryEnabled>()(
  "enabled",
  TelemetryEnabledFields,
) {}

export const TelemetryEntitlementSchema = Schema.Union([
  TelemetryUnconfigured,
  TelemetryDisabled,
  TelemetryEnabled,
]);
export type TelemetryEntitlement = Schema.Schema.Type<typeof TelemetryEntitlementSchema>;

export const DefaultTelemetryEntitlement = TelemetryUnconfigured.make();

const TelemetryEntitlementWithDefault = TelemetryEntitlementSchema.pipe(
  Schema.withDecodingDefaultTypeKey(Effect.succeed(DefaultTelemetryEntitlement)),
  Schema.withConstructorDefault(Effect.succeed(DefaultTelemetryEntitlement)),
);

export const DistributionBlockerCodeSchema = Schema.Literals([
  "DistributionSubjectNotFound",
  "DistributionContentChanged",
  "DistributionSourceObjectChanged",
  "DistributionPackageTooLarge",
  "DistributionAuthorizationExpired",
  "DistributionMaterializationConflict",
  "AgentSkillsValidationFailed",
  "MissingLicense",
  "InvalidLicenseExpression",
  "MissingLicenseFile",
  "LicenseFileHashMismatch",
  "RightsUnverified",
  "DistributionScopeNotAttested",
  "ManualLicenseReviewRequired",
  "TelemetryOwnerMismatch",
  "TelemetryNotAuthorized",
  "SkillSetComponentBlocked",
]);
export type DistributionBlockerCode = Schema.Schema.Type<typeof DistributionBlockerCodeSchema>;

export class DistributionBlocker extends Schema.Class<DistributionBlocker>("DistributionBlocker")({
  code: DistributionBlockerCodeSchema,
  message: Schema.NonEmptyString,
}) {}

export const DistributionRecipientUserIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DistributionRecipientUserId"),
);
export type DistributionRecipientUserId = Schema.Schema.Type<
  typeof DistributionRecipientUserIdSchema
>;

export class UserDistributionRecipient extends Schema.TaggedClass<UserDistributionRecipient>()(
  "user",
  { userId: DistributionRecipientUserIdSchema },
) {}

export class OrganizationDistributionRecipient extends Schema.TaggedClass<OrganizationDistributionRecipient>()(
  "organization",
  { organizationId: OrganizationIdSchema },
) {}

export class EmailHashDistributionRecipient extends Schema.TaggedClass<EmailHashDistributionRecipient>()(
  "email_hash",
  { emailSha256: Sha256Schema },
) {}

/** A private share bound to possession of one high-entropy, single-claim secret. */
export class BearerClaimDistributionRecipient extends Schema.TaggedClass<BearerClaimDistributionRecipient>()(
  "bearer_claim",
  { claimSecretSha256: Sha256Schema },
) {}

export const DistributionRecipientSchema = Schema.Union([
  UserDistributionRecipient,
  OrganizationDistributionRecipient,
  EmailHashDistributionRecipient,
  BearerClaimDistributionRecipient,
]);
export type DistributionRecipient = Schema.Schema.Type<typeof DistributionRecipientSchema>;

export class LocalAuthoringIntent extends Schema.TaggedClass<LocalAuthoringIntent>()(
  "local_authoring",
  {},
) {}

export class SameOrgPrivateBackupIntent extends Schema.TaggedClass<SameOrgPrivateBackupIntent>()(
  "same_org_private_backup",
  { organizationId: OrganizationIdSchema },
) {}

export class WorkspaceDiscoveryInstallIntent extends Schema.TaggedClass<WorkspaceDiscoveryInstallIntent>()(
  "workspace_discovery_install",
  { organizationId: OrganizationIdSchema },
) {}

export class RecipientScopedPrivateShareIntent extends Schema.TaggedClass<RecipientScopedPrivateShareIntent>()(
  "recipient_scoped_private_share",
  { recipient: DistributionRecipientSchema },
) {}

export class RegistryOrgBundleIntent extends Schema.TaggedClass<RegistryOrgBundleIntent>()(
  "registry_org_bundle",
  { organizationId: OrganizationIdSchema },
) {}

export class RegistryUnlistedIntent extends Schema.TaggedClass<RegistryUnlistedIntent>()(
  "registry_unlisted",
  {},
) {}

export class RegistryPublicIntent extends Schema.TaggedClass<RegistryPublicIntent>()(
  "registry_public",
  {},
) {}

export class PortableSkillSetExportIntent extends Schema.TaggedClass<PortableSkillSetExportIntent>()(
  "portable_skill_set_export",
  {},
) {}

export const DistributionIntentSchema = Schema.Union([
  LocalAuthoringIntent,
  SameOrgPrivateBackupIntent,
  WorkspaceDiscoveryInstallIntent,
  RecipientScopedPrivateShareIntent,
  RegistryOrgBundleIntent,
  RegistryUnlistedIntent,
  RegistryPublicIntent,
  PortableSkillSetExportIntent,
]);
export type DistributionIntent = Schema.Schema.Type<typeof DistributionIntentSchema>;

export const AuthorizedDistributionIntentSchema = Schema.Union([
  WorkspaceDiscoveryInstallIntent,
  RecipientScopedPrivateShareIntent,
  RegistryOrgBundleIntent,
  RegistryUnlistedIntent,
  RegistryPublicIntent,
  PortableSkillSetExportIntent,
]);
export type AuthorizedDistributionIntent = Schema.Schema.Type<
  typeof AuthorizedDistributionIntentSchema
>;

const DistributionDecisionFields = Schema.Struct({
  subject: DistributionSubjectSchema,
  channel: DistributionChannelSchema,
  status: Schema.Literals(["ready", "not_ready_for_distribution", "manual_review_required"]),
  licenseEvidence: Schema.NullOr(LicenseEvidence),
  rightsClaim: Schema.NullOr(RightsClaim),
  telemetryEntitlement: TelemetryEntitlementWithDefault,
  blockers: Schema.Array(DistributionBlocker),
  warnings: Schema.Array(Schema.NonEmptyString),
  policyVersion: Schema.NonEmptyString,
  assessedAt: UtcTimestampSchema,
});

/** Read-only policy assessment. It cannot authorize a mutation by itself. */
export class DistributionDecision extends Schema.Class<DistributionDecision>(
  "DistributionDecision",
)(
  DistributionDecisionFields.check(
    Schema.makeFilter((decision) => {
      const claimLicense =
        decision.rightsClaim === null ? null : rightsClaimLicenseEvidence(decision.rightsClaim);
      if (!hasUniqueValues(decision.blockers.map((blocker) => blocker.code))) {
        return "Distribution blocker codes must be unique";
      }
      if (
        decision.licenseEvidence !== null &&
        decision.licenseEvidence.sourceRevisionHash !== decision.subject.sourceRevisionHash
      ) {
        return "Decision subject and license evidence must bind the same source revision";
      }
      if (
        decision.rightsClaim !== null &&
        distributionSubjectKey(decision.rightsClaim.subject) !==
          distributionSubjectKey(decision.subject)
      ) {
        return "Decision subject and rights claim subject must match";
      }
      if (
        decision.licenseEvidence !== null &&
        claimLicense !== null &&
        !sameLicenseEvidence(decision.licenseEvidence, claimLicense)
      ) {
        return "Decision and rights claim license evidence must match";
      }
      if (
        decision.rightsClaim?.evidence._tag === "skill_set_compilation" &&
        decision.licenseEvidence !== null
      ) {
        return "Skill Set compilation decisions cannot fabricate root license evidence";
      }
      if (
        decision.rightsClaim !== null &&
        Date.parse(decision.rightsClaim.createdAt) > Date.parse(decision.assessedAt)
      ) {
        return "Rights claim creation must not occur after decision assessment";
      }
      if (
        decision.telemetryEntitlement._tag !== "unconfigured" &&
        Date.parse(decision.telemetryEntitlement.configuredAt) > Date.parse(decision.assessedAt)
      ) {
        return "Telemetry configuration must not occur after decision assessment";
      }
      if (decision.status !== "ready") {
        return decision.blockers.length > 0
          ? undefined
          : "A non-ready distribution decision must include at least one blocker";
      }
      if (decision.blockers.length > 0) {
        return "A ready distribution decision cannot contain blockers";
      }
      const requiresDistributionRights =
        decision.channel !== "local_authoring" && decision.channel !== "same_org_private_backup";
      if (!requiresDistributionRights) {
        return decision.telemetryEntitlement._tag === "enabled"
          ? "Local authoring and private backup cannot issue contributor telemetry"
          : undefined;
      }
      if (decision.rightsClaim === null) {
        return "A ready distribution decision requires a rights claim";
      }
      if (
        decision.rightsClaim.evidence._tag === "standalone_license" &&
        decision.licenseEvidence === null
      ) {
        return "A ready standalone decision requires license evidence";
      }
      if (decision.licenseEvidence?.policyDisposition === "manual_review_required") {
        return "License evidence requiring manual review cannot produce a ready decision";
      }
      if (
        decision.licenseEvidence?.policyDisposition === "manually_approved" &&
        decision.rightsClaim.verificationState !== "manually_verified"
      ) {
        return "Manually approved license evidence requires a manually verified rights claim";
      }
      if (decision.rightsClaim.verificationState === "rejected") {
        return "A rejected rights claim cannot produce a ready decision";
      }
      if (!decision.rightsClaim.scopes.redistribute) {
        return "A ready distribution decision requires redistribution rights";
      }
      if (!decision.rightsClaim.attestedChannels.includes(decision.channel)) {
        return "The rights claim must attest the requested distribution channel";
      }
      if (
        decision.telemetryEntitlement._tag === "enabled" &&
        !decision.rightsClaim.scopes.enableContributorSignals
      ) {
        return "Enabled contributor signals require an attested telemetry scope";
      }
      if (decision.telemetryEntitlement._tag === "enabled" && !decision.rightsClaim.scopes.modify) {
        return "Enabled contributor signals require modification rights for generated package artifacts";
      }
      return undefined;
    }),
  ),
) {}

export class DistributionTransform extends Schema.Class<DistributionTransform>(
  "DistributionTransform",
)({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  includesFeedbackArtifacts: Schema.Boolean,
}) {}

const DistributionAuthorizationFields = Schema.Struct({
  id: DistributionAuthorizationIdSchema,
  distributionId: DistributionIdSchema,
  authorizationRequestId: DistributionAuthorizationRequestIdSchema,
  organizationId: OrganizationIdSchema,
  subject: DistributionSubjectSchema,
  sourceRevisionHash: Sha256Schema,
  sourceObjectSha256: Sha256Schema,
  bindingSha256: Sha256Schema,
  channel: AuthorizedDistributionChannelSchema,
  intent: AuthorizedDistributionIntentSchema,
  rightsClaimId: RightsClaimIdSchema,
  decision: DistributionDecision,
  transform: DistributionTransform,
  packagedSha256: Sha256Schema,
  authorizedBy: DistributionActorIdSchema,
  authorizedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
});

/** Auditable authority to materialize one exact sealed package. */
export class DistributionAuthorization extends Schema.Class<DistributionAuthorization>(
  "DistributionAuthorization",
)(
  DistributionAuthorizationFields.check(
    Schema.makeFilter((authorization) => {
      if (authorization.decision.status !== "ready") {
        return "Only a ready distribution decision can be authorized";
      }
      if (
        distributionSubjectKey(authorization.subject) !==
        distributionSubjectKey(authorization.decision.subject)
      ) {
        return "Authorization and decision subjects must match";
      }
      if (authorization.sourceRevisionHash !== authorization.subject.sourceRevisionHash) {
        return "Authorization source revision hash must match its subject";
      }
      if (authorization.decision.rightsClaim?.organizationId !== authorization.organizationId) {
        return "Authorization organization must match the rights-claim organization";
      }
      if (authorization.channel !== authorization.decision.channel) {
        return "Authorization and decision channels must match";
      }
      if (authorization.intent._tag !== authorization.channel) {
        return "Distribution intent must match the authorized channel";
      }
      if (authorization.decision.rightsClaim?.id !== authorization.rightsClaimId) {
        return "Authorization and decision rights claim ids must match";
      }
      if (Date.parse(authorization.decision.assessedAt) > Date.parse(authorization.authorizedAt)) {
        return "Decision assessment must not occur after authorization";
      }
      const telemetryEnabled = authorization.decision.telemetryEntitlement._tag === "enabled";
      if (authorization.transform.includesFeedbackArtifacts !== telemetryEnabled) {
        return "Feedback artifacts must be included exactly when contributor telemetry is enabled";
      }
      if (
        authorization.transform.includesFeedbackArtifacts &&
        authorization.decision.rightsClaim?.scopes.modify !== true
      ) {
        return "A package-changing feedback transform requires modification rights";
      }
      return Date.parse(authorization.expiresAt) > Date.parse(authorization.authorizedAt)
        ? undefined
        : "Authorization expiry must be later than its authorization time";
    }),
  ),
) {}

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export class DistributionSubjectNotFound extends Schema.TaggedErrorClass<DistributionSubjectNotFound>()(
  "DistributionSubjectNotFound",
  {
    subject: DistributionSubjectSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 404 },
) {}

export class DistributionContentChanged extends Schema.TaggedErrorClass<DistributionContentChanged>()(
  "DistributionContentChanged",
  {
    subject: DistributionSubjectSchema,
    expectedSourceRevisionHash: Sha256Schema,
    actualSourceRevisionHash: Sha256Schema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class DistributionSourceObjectChanged extends Schema.TaggedErrorClass<DistributionSourceObjectChanged>()(
  "DistributionSourceObjectChanged",
  {
    subject: DistributionSubjectSchema,
    expectedSourceObjectSha256: Sha256Schema,
    actualSourceObjectSha256: Sha256Schema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class DistributionPackageTooLarge extends Schema.TaggedErrorClass<DistributionPackageTooLarge>()(
  "DistributionPackageTooLarge",
  {
    subject: DistributionSubjectSchema,
    dimension: Schema.Literals([
      "encoded_package_bytes",
      "file_count",
      "decoded_file_bytes",
      "decoded_package_bytes",
    ]),
    actual: NonNegativeIntSchema,
    limit: NonNegativeIntSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 413 },
) {}

export class DistributionAuthorizationExpired extends Schema.TaggedErrorClass<DistributionAuthorizationExpired>()(
  "DistributionAuthorizationExpired",
  {
    authorizationId: DistributionAuthorizationIdSchema,
    expiredAt: UtcTimestampSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 410 },
) {}

export class DistributionMaterializationConflict extends Schema.TaggedErrorClass<DistributionMaterializationConflict>()(
  "DistributionMaterializationConflict",
  {
    authorizationId: DistributionAuthorizationIdSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class AgentSkillsValidationFailed extends Schema.TaggedErrorClass<AgentSkillsValidationFailed>()(
  "AgentSkillsValidationFailed",
  {
    subject: DistributionSubjectSchema,
    issues: Schema.NonEmptyArray(Schema.NonEmptyString),
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 422 },
) {}

export class MissingLicense extends Schema.TaggedErrorClass<MissingLicense>()(
  "MissingLicense",
  {
    subject: DistributionSubjectSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 422 },
) {}

export class InvalidLicenseExpression extends Schema.TaggedErrorClass<InvalidLicenseExpression>()(
  "InvalidLicenseExpression",
  {
    subject: DistributionSubjectSchema,
    expression: Schema.String,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 422 },
) {}

export class MissingLicenseFile extends Schema.TaggedErrorClass<MissingLicenseFile>()(
  "MissingLicenseFile",
  {
    subject: DistributionSubjectSchema,
    filePath: SafeRelativePathSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 422 },
) {}

export class LicenseFileHashMismatch extends Schema.TaggedErrorClass<LicenseFileHashMismatch>()(
  "LicenseFileHashMismatch",
  {
    subject: DistributionSubjectSchema,
    filePath: SafeRelativePathSchema,
    expectedHash: Sha256Schema,
    actualHash: Sha256Schema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class RightsUnverified extends Schema.TaggedErrorClass<RightsUnverified>()(
  "RightsUnverified",
  {
    subject: DistributionSubjectSchema,
    rightsClaimId: Schema.NullOr(RightsClaimIdSchema),
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 403 },
) {}

export class DistributionScopeNotAttested extends Schema.TaggedErrorClass<DistributionScopeNotAttested>()(
  "DistributionScopeNotAttested",
  {
    rightsClaimId: RightsClaimIdSchema,
    channel: DistributionChannelSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 403 },
) {}

export class ManualLicenseReviewRequired extends Schema.TaggedErrorClass<ManualLicenseReviewRequired>()(
  "ManualLicenseReviewRequired",
  {
    subject: DistributionSubjectSchema,
    reason: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 422 },
) {}

export class TelemetryOwnerMismatch extends Schema.TaggedErrorClass<TelemetryOwnerMismatch>()(
  "TelemetryOwnerMismatch",
  {
    subject: DistributionSubjectSchema,
    claimedRecipientOrganizationId: OrganizationIdSchema,
    authorizedRecipientOrganizationId: OrganizationIdSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class TelemetryNotAuthorized extends Schema.TaggedErrorClass<TelemetryNotAuthorized>()(
  "TelemetryNotAuthorized",
  {
    subject: DistributionSubjectSchema,
    channel: DistributionChannelSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 403 },
) {}

export class SkillSetComponentBlocked extends Schema.TaggedErrorClass<SkillSetComponentBlocked>()(
  "SkillSetComponentBlocked",
  {
    skillSetId: SkillSetIdSchema,
    component: SkillRevisionDistributionSubject,
    blocker: DistributionBlocker,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 424 },
) {}

export const DistributionFailureSchema = Schema.Union([
  DistributionSubjectNotFound,
  DistributionContentChanged,
  DistributionSourceObjectChanged,
  DistributionPackageTooLarge,
  DistributionAuthorizationExpired,
  DistributionMaterializationConflict,
  AgentSkillsValidationFailed,
  MissingLicense,
  InvalidLicenseExpression,
  MissingLicenseFile,
  LicenseFileHashMismatch,
  RightsUnverified,
  DistributionScopeNotAttested,
  ManualLicenseReviewRequired,
  TelemetryOwnerMismatch,
  TelemetryNotAuthorized,
  SkillSetComponentBlocked,
]);
export type DistributionFailure = Schema.Schema.Type<typeof DistributionFailureSchema>;

/** Security-sensitive boundary decoding rejects fields that are not in the signed contract. */
export const DistributionSecurityBoundaryParseOptions: SchemaAST.ParseOptions = {
  onExcessProperty: "error",
  errors: "all",
};

export const decodeLicenseEvidence = (input: unknown) =>
  Schema.decodeUnknownEffect(LicenseEvidence)(input, DistributionSecurityBoundaryParseOptions);

export const decodeRightsClaim = (input: unknown) =>
  Schema.decodeUnknownEffect(RightsClaim)(input, DistributionSecurityBoundaryParseOptions);

export const decodeTelemetryEntitlement = (input: unknown) =>
  Schema.decodeUnknownEffect(TelemetryEntitlementSchema)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeDistributionDecision = (input: unknown) =>
  Schema.decodeUnknownEffect(DistributionDecision)(input, DistributionSecurityBoundaryParseOptions);

export const decodeDistributionAuthorization = (input: unknown) =>
  Schema.decodeUnknownEffect(DistributionAuthorization)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeDistributionFailure = (input: unknown) =>
  Schema.decodeUnknownEffect(DistributionFailureSchema)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );
