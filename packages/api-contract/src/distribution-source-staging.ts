import { Schema } from "effect";

import {
  DistributionActorIdSchema,
  DistributionAuthorizationIdSchema,
  DistributionSecurityBoundaryParseOptions,
  DistributionSubjectSchema,
  GitObjectHashSchema,
  hasSafeRelativePackagePathCollision,
  LicenseKindSchema,
  LicensePolicyDispositionSchema,
  OrganizationIdSchema,
  RightsClaimIdSchema,
  SafeRelativePathSchema,
  Sha256Schema,
  SkillRevisionDistributionSubject,
  SkillSetDistributionSubject,
  SkillSetIdSchema,
  UtcTimestampSchema,
} from "./distribution";

export const DistributionSourceRevisionIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DistributionSourceRevisionId"),
);
export type DistributionSourceRevisionId = Schema.Schema.Type<
  typeof DistributionSourceRevisionIdSchema
>;

export const DistributionSourceObjectIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DistributionSourceObjectId"),
);
export type DistributionSourceObjectId = Schema.Schema.Type<
  typeof DistributionSourceObjectIdSchema
>;

export const DistributionSourceRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DistributionSourceRequestId"),
);
export type DistributionSourceRequestId = Schema.Schema.Type<
  typeof DistributionSourceRequestIdSchema
>;

export const DistributionSourceIdempotencyKeySchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DistributionSourceIdempotencyKey"),
);
export type DistributionSourceIdempotencyKey = Schema.Schema.Type<
  typeof DistributionSourceIdempotencyKeySchema
>;

export const MaximumDistributionSourceObjectBytes = 25 * 1024 * 1024;
export const MaximumDistributionSourceAggregateBytes = 25 * 1024 * 1024;
export const MaximumDistributionSourceSkillSetComponents = 500;
export const CanonicalDistributionSourceObjectFormatSchema = Schema.Literals([
  "selftune-package-v2",
  "selftune-skill-set-source-v1",
]);
export type CanonicalDistributionSourceObjectFormat = Schema.Schema.Type<
  typeof CanonicalDistributionSourceObjectFormatSchema
>;

const PositiveByteLengthSchema = Schema.Int.check(
  Schema.isBetween({
    minimum: 1,
    maximum: MaximumDistributionSourceObjectBytes,
  }),
);
const NonNegativeOrdinalSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Upload receipt binding logical revision identity to one exact canonical package object. */
export class CanonicalDistributionSourceObject extends Schema.Class<CanonicalDistributionSourceObject>(
  "CanonicalDistributionSourceObject",
)({
  objectId: DistributionSourceObjectIdSchema,
  format: CanonicalDistributionSourceObjectFormatSchema,
  sourceRevisionHash: Sha256Schema,
  sourceObjectSha256: Sha256Schema,
  byteLength: PositiveByteLengthSchema,
}) {}

export class StandaloneDistributionSourceBom extends Schema.TaggedClass<StandaloneDistributionSourceBom>()(
  "standalone",
  {},
) {}

export class DistributionSourceBomComponent extends Schema.Class<DistributionSourceBomComponent>(
  "DistributionSourceBomComponent",
)({
  ordinal: NonNegativeOrdinalSchema,
  subject: SkillRevisionDistributionSubject,
  object: CanonicalDistributionSourceObject,
}) {}

export class SkillSetDistributionSourceBom extends Schema.TaggedClass<SkillSetDistributionSourceBom>()(
  "skill_set",
  {
    skillSetId: SkillSetIdSchema,
    components: Schema.NonEmptyArray(DistributionSourceBomComponent),
  },
) {}

