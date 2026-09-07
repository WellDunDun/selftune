import * as Schema from "effect/Schema";

import { SUPPORTED_AGENTS } from "./contracts";

export const SupportedAgentSchema = Schema.Literals(SUPPORTED_AGENTS);
const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value)), {
    expected: "a valid UTC instant",
  }),
);
const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));
export const ContributorSignalFieldSchema = Schema.Literals(["trigger", "grade", "miss_category"]);
const AllowedSignals = Schema.Array(ContributorSignalFieldSchema).check(Schema.isMinLength(1));
const SignalBase = {
  signalDisclosureSha256: Sha256,
  defaultState: Schema.Literal("off"),
};
export const ContributorSignalsSchema = Schema.Union([
  Schema.Struct({
    ...SignalBase,
    _tag: Schema.Literal("signals_unavailable"),
    signalRecipientOrganizationId: Schema.Null,
    allowedFields: Schema.Tuple([]),
    capability: Schema.Literal("not_capable"),
    contributorConsent: Schema.Literal("not_applicable"),
    enabled: Schema.Literal(false),
  }),
  Schema.Struct({
    ...SignalBase,
    _tag: Schema.Literal("capable_default_off"),
    signalRecipientOrganizationId: Uuid,
    allowedFields: AllowedSignals,
    capability: Schema.Literal("capable"),
    contributorConsent: Schema.Literal("not_granted"),
    enabled: Schema.Literal(false),
  }),
  Schema.Struct({
    ...SignalBase,
    _tag: Schema.Literal("capable_consented"),
    signalRecipientOrganizationId: Uuid,
    allowedFields: AllowedSignals,
    capability: Schema.Literal("capable"),
    contributorConsent: Schema.Literal("granted"),
    enabled: Schema.Literal(true),
  }),
]);
export const HelperContributorSignalsSchema = Schema.Union([
  Schema.Struct({
    ...SignalBase,
    _tag: Schema.Literal("unavailable"),
    allowedFields: Schema.Tuple([]),
    trustedTelemetry: Schema.Literal("not_authorized"),
  }),
  Schema.Struct({
    ...SignalBase,
    _tag: Schema.Literal("portable_unverified"),
    allowedFields: AllowedSignals,
    trustedTelemetry: Schema.Literal("not_authorized"),
  }),
]);
const Lifecycle = Schema.Struct({
  _tag: Schema.Literal("used_once_status"),
  lifecycleDisclosureSha256: Sha256,
  consent: Schema.Literals(["not_granted", "granted"]),
  senderVisibleUsedOnceStatus: Schema.Literals(["disabled", "enabled"]),
}).check(
  Schema.makeFilter(
    (value) =>
      value.senderVisibleUsedOnceStatus === (value.consent === "granted" ? "enabled" : "disabled"),
    { expected: "consent-bound lifecycle reporting" },
  ),
);
const Binding = {
  issueId: Uuid,
  invitationId: Uuid,
  shareId: Uuid,
  distributionId: Uuid,
  sealedObjectId: Uuid,
  packagedSha256: Sha256,
};
const Policy = {
  persistence: Schema.Literal("ephemeral_use_once"),
  persistentInstall: Schema.Literal("not_authorized"),
  trustedTelemetry: Schema.Literal("not_authorized"),
};
const License = Schema.Struct({
  expression: boundedText(1024),
  kind: Schema.Literals(["spdx", "license_ref", "proprietary"]),
  licenseEvidenceSha256: Sha256,
  bundledTerms: Schema.NullOr(Schema.Struct({ path: boundedText(1024), sha256: Sha256 })),
}).check(
  Schema.makeFilter((value) => value.kind === "spdx" || value.bundledTerms !== null, {
    expected: "bundled non-SPDX terms",
  }),
);
const ProvenanceText = Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048)));

export const UseOncePreviewSchema = Schema.Struct({
  ...Binding,
  ...Policy,
  status: Schema.Literal("preview"),
  supportedAgent: SupportedAgentSchema,
  issuedAt: Instant,
  expiresAt: Instant,
  publisher: Schema.Struct({ name: boundedText(512) }),
  rightsHolder: Schema.Struct({
    kind: Schema.Literals(["organization", "user", "external"]),
    name: boundedText(512),
  }),
  package: Schema.Struct({
    displayName: boundedText(512),
    version: boundedText(128),
    format: Schema.Literal("selftune-portable-package-v2"),
  }),
  license: License,
  provenance: Schema.Struct({
    kind: Schema.Literals([
      "github_verified",
      "selftune_authored",
      "imported_upstream",
      "self_attested_upload",
    ]),
    sourceRepository: ProvenanceText,
    sourceRef: ProvenanceText,
    sourceTreeHash: ProvenanceText,
  }),
  terms: Schema.Struct({
    disclosureSha256: Sha256,
    summary: boundedText(4096),
    issueAcceptance: Schema.Literal("accepted_at_issue"),
  }),
  contributorSignals: ContributorSignalsSchema,
  lifecycleReporting: Lifecycle,
  helperContributorSignals: HelperContributorSignalsSchema,
  contentRetrieval: Schema.Literal("repeatable_exact_object_before_consume"),
  previewMutation: Schema.Literal("none"),
  usedOnceReporting: Schema.Literal("not_emitted"),
  consumeRequired: Schema.Literal(true),
  authorityLimits: Schema.Struct({
    localPath: Schema.Literal("not_provided"),
    command: Schema.Literal("not_provided"),
    url: Schema.Literal("not_provided"),
    bytes: Schema.Literal("not_provided"),
    credential: Schema.Literal("not_provided"),
    installAuthority: Schema.Literal("not_authorized"),
  }),
});

export const UseOnceConsumptionSchema = Schema.Struct({
  ...Binding,
  ...Policy,
  requestId: Uuid,
  supportedAgent: SupportedAgentSchema,
  termsDisclosureSha256: Sha256,
  termsAcceptance: Schema.Literal("accepted"),
  executionConsent: Schema.Literal("granted"),
  status: Schema.Literal("consumed"),
  consumedAt: Instant,
  expiresAt: Instant,
  lifecycleReporting: Lifecycle,
  contributorSignals: ContributorSignalsSchema,
  recipientAccess: Schema.Literals(["authenticated", "accountless"]),
  accountlessPolicyResult: Schema.Literals(["authenticated_account", "public_allowed"]),
}).check(
  Schema.makeFilter(
    (value) =>
      value.accountlessPolicyResult ===
      (value.recipientAccess === "authenticated" ? "authenticated_account" : "public_allowed"),
    { expected: "matching recipient access policy" },
  ),
);

export const SealedObjectDeliverySchema = Schema.Struct({
  ...Binding,
  contentType: Schema.Literal("application/vnd.selftune.portable-package+json"),
  contentLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  contentSha256: Sha256,
  bytes: Schema.Uint8Array,
});
