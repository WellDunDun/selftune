import { Schema } from "effect";

import {
  DistributionIdSchema,
  DistributionSecurityBoundaryParseOptions,
  hasSafeRelativePackagePathCollision,
  OrganizationIdSchema,
  SafeRelativePathSchema,
  Sha256Schema,
  UtcTimestampSchema,
} from "./distribution";

export const ShareInvitationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("ShareInvitationId"),
);
export type ShareInvitationId = Schema.Schema.Type<typeof ShareInvitationIdSchema>;

/** A 256-bit random secret encoded without padding. This value is never persisted. */
export const ShareInvitationClaimTokenSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/, {
    identifier: "ShareInvitationClaimToken",
    description: "a 32-byte base64url claim token without padding",
  }),
).pipe(Schema.brand("ShareInvitationClaimToken"));
export type ShareInvitationClaimToken = Schema.Schema.Type<typeof ShareInvitationClaimTokenSchema>;

/** Canonical recipient address accepted only at the write boundary. */
export const NormalizedRecipientEmailSchema = Schema.String.check(
  Schema.makeFilter((email) => {
    if (email !== email.trim() || email !== email.toLowerCase()) {
      return "Recipient email must be trimmed and lowercase";
    }
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? undefined : "Recipient email is invalid";
  }),
).pipe(Schema.brand("NormalizedRecipientEmail"));
export type NormalizedRecipientEmail = Schema.Schema.Type<typeof NormalizedRecipientEmailSchema>;

/** Write-only issue command. Responses intentionally omit the recipient address. */
export class ShareInvitationIssue extends Schema.Class<ShareInvitationIssue>(
  "ShareInvitationIssue",
)({
  distributionId: DistributionIdSchema,
  recipientEmail: NormalizedRecipientEmailSchema,
  expiresAt: UtcTimestampSchema,
}) {}

/** Write-only authenticated claim command. */
export class ShareInvitationClaim extends Schema.Class<ShareInvitationClaim>(
  "ShareInvitationClaim",
)({
  claimToken: ShareInvitationClaimTokenSchema,
  claimedOrganizationId: OrganizationIdSchema,
}) {}

export class ShareInvitationPreviewRequest extends Schema.Class<ShareInvitationPreviewRequest>(
  "ShareInvitationPreviewRequest",
)({
  claimToken: ShareInvitationClaimTokenSchema,
}) {}

/** Write-only acknowledgement of the exact disclosure rendered to the recipient. */
export class ShareInvitationAcceptance extends Schema.Class<ShareInvitationAcceptance>(
  "ShareInvitationAcceptance",
)({
  disclosureSha256: Sha256Schema,
}) {}

/** Combined acceptance/import command; actor and recipient organization are auth-derived. */
export class ShareInvitationAcceptImport extends Schema.Class<ShareInvitationAcceptImport>(
  "ShareInvitationAcceptImport",
)({
  disclosureSha256: Sha256Schema,
}) {}