export const DistributionSourceBomSchema = Schema.Union([
  StandaloneDistributionSourceBom,
  SkillSetDistributionSourceBom,
]).check(
  Schema.makeFilter((bom) => {
    if (bom._tag === "standalone") return undefined;
    if (bom.components.length > MaximumDistributionSourceSkillSetComponents) {
      return `Skill Set source BOMs are limited to ${MaximumDistributionSourceSkillSetComponents} components`;
    }
    const componentIds = new Set<string>();
    const objectIds = new Set<string>();
    const objectSha256s = new Set<string>();
    for (const [expectedOrdinal, component] of bom.components.entries()) {
      if (component.ordinal !== expectedOrdinal) {
        return "Skill Set source BOM ordinals must be contiguous and zero-based";
      }
      if (component.subject.sourceRevisionHash !== component.object.sourceRevisionHash) {
        return "Every Skill Set component subject must bind its exact source revision hash";
      }
      if (component.object.format !== "selftune-package-v2") {
        return "Every Skill Set component object must use canonical package version 2";
      }
      if (componentIds.has(component.subject.skillRevisionId)) {
        return "Skill Set source BOM skill revision ids must be unique";
      }
      if (objectIds.has(component.object.objectId)) {
        return "Skill Set source BOM component object ids must be unique";
      }
      if (objectSha256s.has(component.object.sourceObjectSha256)) {
        return "Skill Set source BOM component package hashes must be unique";
      }
      componentIds.add(component.subject.skillRevisionId);
      objectIds.add(component.object.objectId);
      objectSha256s.add(component.object.sourceObjectSha256);
    }
    return undefined;
  }),
);
export type DistributionSourceBom = Schema.Schema.Type<typeof DistributionSourceBomSchema>;

export class CanonicalDistributionSourcePackage extends Schema.Class<CanonicalDistributionSourcePackage>(
  "CanonicalDistributionSourcePackage",
)(
  Schema.Struct({
    subject: DistributionSubjectSchema,
    object: CanonicalDistributionSourceObject,
    bom: DistributionSourceBomSchema,
  }).check(
    Schema.makeFilter((source) => {
      if (source.subject.sourceRevisionHash !== source.object.sourceRevisionHash) {
        return "The root distribution subject must bind the exact source revision hash";
      }
      if (source.bom._tag === "standalone") {
        if (source.subject._tag !== "skill_revision") {
          return "A standalone source requires a skill-revision subject";
        }
        return source.object.format === "selftune-package-v2"
          ? undefined
          : "A standalone source root must use canonical package version 2";
      }
      if (
        source.subject._tag !== "skill_set" ||
        source.subject.skillSetId !== source.bom.skillSetId
      ) {
        return "A Skill Set source requires the matching skill-set subject";
      }
      if (source.object.format !== "selftune-skill-set-source-v1") {
        return "A Skill Set source root must use the canonical Skill Set source manifest format";
      }
      const aggregateBytes =
        source.object.byteLength +
        source.bom.components.reduce((total, component) => total + component.object.byteLength, 0);
      if (aggregateBytes > MaximumDistributionSourceAggregateBytes) {
        return `A staged source package is limited to ${MaximumDistributionSourceAggregateBytes} aggregate bytes`;
      }
      return source.bom.components.some(
        (component) => component.object.objectId === source.object.objectId,
      )
        ? "Skill Set root and component objects must be distinct"
        : undefined;
    }),
  ),
) {}

export class DistributionSourceOperationContext extends Schema.Class<DistributionSourceOperationContext>(
  "DistributionSourceOperationContext",
)({
  organizationId: OrganizationIdSchema,
  actorId: DistributionActorIdSchema,
  requestId: DistributionSourceRequestIdSchema,
  idempotencyKey: DistributionSourceIdempotencyKeySchema,
}) {}

export class StageDistributionSourceRevision extends Schema.Class<StageDistributionSourceRevision>(
  "StageDistributionSourceRevision",
)({
  context: DistributionSourceOperationContext,
  source: CanonicalDistributionSourcePackage,
}) {}

export class InspectDistributionSourceRevision extends Schema.Class<InspectDistributionSourceRevision>(
  "InspectDistributionSourceRevision",
)({
  context: DistributionSourceOperationContext,
  sourceRevisionId: DistributionSourceRevisionIdSchema,
}) {}

export class StandaloneDistributionSourceAttestation extends Schema.TaggedClass<StandaloneDistributionSourceAttestation>()(
  "standalone",
  { rightsClaimId: RightsClaimIdSchema },
) {}

export class DistributionSourceComponentAttestation extends Schema.Class<DistributionSourceComponentAttestation>(
  "DistributionSourceComponentAttestation",
)({
  ordinal: NonNegativeOrdinalSchema,
  rightsClaimId: RightsClaimIdSchema,
}) {}

export class SkillSetDistributionSourceAttestation extends Schema.TaggedClass<SkillSetDistributionSourceAttestation>()(
  "skill_set",
  {
    rightsClaimId: RightsClaimIdSchema,
    components: Schema.NonEmptyArray(DistributionSourceComponentAttestation),
  },
) {}

export const DistributionSourceAttestationBindingSchema = Schema.Union([
  StandaloneDistributionSourceAttestation,
  SkillSetDistributionSourceAttestation,
]).check(
  Schema.makeFilter((binding) => {
    if (binding._tag === "standalone") return undefined;
    const claimIds = new Set<string>([binding.rightsClaimId]);
    for (const [expectedOrdinal, component] of binding.components.entries()) {
      if (component.ordinal !== expectedOrdinal) {
        return "Skill Set attestation ordinals must be contiguous and zero-based";
      }
      if (claimIds.has(component.rightsClaimId)) {
        return "Root and component rights claims must be independently identified";
      }
      claimIds.add(component.rightsClaimId);
    }
    return undefined;
  }),
);
export type DistributionSourceAttestationBinding = Schema.Schema.Type<
  typeof DistributionSourceAttestationBindingSchema
>;

export const DistributionSourceAuthorizationBindingIdSchema = Schema.String.check(
  Schema.isUUID(),
).pipe(Schema.brand("DistributionSourceAuthorizationBindingId"));
export type DistributionSourceAuthorizationBindingId = Schema.Schema.Type<
  typeof DistributionSourceAuthorizationBindingIdSchema
>;

export class DistributionSourceAuthorizationComponentBinding extends Schema.Class<DistributionSourceAuthorizationComponentBinding>(
  "DistributionSourceAuthorizationComponentBinding",
)({
  ordinal: NonNegativeOrdinalSchema,
  subject: SkillRevisionDistributionSubject,
  sourceObjectSha256: Sha256Schema,
  rightsClaimId: RightsClaimIdSchema,
}) {}

/** Server-issued join between an existing distribution authorization and one staged UUID. */
export class DistributionSourceAuthorizationBinding extends Schema.Class<DistributionSourceAuthorizationBinding>(
  "DistributionSourceAuthorizationBinding",
)(
  Schema.Struct({
    id: DistributionSourceAuthorizationBindingIdSchema,
    organizationId: OrganizationIdSchema,
    sourceStagingRevisionId: DistributionSourceRevisionIdSchema,
    distributionAuthorizationId: DistributionAuthorizationIdSchema,
    subject: DistributionSubjectSchema,
    sourceObjectSha256: Sha256Schema,
    attestation: DistributionSourceAttestationBindingSchema,
    components: Schema.Array(DistributionSourceAuthorizationComponentBinding),
    issuedAt: UtcTimestampSchema,
  }).check(
    Schema.makeFilter((binding) => {
      if (binding.subject._tag === "skill_revision") {
        return binding.attestation._tag === "standalone" && binding.components.length === 0
          ? undefined
          : "A standalone authorization join cannot carry Skill Set component bindings";
      }
      if (
        binding.attestation._tag !== "skill_set" ||
        binding.components.length === 0 ||
        binding.components.length !== binding.attestation.components.length
      ) {
        return "A Skill Set authorization join requires every attested component";
      }
      for (const [expectedOrdinal, component] of binding.components.entries()) {
        const attestation = binding.attestation.components[expectedOrdinal];
        if (
          component.ordinal !== expectedOrdinal ||
          attestation?.ordinal !== expectedOrdinal ||
          component.rightsClaimId !== attestation.rightsClaimId
        ) {
          return "Authorization component bindings must match attestation ordinals and claims";
        }
      }
      return undefined;
    }),
  ),
) {}

export class AttestDistributionSourceRevision extends Schema.Class<AttestDistributionSourceRevision>(
  "AttestDistributionSourceRevision",
)({
  context: DistributionSourceOperationContext,
  sourceRevisionId: DistributionSourceRevisionIdSchema,
  binding: DistributionSourceAttestationBindingSchema,
}) {}

export class AuthorizeDistributionSourceRevision extends Schema.Class<AuthorizeDistributionSourceRevision>(
  "AuthorizeDistributionSourceRevision",
)({
  context: DistributionSourceOperationContext,
  sourceRevisionId: DistributionSourceRevisionIdSchema,
  authorizationBindingId: DistributionSourceAuthorizationBindingIdSchema,
}) {}

export class GetDistributionSourceRevision extends Schema.Class<GetDistributionSourceRevision>(
  "GetDistributionSourceRevision",
)({
  organizationId: OrganizationIdSchema,
  actorId: DistributionActorIdSchema,
  requestId: DistributionSourceRequestIdSchema,
  sourceRevisionId: DistributionSourceRevisionIdSchema,
}) {}

export class DistributionSourceInspectionPending extends Schema.TaggedClass<DistributionSourceInspectionPending>()(
  "pending",
  {},
) {}

export class DistributionSourceInspectionPathHash extends Schema.Class<DistributionSourceInspectionPathHash>(
  "DistributionSourceInspectionPathHash",
)({
  path: SafeRelativePathSchema,
  sha256: Sha256Schema,
}) {}

export class DistributionSourceInspectionFile extends Schema.Class<DistributionSourceInspectionFile>(
  "DistributionSourceInspectionFile",
)({
  path: SafeRelativePathSchema,
  sha256: Sha256Schema,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

const InspectionProvenanceFields = Schema.Struct({
  kind: Schema.Literals([
    "github_verified",
    "selftune_authored",
    "imported_upstream",
    "self_attested_upload",
  ]),
  sourceRepository: Schema.NullOr(Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/))),
  sourceRef: Schema.NullOr(Schema.NonEmptyString),
  sourceTreeHash: Schema.NullOr(GitObjectHashSchema),
  evidenceSha256: Sha256Schema,
});

/** Provenance resolved from stored source authority, never from the inspection caller. */
export class DistributionSourceInspectionProvenance extends Schema.Class<DistributionSourceInspectionProvenance>(
  "DistributionSourceInspectionProvenance",
)(
  InspectionProvenanceFields.check(
    Schema.makeFilter((provenance) => {
      if (provenance.kind === "github_verified") {
        return provenance.sourceRepository !== null &&
          /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+(?:\.git)?$/.test(provenance.sourceRepository) &&
          provenance.sourceRef !== null &&
          provenance.sourceTreeHash !== null
          ? undefined
          : "GitHub-verified provenance requires an exact GitHub repository, ref, and tree hash";
      }
      if (provenance.kind === "imported_upstream") {
        return provenance.sourceRepository !== null &&
          provenance.sourceRef !== null &&
          provenance.sourceTreeHash !== null
          ? undefined
          : "Imported-upstream provenance requires an exact repository, ref, and tree hash";
      }
      return provenance.sourceRepository === null &&
        provenance.sourceRef === null &&
        provenance.sourceTreeHash === null
        ? undefined
        : "Authored and upload provenance cannot carry upstream repository fields";
    }),
  ),
) {}

export class DistributionSourceInspectionLicense extends Schema.Class<DistributionSourceInspectionLicense>(
  "DistributionSourceInspectionLicense",
)(
  Schema.Struct({
    normalizedExpression: Schema.NonEmptyString,
    kind: LicenseKindSchema,
    policyDisposition: LicensePolicyDispositionSchema,
    normalizationProof: Schema.Union([
      Schema.TaggedStruct("spdx_registry_v1", {
        parser: Schema.Literal("spdx-expression-parse"),
        parserVersion: Schema.Literal("4.0.0"),
        normalizedExpressionSha256: Sha256Schema,
        proofSha256: Sha256Schema,
      }),
      Schema.TaggedStruct("manual_designation_v1", {
        normalizedExpressionSha256: Sha256Schema,
      }),
    ]),
    licenseFile: Schema.NullOr(DistributionSourceInspectionPathHash),
    notices: Schema.Array(DistributionSourceInspectionPathHash),
    licenseEvidenceSha256: Sha256Schema,
    noticeEvidenceSha256: Sha256Schema,
  }).check(
    Schema.makeFilter((license) => {
      if (license.kind === "spdx") {
        return license.normalizationProof._tag === "spdx_registry_v1"
          ? undefined
          : "SPDX inspection requires a server-registered parser proof";
      }
      return license.normalizationProof._tag === "manual_designation_v1"
        ? undefined
        : "Manual license designations cannot carry an SPDX parser proof";
    }),
  ),
) {}

export class DistributionSourcePackageInspectionEvidence extends Schema.Class<DistributionSourcePackageInspectionEvidence>(
  "DistributionSourcePackageInspectionEvidence",
)(
  Schema.Struct({
    _tag: Schema.Literal("package"),
    ordinal: Schema.NullOr(NonNegativeOrdinalSchema),
    subject: SkillRevisionDistributionSubject,
    sourceObjectSha256: Sha256Schema,
    fileManifest: Schema.NonEmptyArray(DistributionSourceInspectionFile),
    fileManifestSha256: Sha256Schema,
    license: DistributionSourceInspectionLicense,
    provenance: DistributionSourceInspectionProvenance,
    inspectionEvidenceSha256: Sha256Schema,
  }).check(
    Schema.makeFilter((artifact) =>
      hasSafeRelativePackagePathCollision(artifact.fileManifest.map((file) => file.path))
        ? "Inspection file manifests cannot contain portable path or ancestor collisions"
        : undefined,
    ),
  ),
) {}

export class DistributionSourceSkillSetManifestInspectionEvidence extends Schema.TaggedClass<DistributionSourceSkillSetManifestInspectionEvidence>()(
  "skill_set_manifest",
  {
    subject: SkillSetDistributionSubject,
    sourceManifestSha256: Sha256Schema,
    sourceBomSha256: Sha256Schema,
    orderedComponentInspectionEvidenceSha256s: Schema.NonEmptyArray(Sha256Schema),
    provenance: DistributionSourceInspectionProvenance,
    inspectionEvidenceSha256: Sha256Schema,
  },
) {}

export class DistributionSourceInspectionEvidence extends Schema.Class<DistributionSourceInspectionEvidence>(
  "DistributionSourceInspectionEvidence",
)(
  Schema.Struct({
    root: Schema.Union([
      DistributionSourcePackageInspectionEvidence,
      DistributionSourceSkillSetManifestInspectionEvidence,
    ]),
    components: Schema.Array(DistributionSourcePackageInspectionEvidence),
  }).check(
    Schema.makeFilter((evidence) => {
      if (evidence.root._tag === "package") {
        return evidence.root.ordinal === null && evidence.components.length === 0
          ? undefined
          : "Standalone inspection evidence cannot carry components";
      }
      if (
        evidence.components.length === 0 ||
        evidence.components.length !==
          evidence.root.orderedComponentInspectionEvidenceSha256s.length
      ) {
        return "Skill Set inspection evidence requires every ordered component";
      }
      for (const [ordinal, component] of evidence.components.entries()) {
        if (
          component.ordinal !== ordinal ||
          component.inspectionEvidenceSha256 !==
            evidence.root.orderedComponentInspectionEvidenceSha256s[ordinal]
        ) {
          return "Skill Set component evidence must be contiguous and hash-bound by the root";
        }
      }
      return undefined;
    }),
  ),
) {}

export class DistributionSourceInspectionReady extends Schema.TaggedClass<DistributionSourceInspectionReady>()(
  "ready",
  {
    inspectedAt: UtcTimestampSchema,
    policyVersion: Schema.NonEmptyString,
    evidence: DistributionSourceInspectionEvidence,
    warnings: Schema.Array(Schema.NonEmptyString),
  },
) {}

export class DistributionSourceInspectionBlocked extends Schema.TaggedClass<DistributionSourceInspectionBlocked>()(
  "blocked",
  {
    inspectedAt: UtcTimestampSchema,
    policyVersion: Schema.NonEmptyString,
    issues: Schema.NonEmptyArray(Schema.NonEmptyString),
  },
) {}

export const DistributionSourceInspectionStateSchema = Schema.Union([
  DistributionSourceInspectionPending,
  DistributionSourceInspectionReady,
  DistributionSourceInspectionBlocked,
]);
export type DistributionSourceInspectionState = Schema.Schema.Type<
  typeof DistributionSourceInspectionStateSchema
>;

export class DistributionSourceAttestationPending extends Schema.TaggedClass<DistributionSourceAttestationPending>()(
  "pending",
  {},
) {}

export class DistributionSourceAttested extends Schema.TaggedClass<DistributionSourceAttested>()(
  "attested",
  {
    binding: DistributionSourceAttestationBindingSchema,
    attestedAt: UtcTimestampSchema,
  },
) {}

export const DistributionSourceAttestationStateSchema = Schema.Union([
  DistributionSourceAttestationPending,
  DistributionSourceAttested,
]);
export type DistributionSourceAttestationState = Schema.Schema.Type<
  typeof DistributionSourceAttestationStateSchema
>;

export class DistributionSourceAuthorizationPending extends Schema.TaggedClass<DistributionSourceAuthorizationPending>()(
  "pending",
  {},
) {}

export class DistributionSourceAuthorized extends Schema.TaggedClass<DistributionSourceAuthorized>()(
  "authorized",
  {
    authorizationBindingId: DistributionSourceAuthorizationBindingIdSchema,
    authorizationId: DistributionAuthorizationIdSchema,
    authorizedAt: UtcTimestampSchema,
  },
) {}

export const DistributionSourceAuthorizationStateSchema = Schema.Union([
  DistributionSourceAuthorizationPending,
  DistributionSourceAuthorized,
]);
export type DistributionSourceAuthorizationState = Schema.Schema.Type<
  typeof DistributionSourceAuthorizationStateSchema
>;

export const DistributionSourceLifecyclePhaseSchema = Schema.Literals([
  "staged",
  "inspected",
  "attested",
  "authorized",
]);
export type DistributionSourceLifecyclePhase = Schema.Schema.Type<
  typeof DistributionSourceLifecyclePhaseSchema
>;

/** Immutable source identity plus monotonic lifecycle evidence. Content fields never change. */
export class DistributionSourceRevision extends Schema.Class<DistributionSourceRevision>(
  "DistributionSourceRevision",
)(
  Schema.Struct({
    sourceRevisionId: DistributionSourceRevisionIdSchema,
    organizationId: OrganizationIdSchema,
    source: CanonicalDistributionSourcePackage,
    phase: DistributionSourceLifecyclePhaseSchema,
    inspection: DistributionSourceInspectionStateSchema,
    attestation: DistributionSourceAttestationStateSchema,
    authorization: DistributionSourceAuthorizationStateSchema,
    stagedBy: DistributionActorIdSchema,
    stagedAt: UtcTimestampSchema,
  }).check(
    Schema.makeFilter((revision) => {
      const inspectionPending = revision.inspection._tag === "pending";
      const attestationPending = revision.attestation._tag === "pending";
      const authorizationPending = revision.authorization._tag === "pending";
      if (
        revision.phase === "staged" &&
        (!inspectionPending || !attestationPending || !authorizationPending)
      ) {
        return "A staged source revision cannot carry later lifecycle evidence";
      }
      if (
        revision.phase === "inspected" &&
        (inspectionPending || !attestationPending || !authorizationPending)
      ) {
        return "An inspected source revision requires only inspection evidence";
      }
      if (
        revision.phase === "attested" &&
        (revision.inspection._tag !== "ready" || attestationPending || !authorizationPending)
      ) {
        return "An attested source revision requires ready inspection and attestation evidence";
      }
      if (
        revision.phase === "authorized" &&
        (revision.inspection._tag !== "ready" || attestationPending || authorizationPending)
      ) {
        return "An authorized source revision requires ready inspection, attestation, and authorization evidence";
      }
      if (revision.attestation._tag === "attested") {
        const binding = revision.attestation.binding;
        if (revision.source.bom._tag !== binding._tag) {
          return "Source BOM and attestation binding kinds must match";
        }
        if (
          revision.source.bom._tag === "skill_set" &&
          binding._tag === "skill_set" &&
          (revision.source.bom.components.length !== binding.components.length ||
            revision.source.bom.components.some(
              (component, index) => component.ordinal !== binding.components[index]?.ordinal,
            ))
        ) {
          return "Every Skill Set BOM component requires one ordinally exact rights-claim binding";
        }
      }
      if (
        revision.inspection._tag !== "pending" &&
        Date.parse(revision.inspection.inspectedAt) < Date.parse(revision.stagedAt)
      ) {
        return "Inspection cannot precede staging";
      }
      if (
        revision.attestation._tag === "attested" &&
        (revision.inspection._tag !== "ready" ||
          Date.parse(revision.attestation.attestedAt) < Date.parse(revision.inspection.inspectedAt))
      ) {
        return "Attestation cannot precede a ready inspection";
      }
      if (
        revision.authorization._tag === "authorized" &&
        (revision.attestation._tag !== "attested" ||
          Date.parse(revision.authorization.authorizedAt) <
            Date.parse(revision.attestation.attestedAt))
      ) {
        return "Authorization cannot precede attestation";
      }
      return undefined;
    }),
  ),
) {}

export class DistributionSourceRootTarget extends Schema.TaggedClass<DistributionSourceRootTarget>()(
  "root",
  {},
) {}

export class DistributionSourceComponentTarget extends Schema.TaggedClass<DistributionSourceComponentTarget>()(
  "component",
  { ordinal: NonNegativeOrdinalSchema },
) {}

export const DistributionSourceObjectTargetSchema = Schema.Union([
  DistributionSourceRootTarget,
  DistributionSourceComponentTarget,
]);
export type DistributionSourceObjectTarget = Schema.Schema.Type<
  typeof DistributionSourceObjectTargetSchema
>;

export class ResolveDistributionSourceObject extends Schema.Class<ResolveDistributionSourceObject>(
  "ResolveDistributionSourceObject",
)({
  organizationId: OrganizationIdSchema,
  actorId: DistributionActorIdSchema,
  requestId: DistributionSourceRequestIdSchema,
  sourceRevisionId: DistributionSourceRevisionIdSchema,
  target: DistributionSourceObjectTargetSchema,
}) {}

/** Short-lived, organization-authorized object resolution. It is not a durable object locator. */
export class DistributionSourceObjectResolution extends Schema.Class<DistributionSourceObjectResolution>(
  "DistributionSourceObjectResolution",
)(
  Schema.Struct({
    sourceRevisionId: DistributionSourceRevisionIdSchema,
    target: DistributionSourceObjectTargetSchema,
    objectId: DistributionSourceObjectIdSchema,
    sourceObjectSha256: Sha256Schema,
    method: Schema.Literal("GET"),
    url: Schema.String.check(
      Schema.isPattern(/^https:\/\/[^\s]+$/, {
        description: "an HTTPS object resolution URL",
      }),
    ),
    issuedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
  }).check(
    Schema.makeFilter((resolution) => {
      const lifetime = Date.parse(resolution.expiresAt) - Date.parse(resolution.issuedAt);
      return lifetime > 0 && lifetime <= 15 * 60 * 1_000
        ? undefined
        : "Object resolution must expire within fifteen minutes of issuance";
    }),
  ),
) {}

export const DistributionSourceOperationSchema = Schema.Literals([
  "stage",
  "inspect",
  "attest",
  "authorize",
]);
export type DistributionSourceOperation = Schema.Schema.Type<
  typeof DistributionSourceOperationSchema
>;

export class DistributionSourceRevisionNotFound extends Schema.TaggedErrorClass<DistributionSourceRevisionNotFound>()(
  "DistributionSourceRevisionNotFound",
  {
    sourceRevisionId: DistributionSourceRevisionIdSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 404 },
) {}

export class DistributionSourceObjectNotFound extends Schema.TaggedErrorClass<DistributionSourceObjectNotFound>()(
  "DistributionSourceObjectNotFound",
  {
    objectId: DistributionSourceObjectIdSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 404 },
) {}

export class DistributionSourceObjectHashMismatch extends Schema.TaggedErrorClass<DistributionSourceObjectHashMismatch>()(
  "DistributionSourceObjectHashMismatch",
  {
    objectId: DistributionSourceObjectIdSchema,
    expectedSha256: Sha256Schema,
    actualSha256: Sha256Schema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class DistributionSourceObjectSizeMismatch extends Schema.TaggedErrorClass<DistributionSourceObjectSizeMismatch>()(
  "DistributionSourceObjectSizeMismatch",
  {
    objectId: DistributionSourceObjectIdSchema,
    expectedBytes: PositiveByteLengthSchema,
    actualBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class DistributionSourceObjectTooLarge extends Schema.TaggedErrorClass<DistributionSourceObjectTooLarge>()(
  "DistributionSourceObjectTooLarge",
  {
    objectId: DistributionSourceObjectIdSchema,
    actualBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    limitBytes: Schema.Int.check(Schema.isGreaterThan(0)),
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 413 },
) {}

export class DistributionSourcePackageInvalid extends Schema.TaggedErrorClass<DistributionSourcePackageInvalid>()(
  "DistributionSourcePackageInvalid",
  {
    objectId: DistributionSourceObjectIdSchema,
    issues: Schema.NonEmptyArray(Schema.NonEmptyString),
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 422 },
) {}

export class DistributionSourceIdempotencyConflict extends Schema.TaggedErrorClass<DistributionSourceIdempotencyConflict>()(
  "DistributionSourceIdempotencyConflict",
  {
    operation: DistributionSourceOperationSchema,
    requestId: DistributionSourceRequestIdSchema,
    idempotencyKey: DistributionSourceIdempotencyKeySchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class DistributionSourceLifecycleConflict extends Schema.TaggedErrorClass<DistributionSourceLifecycleConflict>()(
  "DistributionSourceLifecycleConflict",
  {
    sourceRevisionId: DistributionSourceRevisionIdSchema,
    operation: DistributionSourceOperationSchema,
    currentPhase: DistributionSourceLifecyclePhaseSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class DistributionSourceInspectionRejected extends Schema.TaggedErrorClass<DistributionSourceInspectionRejected>()(
  "DistributionSourceInspectionRejected",
  {
    sourceRevisionId: DistributionSourceRevisionIdSchema,
    issues: Schema.NonEmptyArray(Schema.NonEmptyString),
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 422 },
) {}

export class DistributionSourceRightsClaimNotBound extends Schema.TaggedErrorClass<DistributionSourceRightsClaimNotBound>()(
  "DistributionSourceRightsClaimNotBound",
  {
    sourceRevisionId: DistributionSourceRevisionIdSchema,
    rightsClaimId: RightsClaimIdSchema,
    componentOrdinal: Schema.NullOr(NonNegativeOrdinalSchema),
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class DistributionSourceActorNotAuthorized extends Schema.TaggedErrorClass<DistributionSourceActorNotAuthorized>()(
  "DistributionSourceActorNotAuthorized",
  {
    organizationId: OrganizationIdSchema,
    actorId: DistributionActorIdSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 403 },
) {}

export class DistributionSourceAuthorizationNotBound extends Schema.TaggedErrorClass<DistributionSourceAuthorizationNotBound>()(
  "DistributionSourceAuthorizationNotBound",
  {
    sourceRevisionId: DistributionSourceRevisionIdSchema,
    authorizationBindingId: DistributionSourceAuthorizationBindingIdSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

export class DistributionSourceResolutionWindowInvalid extends Schema.TaggedErrorClass<DistributionSourceResolutionWindowInvalid>()(
  "DistributionSourceResolutionWindowInvalid",
  {
    issuedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 500 },
) {}

export class DistributionSourceComponentNotFound extends Schema.TaggedErrorClass<DistributionSourceComponentNotFound>()(
  "DistributionSourceComponentNotFound",
  {
    sourceRevisionId: DistributionSourceRevisionIdSchema,
    ordinal: NonNegativeOrdinalSchema,
    message: Schema.NonEmptyString,
  },
  { httpApiStatus: 404 },
) {}

export const DistributionSourceFailureSchema = Schema.Union([
  DistributionSourceRevisionNotFound,
  DistributionSourceObjectNotFound,
  DistributionSourceObjectHashMismatch,
  DistributionSourceObjectSizeMismatch,
  DistributionSourceObjectTooLarge,
  DistributionSourcePackageInvalid,
  DistributionSourceIdempotencyConflict,
  DistributionSourceLifecycleConflict,
  DistributionSourceInspectionRejected,
  DistributionSourceRightsClaimNotBound,
  DistributionSourceAuthorizationNotBound,
  DistributionSourceResolutionWindowInvalid,
  DistributionSourceActorNotAuthorized,
  DistributionSourceComponentNotFound,
]);
export type DistributionSourceFailure = Schema.Schema.Type<typeof DistributionSourceFailureSchema>;

export const decodeStageDistributionSourceRevision = (input: unknown) =>
  Schema.decodeUnknownEffect(StageDistributionSourceRevision)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeDistributionSourceRevision = (input: unknown) =>
  Schema.decodeUnknownEffect(DistributionSourceRevision)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeInspectDistributionSourceRevision = (input: unknown) =>
  Schema.decodeUnknownEffect(InspectDistributionSourceRevision)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeAttestDistributionSourceRevision = (input: unknown) =>
  Schema.decodeUnknownEffect(AttestDistributionSourceRevision)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeAuthorizeDistributionSourceRevision = (input: unknown) =>
  Schema.decodeUnknownEffect(AuthorizeDistributionSourceRevision)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeResolveDistributionSourceObject = (input: unknown) =>
  Schema.decodeUnknownEffect(ResolveDistributionSourceObject)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeGetDistributionSourceRevision = (input: unknown) =>
  Schema.decodeUnknownEffect(GetDistributionSourceRevision)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeDistributionSourceObjectResolution = (input: unknown) =>
  Schema.decodeUnknownEffect(DistributionSourceObjectResolution)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );

export const decodeDistributionSourceFailure = (input: unknown) =>
  Schema.decodeUnknownEffect(DistributionSourceFailureSchema)(
    input,
    DistributionSecurityBoundaryParseOptions,
  );