export class ShareInvitationDisclosure extends Schema.Class<ShareInvitationDisclosure>(
  "ShareInvitationDisclosure",
)({
  publisher: Schema.Struct({ name: Schema.NonEmptyString }),
  rightsHolder: Schema.Struct({
    kind: Schema.Union([
      Schema.Literal("organization"),
      Schema.Literal("user"),
      Schema.Literal("external"),
    ]),
    name: Schema.NonEmptyString,
  }),
  artifact: Schema.Struct({
    subjectKind: Schema.Literal("skill_revision"),
    subjectId: Schema.NonEmptyString,
    sourceRevisionHash: Sha256Schema,
    packagedSha256: Sha256Schema,
  }),
  license: Schema.Struct({
    expression: Schema.NonEmptyString,
    kind: Schema.Union([
      Schema.Literal("spdx"),
      Schema.Literal("license_ref"),
      Schema.Literal("proprietary"),
    ]),
    licenseEvidenceSha256: Sha256Schema,
    bundledTerms: Schema.NullOr(
      Schema.Struct({ path: SafeRelativePathSchema, sha256: Sha256Schema }),
    ),
  }),
  provenance: Schema.Struct({
    kind: Schema.Union([
      Schema.Literal("github_verified"),
      Schema.Literal("selftune_authored"),
      Schema.Literal("imported_upstream"),
      Schema.Literal("self_attested_upload"),
    ]),
    sourceRepository: Schema.NullOr(Schema.NonEmptyString),
    sourceRef: Schema.NullOr(Schema.NonEmptyString),
    sourceTreeHash: Schema.NullOr(
      Schema.String.check(
        Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
          identifier: "GitObjectHash",
        }),
      ),
    ),
  }),
  contributorSignals: Schema.Struct({
    status: Schema.Union([
      Schema.Literal("unconfigured"),
      Schema.Literal("disabled"),
      Schema.Literal("enabled"),
    ]),
    enabled: Schema.Boolean,
    includedInPackage: Schema.Boolean,
    activeCapability: Schema.Boolean,
    capabilityVersion: Schema.NullOr(Schema.NonEmptyString),
    signalSchema: Schema.NullOr(Schema.NonEmptyString),
    allowedSignals: Schema.Array(
      Schema.Union([
        Schema.Literal("trigger"),
        Schema.Literal("grade"),
        Schema.Literal("miss_category"),
      ]),
    ),
  }),
  /**
   * Closed, server-derived disclosures for recipient actions. These hashes are
   * the values action requests must echo; clients never invent them.
   */
  recipientActions: Schema.Struct({
    accountlessEligibility: Schema.Union([
      Schema.Literal("public_allowed"),
      Schema.Literal("account_required"),
    ]),
    contributorSignals: Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("signals_unavailable"),
        signalDisclosureSha256: Sha256Schema,
        signalRecipientOrganizationId: Schema.Null,
        allowedFields: Schema.Tuple([]),
        capability: Schema.Literal("not_capable"),
        defaultState: Schema.Literal("off"),
      }),
      Schema.Struct({
        _tag: Schema.Literal("capable_default_off"),
        signalDisclosureSha256: Sha256Schema,
        signalRecipientOrganizationId: OrganizationIdSchema,
        allowedFields: Schema.Array(
          Schema.Union([
            Schema.Literal("trigger"),
            Schema.Literal("grade"),
            Schema.Literal("miss_category"),
          ]),
        ).check(Schema.isNonEmpty()),
        capability: Schema.Literal("capable"),
        defaultState: Schema.Literal("off"),
      }),
    ]),
    portableDownloadLifecycle: Schema.Struct({
      _tag: Schema.Literal("downloaded_status"),
      lifecycleDisclosureSha256: Sha256Schema,
      defaultConsent: Schema.Literal("not_granted"),
      senderVisibleDownloadedStatus: Schema.Literal("disabled"),
    }),
    useOnceLifecycle: Schema.Struct({
      _tag: Schema.Literal("used_once_status"),
      lifecycleDisclosureSha256: Sha256Schema,
      defaultConsent: Schema.Literal("not_granted"),
      senderVisibleUsedOnceStatus: Schema.Literal("disabled"),
    }),
  }),
  acceptance: Schema.Struct({
    required: Schema.Boolean,
    policyVersion: Schema.NonEmptyString,
    disclosureSha256: Sha256Schema,
  }),
}) {}

const ShareInvitationShareIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RecipientShareId"),
);
const ShareInvitationSealedObjectIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RecipientSealedObjectId"),
);

/** Exact server-derived identifiers that recipient action requests must echo. */
export class ShareInvitationActionBindings extends Schema.Class<ShareInvitationActionBindings>(
  "ShareInvitationActionBindings",
)({
  invitationId: ShareInvitationIdSchema,
  distributionId: DistributionIdSchema,
  shareId: ShareInvitationShareIdSchema,
  sealedObjectId: ShareInvitationSealedObjectIdSchema,
  packagedSha256: Sha256Schema,
}) {}

export class ShareInvitationPackageInspectionFile extends Schema.Class<ShareInvitationPackageInspectionFile>(
  "ShareInvitationPackageInspectionFile",
)({
  path: SafeRelativePathSchema,
  sha256: Sha256Schema,
  byteLength: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 25 * 1024 * 1024 }),
  ),
}) {}

const ShareInvitationPackageFileManifest = Schema.Array(ShareInvitationPackageInspectionFile)
  .check(Schema.isMinLength(1), Schema.isMaxLength(500))
  .check(
    Schema.makeFilter((files) => {
      const paths = files.map((file) => file.path);
      if (paths.some((path, index) => index > 0 && path <= paths[index - 1]!)) {
        return "Package inspection paths must use canonical ascending order";
      }
      if (!paths.some((path) => path === "SKILL.md"))
        return "Package inspection must contain SKILL.md";
      if (hasSafeRelativePackagePathCollision(paths)) {
        return "Package inspection paths must not collide";
      }
      return files.reduce((total, file) => total + file.byteLength, 0) <= 25 * 1024 * 1024
        ? undefined
        : "Package inspection exceeds the canonical byte limit";
    }),
  );

/** Byte-derived manifest plus the closed SQL-committed delivery decision. */
export class ShareInvitationPackageInspection extends Schema.Class<ShareInvitationPackageInspection>(
  "ShareInvitationPackageInspection",
)({
  fileManifest: ShareInvitationPackageFileManifest,
  fileManifestSha256: Sha256Schema,
  securityDecision: Schema.Struct({
    _tag: Schema.Literal("authorized_sealed"),
    policyVersion: Schema.Literal("recipient-sealed-package-inspection-v1"),
    transform: Schema.Struct({
      name: Schema.Literal("selftune-portable-package"),
      version: Schema.Literal("1"),
    }),
    packagedSha256: Sha256Schema,
  }),
}) {}

export const ShareInvitationSenderStatusSchema = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("delivered"),
  Schema.Literal("claimed"),
  Schema.Literal("imported"),
  Schema.Literal("expired"),
  Schema.Literal("revoked"),
]);
export type ShareInvitationSenderStatus = Schema.Schema.Type<
  typeof ShareInvitationSenderStatusSchema
>;

/** Privacy-safe sender projection; it never exposes recipient account state. */
export class ShareInvitationSenderView extends Schema.Class<ShareInvitationSenderView>(
  "ShareInvitationSenderView",
)({
  invitationId: ShareInvitationIdSchema,
  distributionId: DistributionIdSchema,
  status: ShareInvitationSenderStatusSchema,
  expiresAt: UtcTimestampSchema,
  licenseAcceptanceRequired: Schema.Boolean,
}) {}

/** Token-gated, non-consuming public-safe preview. */
export class ShareInvitationPreview extends Schema.Class<ShareInvitationPreview>(
  "ShareInvitationPreview",
)({
  invitationId: ShareInvitationIdSchema,
  distributionId: DistributionIdSchema,
  status: Schema.Literal("available"),
  expiresAt: UtcTimestampSchema,
  disclosure: ShareInvitationDisclosure,
  actionBindings: ShareInvitationActionBindings,
  packageInspection: ShareInvitationPackageInspection,
}) {}

/** Claim does not imply license acceptance, import, download, or installation. */
export class ShareInvitationClaimResult extends Schema.Class<ShareInvitationClaimResult>(
  "ShareInvitationClaimResult",
)({
  invitationId: ShareInvitationIdSchema,
  distributionId: DistributionIdSchema,
  status: Schema.Literal("claimed"),
  licenseAcceptanceRequired: Schema.Boolean,
  licenseAcceptanceSatisfied: Schema.Boolean,
  importStatus: Schema.Literal("not_imported"),
}) {}

export class ShareInvitationRecipientView extends Schema.Class<ShareInvitationRecipientView>(
  "ShareInvitationRecipientView",
)({
  invitationId: ShareInvitationIdSchema,
  distributionId: DistributionIdSchema,
  status: Schema.Literal("claimed"),
  expiresAt: UtcTimestampSchema,
  claimedAt: UtcTimestampSchema,
  disclosure: ShareInvitationDisclosure,
  actionBindings: ShareInvitationActionBindings,
  packageInspection: ShareInvitationPackageInspection,
  licenseAcceptance: Schema.Struct({
    required: Schema.Boolean,
    satisfied: Schema.Boolean,
    reference: Schema.NullOr(Schema.NonEmptyString),
    acceptedAt: Schema.NullOr(UtcTimestampSchema),
  }),
  importStatus: Schema.Union([Schema.Literal("not_imported"), Schema.Literal("imported")]),
}) {}

export class ShareInvitationAcceptanceResult extends Schema.Class<ShareInvitationAcceptanceResult>(
  "ShareInvitationAcceptanceResult",
)({
  invitationId: ShareInvitationIdSchema,
  distributionId: DistributionIdSchema,
  status: Schema.Literal("accepted"),
  acceptanceReference: Schema.NonEmptyString,
  acceptedAt: UtcTimestampSchema,
  disclosure: ShareInvitationDisclosure,
  importStatus: Schema.Literal("not_imported"),
}) {}

export class ShareInvitationImportResult extends Schema.Class<ShareInvitationImportResult>(
  "ShareInvitationImportResult",
)({
  invitationId: ShareInvitationIdSchema,
  distributionId: DistributionIdSchema,
  status: Schema.Literal("imported"),
  importStatus: Schema.Literal("imported"),
  artifactId: Schema.NonEmptyString,
  objectId: Schema.String.check(Schema.isUUID()),
  snapshotId: Schema.String.check(Schema.isUUID()),
  packagedSha256: Sha256Schema,
  acceptanceReference: Schema.NullOr(Schema.NonEmptyString),
  acceptedAt: Schema.NullOr(UtcTimestampSchema),
  importedAt: UtcTimestampSchema,
}) {}

/** Enumeration-safe failure for invalid, expired, revoked, used, or wrong-audience claims. */
export class ShareInvitationUnavailable extends Schema.TaggedErrorClass<ShareInvitationUnavailable>()(
  "ShareInvitationUnavailable",
  { message: Schema.NonEmptyString },
  { httpApiStatus: 404 },
) {}

export class ShareInvitationDistributionNotEligible extends Schema.TaggedErrorClass<ShareInvitationDistributionNotEligible>()(
  "ShareInvitationDistributionNotEligible",
  {
    distributionId: DistributionIdSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 422 },
) {}

export class ShareInvitationConflict extends Schema.TaggedErrorClass<ShareInvitationConflict>()(
  "ShareInvitationConflict",
  { message: Schema.NonEmptyString },
  { httpApiStatus: 409 },
) {}

export const ShareInvitationFailureSchema = Schema.Union([
  ShareInvitationUnavailable,
  ShareInvitationDistributionNotEligible,
  ShareInvitationConflict,
]);
export type ShareInvitationFailure = Schema.Schema.Type<typeof ShareInvitationFailureSchema>;

export const decodeShareInvitationIssue = (input: unknown) =>
  Schema.decodeUnknownEffect(ShareInvitationIssue)(input, DistributionSecurityBoundaryParseOptions);

export const decodeShareInvitationClaim = (input: unknown) =>
  Schema.decodeUnknownEffect(ShareInvitationClaim)(input, DistributionSecurityBoundaryParseOptions);

export const decodeShareInvitationAcceptance = (input: unknown) =>
  Schema.decodeUnknownEffect(ShareInvitationAcceptance)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeShareInvitationAcceptImport = (input: unknown) =>
  Schema.decodeUnknownEffect(ShareInvitationAcceptImport)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeShareInvitationFailure = (input: unknown) =>
  Schema.decodeUnknownEffect(ShareInvitationFailureSchema)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );
