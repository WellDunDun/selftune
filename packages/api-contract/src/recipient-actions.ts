import * as Schema from "effect/Schema";

import {
  DistributionIdSchema,
  OrganizationIdSchema,
  Sha256Schema,
  UtcTimestampSchema,
} from "./distribution";
import { ShareInvitationIdSchema } from "./share-invitations";

function strictStruct<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  const allowed = new Set(Object.keys(fields));
  const encodedRecord = Schema.Record(Schema.String, Schema.Unknown).check(
    Schema.makeFilter(
      (value) =>
        Object.keys(value).every((key) => allowed.has(key))
          ? undefined
          : "Unexpected recipient-action property",
      { identifier: "StrictRecipientActionStruct" },
      true,
    ),
  );
  return encodedRecord.pipe(Schema.decodeTo(Schema.Struct(fields)));
}

export const RecipientActionRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RecipientActionRequestId"),
);
export type RecipientActionRequestId = Schema.Schema.Type<typeof RecipientActionRequestIdSchema>;

export const RecipientShareIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RecipientShareId"),
);
export type RecipientShareId = Schema.Schema.Type<typeof RecipientShareIdSchema>;

export const RecipientSealedObjectIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RecipientSealedObjectId"),
);
export type RecipientSealedObjectId = Schema.Schema.Type<typeof RecipientSealedObjectIdSchema>;

export const RecipientDownloadAuthorizationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RecipientDownloadAuthorizationId"),
);
export type RecipientDownloadAuthorizationId = Schema.Schema.Type<
  typeof RecipientDownloadAuthorizationIdSchema
>;

export const RecipientUseOnceIssueIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RecipientUseOnceIssueId"),
);
export type RecipientUseOnceIssueId = Schema.Schema.Type<typeof RecipientUseOnceIssueIdSchema>;

const opaqueToken = (identifier: string) =>
  Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9_-]{43}$/, {
      identifier,
      description: "a 32-byte base64url opaque token without padding",
    }),
  );

/** A use-once handoff is a distinct authority from an invitation claim token. */
export const RecipientUseOnceHandoffTokenSchema = opaqueToken("RecipientUseOnceHandoffToken").pipe(
  Schema.brand("RecipientUseOnceHandoffToken"),
);
export type RecipientUseOnceHandoffToken = Schema.Schema.Type<
  typeof RecipientUseOnceHandoffTokenSchema
>;

/** The only value permitted in a Desktop deep link. */
export const RecipientDesktopBootstrapTokenSchema = opaqueToken(
  "RecipientDesktopBootstrapToken",
).pipe(Schema.brand("RecipientDesktopBootstrapToken"));
export type RecipientDesktopBootstrapToken = Schema.Schema.Type<
  typeof RecipientDesktopBootstrapTokenSchema
>;

export const RecipientSupportedAgentSchema = Schema.Literals([
  "codex",
  "claude_code",
  "opencode",
  "openclaw",
  "pi",
]);
export type RecipientSupportedAgent = Schema.Schema.Type<typeof RecipientSupportedAgentSchema>;

export const RecipientAccessModeSchema = Schema.Literals(["authenticated", "accountless"]);
export type RecipientAccessMode = Schema.Schema.Type<typeof RecipientAccessModeSchema>;

export const RecipientLifecycleReportingConsentSchema = Schema.Literals(["not_granted", "granted"]);
export type RecipientLifecycleReportingConsent = Schema.Schema.Type<
  typeof RecipientLifecycleReportingConsentSchema
>;

export const RecipientActionKindSchema = Schema.Literals([
  "portable_download",
  "use_once_issue",
  "use_once_preview",
  "use_once_content",
  "use_once_consume",
  "desktop_bootstrap",
  "desktop_preview",
]);
export type RecipientActionKind = Schema.Schema.Type<typeof RecipientActionKindSchema>;

const BindingFields = {
  invitationId: ShareInvitationIdSchema,
  shareId: RecipientShareIdSchema,
  distributionId: DistributionIdSchema,
  sealedObjectId: RecipientSealedObjectIdSchema,
  packagedSha256: Sha256Schema,
} as const;

const TermsRequestFields = {
  termsDisclosureSha256: Sha256Schema,
  termsAcceptance: Schema.Literal("accepted"),
} as const;

export const RecipientContributorSignalFieldSchema = Schema.Literals([
  "trigger",
  "grade",
  "miss_category",
]);
export type RecipientContributorSignalField = Schema.Schema.Type<
  typeof RecipientContributorSignalFieldSchema
>;

const NonEmptyContributorSignalFieldsSchema = Schema.Array(
  RecipientContributorSignalFieldSchema,
).check(
  Schema.isNonEmpty({ message: "At least one disclosed contributor signal field is required" }),
);

/** Contributor telemetry remains disabled unless this exact disclosure is separately accepted. */
export const RecipientContributorSignalDisclosureSchema = Schema.Union([
  strictStruct({
    _tag: Schema.Literal("signals_unavailable"),
    signalDisclosureSha256: Sha256Schema,
    signalRecipientOrganizationId: Schema.Null,
    allowedFields: Schema.Tuple([]),
    capability: Schema.Literal("not_capable"),
    defaultState: Schema.Literal("off"),
    contributorConsent: Schema.Literal("not_applicable"),
    enabled: Schema.Literal(false),
  }),
  strictStruct({
    _tag: Schema.Literal("capable_default_off"),
    signalDisclosureSha256: Sha256Schema,
    signalRecipientOrganizationId: OrganizationIdSchema,
    allowedFields: NonEmptyContributorSignalFieldsSchema,
    capability: Schema.Literal("capable"),
    defaultState: Schema.Literal("off"),
    contributorConsent: Schema.Literal("not_granted"),
    enabled: Schema.Literal(false),
  }),
  strictStruct({
    _tag: Schema.Literal("capable_consented"),
    signalDisclosureSha256: Sha256Schema,
    signalRecipientOrganizationId: OrganizationIdSchema,
    allowedFields: NonEmptyContributorSignalFieldsSchema,
    capability: Schema.Literal("capable"),
    defaultState: Schema.Literal("off"),
    contributorConsent: Schema.Literal("granted"),
    enabled: Schema.Literal(true),
  }),
]);
export type RecipientContributorSignalDisclosure = Schema.Schema.Type<
  typeof RecipientContributorSignalDisclosureSchema
>;

/** Sender-visible download status is an independent consent from contributor telemetry. */
export const RecipientDownloadLifecycleReportingDisclosureSchema = Schema.Union([
  strictStruct({
    _tag: Schema.Literal("downloaded_status"),
    lifecycleDisclosureSha256: Sha256Schema,
    consent: Schema.Literal("not_granted"),
    senderVisibleDownloadedStatus: Schema.Literal("disabled"),
  }),
  strictStruct({
    _tag: Schema.Literal("downloaded_status"),
    lifecycleDisclosureSha256: Sha256Schema,
    consent: Schema.Literal("granted"),
    senderVisibleDownloadedStatus: Schema.Literal("enabled"),
  }),
]);
export type RecipientDownloadLifecycleReportingDisclosure = Schema.Schema.Type<
  typeof RecipientDownloadLifecycleReportingDisclosureSchema
>;

/** Sender-visible use-once status has its own disclosure and consent. */
export const RecipientUseOnceLifecycleReportingDisclosureSchema = Schema.Union([
  strictStruct({
    _tag: Schema.Literal("used_once_status"),
    lifecycleDisclosureSha256: Sha256Schema,
    consent: Schema.Literal("not_granted"),
    senderVisibleUsedOnceStatus: Schema.Literal("disabled"),
  }),
  strictStruct({
    _tag: Schema.Literal("used_once_status"),
    lifecycleDisclosureSha256: Sha256Schema,
    consent: Schema.Literal("granted"),
    senderVisibleUsedOnceStatus: Schema.Literal("enabled"),
  }),
]);
export type RecipientUseOnceLifecycleReportingDisclosure = Schema.Schema.Type<
  typeof RecipientUseOnceLifecycleReportingDisclosureSchema
>;

/** Sender-visible installed status is independent from contributor telemetry. */
export const RecipientInstallLifecycleReportingDisclosureSchema = Schema.Union([
  strictStruct({
    _tag: Schema.Literal("installed_status"),
    lifecycleDisclosureSha256: Sha256Schema,
    consent: Schema.Literal("not_granted"),
    senderVisibleInstalledStatus: Schema.Literal("disabled"),
  }),
  strictStruct({
    _tag: Schema.Literal("installed_status"),
    lifecycleDisclosureSha256: Sha256Schema,
    consent: Schema.Literal("granted"),
    senderVisibleInstalledStatus: Schema.Literal("enabled"),
  }),
]);
export type RecipientInstallLifecycleReportingDisclosure = Schema.Schema.Type<
  typeof RecipientInstallLifecycleReportingDisclosureSchema
>;

const ContributorSignalFields = {
  contributorSignals: RecipientContributorSignalDisclosureSchema,
} as const;

const DownloadConsentFields = {
  ...ContributorSignalFields,
  lifecycleReporting: RecipientDownloadLifecycleReportingDisclosureSchema,
} as const;

const UseOnceConsentFields = {
  ...ContributorSignalFields,
  lifecycleReporting: RecipientUseOnceLifecycleReportingDisclosureSchema,
} as const;

/** Authorizes a portable download only; it does not choose a filesystem target or install. */
export const RecipientPortableDownloadRequestSchema = strictStruct({
  requestId: RecipientActionRequestIdSchema,
  ...BindingFields,
  ...TermsRequestFields,
  ...DownloadConsentFields,
  recipientAccess: RecipientAccessModeSchema,
});
export type RecipientPortableDownloadRequest = Schema.Schema.Type<
  typeof RecipientPortableDownloadRequestSchema
>;

const PortableDownloadResponseFields = {
  requestId: RecipientActionRequestIdSchema,
  ...BindingFields,
  ...TermsRequestFields,
  ...DownloadConsentFields,
  status: Schema.Literal("authorized"),
  downloadAuthorizationId: RecipientDownloadAuthorizationIdSchema,
  packageFormat: Schema.Literal("selftune-portable-package-v2"),
  localInstall: Schema.Literal("not_requested"),
  authorizedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
} as const;
export const RecipientPortableDownloadResponseSchema = Schema.Union([
  strictStruct({
    ...PortableDownloadResponseFields,
    recipientAccess: Schema.Literal("authenticated"),
    accountlessPolicyResult: Schema.Literal("authenticated_account"),
  }),
  strictStruct({
    ...PortableDownloadResponseFields,
    recipientAccess: Schema.Literal("accountless"),
    accountlessPolicyResult: Schema.Literal("public_allowed"),
  }),
]);
export type RecipientPortableDownloadResponse = Schema.Schema.Type<
  typeof RecipientPortableDownloadResponseSchema
>;

export const RecipientUseOnceIssueRequestSchema = strictStruct({
  requestId: RecipientActionRequestIdSchema,
  ...BindingFields,
  ...TermsRequestFields,
  ...UseOnceConsentFields,
  supportedAgent: RecipientSupportedAgentSchema,
  executionConsent: Schema.Literal("granted"),
  recipientAccess: RecipientAccessModeSchema,
});
export type RecipientUseOnceIssueRequest = Schema.Schema.Type<
  typeof RecipientUseOnceIssueRequestSchema
>;

const UseOnceIssueResponseFields = {
  requestId: RecipientActionRequestIdSchema,
  ...BindingFields,
  ...TermsRequestFields,
  ...UseOnceConsentFields,
  supportedAgent: RecipientSupportedAgentSchema,
  executionConsent: Schema.Literal("granted"),
  status: Schema.Literal("issued"),
  issueId: RecipientUseOnceIssueIdSchema,
  handoffToken: RecipientUseOnceHandoffTokenSchema,
  issuedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
  persistence: Schema.Literal("ephemeral_use_once"),
  persistentInstall: Schema.Literal("not_authorized"),
  trustedTelemetry: Schema.Literal("not_authorized"),
} as const;
export const RecipientUseOnceIssueResponseSchema = Schema.Union([
  strictStruct({
    ...UseOnceIssueResponseFields,
    recipientAccess: Schema.Literal("authenticated"),
    accountlessPolicyResult: Schema.Literal("authenticated_account"),
  }),
  strictStruct({
    ...UseOnceIssueResponseFields,
    recipientAccess: Schema.Literal("accountless"),
    accountlessPolicyResult: Schema.Literal("public_allowed"),
  }),
]);
export type RecipientUseOnceIssueResponse = Schema.Schema.Type<
  typeof RecipientUseOnceIssueResponseSchema
>;

/** The helper receives only the opaque one-use handoff and an explicit agent selection. */
export const RecipientUseOncePreviewRequestSchema = strictStruct({
  handoffToken: RecipientUseOnceHandoffTokenSchema,
  supportedAgent: RecipientSupportedAgentSchema,
});
export type RecipientUseOncePreviewRequest = Schema.Schema.Type<
  typeof RecipientUseOncePreviewRequestSchema
>;

/** Closed request validator for the raw exact-byte endpoint outside HttpApi. */
export const RecipientUseOnceContentRequestSchema = strictStruct({
  handoffToken: RecipientUseOnceHandoffTokenSchema,
  issueId: RecipientUseOnceIssueIdSchema,
  supportedAgent: RecipientSupportedAgentSchema,
});
export type RecipientUseOnceContentRequest = Schema.Schema.Type<
  typeof RecipientUseOnceContentRequestSchema
>;

const RecipientUseOncePublisherSchema = strictStruct({ name: Schema.NonEmptyString });
const RecipientUseOnceRightsHolderSchema = strictStruct({
  kind: Schema.Literals(["organization", "user", "external"]),
  name: Schema.NonEmptyString,
});
const RecipientUseOnceLicenseSchema = strictStruct({
  expression: Schema.NonEmptyString,
  kind: Schema.Literals(["spdx", "license_ref", "proprietary"]),
  licenseEvidenceSha256: Sha256Schema,
  bundledTerms: Schema.NullOr(strictStruct({ path: Schema.NonEmptyString, sha256: Sha256Schema })),
});
const RecipientUseOnceProvenanceSchema = strictStruct({
  kind: Schema.Literals([
    "github_verified",
    "selftune_authored",
    "imported_upstream",
    "self_attested_upload",
  ]),
  sourceRepository: Schema.NullOr(Schema.String),
  sourceRef: Schema.NullOr(Schema.String),
  sourceTreeHash: Schema.NullOr(Schema.String),
});

export const RecipientUseOnceHelperContributorSignalsSchema = Schema.Union([
  strictStruct({
    _tag: Schema.Literal("unavailable"),
    signalDisclosureSha256: Sha256Schema,
    allowedFields: Schema.Tuple([]),
    defaultState: Schema.Literal("off"),
    trustedTelemetry: Schema.Literal("not_authorized"),
  }),
  strictStruct({
    _tag: Schema.Literal("portable_unverified"),
    signalDisclosureSha256: Sha256Schema,
    allowedFields: NonEmptyContributorSignalFieldsSchema,
    defaultState: Schema.Literal("off"),
    trustedTelemetry: Schema.Literal("not_authorized"),
  }),
]);
export type RecipientUseOnceHelperContributorSignals = Schema.Schema.Type<
  typeof RecipientUseOnceHelperContributorSignalsSchema
>;

export const RecipientUseOncePreviewResponseSchema = strictStruct({
  status: Schema.Literal("preview"),
  issueId: RecipientUseOnceIssueIdSchema,
  ...BindingFields,
  supportedAgent: RecipientSupportedAgentSchema,
  issuedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
  package: strictStruct({
    displayName: Schema.NonEmptyString,
    version: Schema.NonEmptyString,
    format: Schema.Literal("selftune-portable-package-v2"),
  }),
  terms: strictStruct({
    disclosureSha256: Sha256Schema,
    summary: Schema.NonEmptyString,
    issueAcceptance: Schema.Literal("accepted_at_issue"),
  }),
  publisher: RecipientUseOncePublisherSchema,
  rightsHolder: RecipientUseOnceRightsHolderSchema,
  license: RecipientUseOnceLicenseSchema,
  provenance: RecipientUseOnceProvenanceSchema,
  contributorSignals: RecipientContributorSignalDisclosureSchema,
  lifecycleReporting: RecipientUseOnceLifecycleReportingDisclosureSchema,
  helperContributorSignals: RecipientUseOnceHelperContributorSignalsSchema,
  persistence: Schema.Literal("ephemeral_use_once"),
  persistentInstall: Schema.Literal("not_authorized"),
  trustedTelemetry: Schema.Literal("not_authorized"),
  contentRetrieval: Schema.Literal("repeatable_exact_object_before_consume"),
  previewMutation: Schema.Literal("none"),
  usedOnceReporting: Schema.Literal("not_emitted"),
  consumeRequired: Schema.Literal(true),
  authorityLimits: strictStruct({
    localPath: Schema.Literal("not_provided"),
    command: Schema.Literal("not_provided"),
    url: Schema.Literal("not_provided"),
    bytes: Schema.Literal("not_provided"),
    credential: Schema.Literal("not_provided"),
    installAuthority: Schema.Literal("not_authorized"),
  }),
});
export type RecipientUseOncePreviewResponse = Schema.Schema.Type<
  typeof RecipientUseOncePreviewResponseSchema
>;

export const RecipientUseOnceConsumeRequestSchema = strictStruct({
  requestId: RecipientActionRequestIdSchema,
  handoffToken: RecipientUseOnceHandoffTokenSchema,
  expectedIssueId: RecipientUseOnceIssueIdSchema,
  expectedInvitationId: ShareInvitationIdSchema,
  expectedShareId: RecipientShareIdSchema,
  expectedDistributionId: DistributionIdSchema,
  expectedSealedObjectId: RecipientSealedObjectIdSchema,
  expectedPackagedSha256: Sha256Schema,
  supportedAgent: RecipientSupportedAgentSchema,
  ...TermsRequestFields,
  ...UseOnceConsentFields,
  executionConsent: Schema.Literal("granted"),
});
export type RecipientUseOnceConsumeRequest = Schema.Schema.Type<
  typeof RecipientUseOnceConsumeRequestSchema
>;

const UseOnceConsumeResponseFields = {
  requestId: RecipientActionRequestIdSchema,
  issueId: RecipientUseOnceIssueIdSchema,
  supportedAgent: RecipientSupportedAgentSchema,
  ...BindingFields,
  ...TermsRequestFields,
  ...UseOnceConsentFields,
  executionConsent: Schema.Literal("granted"),
  status: Schema.Literal("consumed"),
  consumedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
  persistence: Schema.Literal("ephemeral_use_once"),
  persistentInstall: Schema.Literal("not_authorized"),
  trustedTelemetry: Schema.Literal("not_authorized"),
} as const;
export const RecipientUseOnceConsumeResponseSchema = Schema.Union([
  strictStruct({
    ...UseOnceConsumeResponseFields,
    recipientAccess: Schema.Literal("authenticated"),
    accountlessPolicyResult: Schema.Literal("authenticated_account"),
  }),
  strictStruct({
    ...UseOnceConsumeResponseFields,
    recipientAccess: Schema.Literal("accountless"),
    accountlessPolicyResult: Schema.Literal("public_allowed"),
  }),
]);
export type RecipientUseOnceConsumeResponse = Schema.Schema.Type<
  typeof RecipientUseOnceConsumeResponseSchema
>;

export const RecipientDesktopInstallBootstrapRequestSchema = strictStruct({
  requestId: RecipientActionRequestIdSchema,
  ...BindingFields,
  ...TermsRequestFields,
  ...ContributorSignalFields,
});
export type RecipientDesktopInstallBootstrapRequest = Schema.Schema.Type<
  typeof RecipientDesktopInstallBootstrapRequestSchema
>;

export const RecipientDesktopInstallBootstrapResponseSchema = strictStruct({
  requestId: RecipientActionRequestIdSchema,
  ...BindingFields,
  ...TermsRequestFields,
  ...ContributorSignalFields,
  status: Schema.Literal("issued"),
  bootstrapToken: RecipientDesktopBootstrapTokenSchema,
  issuedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
});
export type RecipientDesktopInstallBootstrapResponse = Schema.Schema.Type<
  typeof RecipientDesktopInstallBootstrapResponseSchema
>;

export const RecipientDesktopDeepLinkHandoffSchema = strictStruct({
  bootstrapToken: RecipientDesktopBootstrapTokenSchema,
});
export type RecipientDesktopDeepLinkHandoff = Schema.Schema.Type<
  typeof RecipientDesktopDeepLinkHandoffSchema
>;

export const RecipientDesktopInstallPreviewRequestSchema = RecipientDesktopDeepLinkHandoffSchema;
export type RecipientDesktopInstallPreviewRequest = Schema.Schema.Type<
  typeof RecipientDesktopInstallPreviewRequestSchema
>;

export const RecipientDesktopInstallPreviewResponseSchema = strictStruct({
  ...BindingFields,
  ...TermsRequestFields,
  ...ContributorSignalFields,
  installLifecycleReporting: Schema.optional(RecipientInstallLifecycleReportingDisclosureSchema),
  status: Schema.Literal("preview"),
  expiresAt: UtcTimestampSchema,
  supportedTargetAgents: Schema.Array(RecipientSupportedAgentSchema).check(
    Schema.isNonEmpty({ message: "At least one supported target agent is required" }),
  ),
  targetAgentSelectionRequired: Schema.Literal(true),
  scopeChoices: Schema.Tuple([Schema.Literal("project"), Schema.Literal("global")]),
  scopeSelectionRequired: Schema.Literal(true),
  installModeDefault: Schema.Literal("copy"),
  conflictPolicyChoices: Schema.Tuple([
    Schema.Literal("prompt"),
    Schema.Literal("replace"),
    Schema.Literal("keep_both"),
  ]),
  conflictPolicyDefault: Schema.Literal("prompt"),
  customPathPolicy: Schema.Literal("unsupported_v1"),
  automaticDesktopInstall: Schema.Literal("not_authorized"),
  automaticSkillInstall: Schema.Literal("not_authorized"),
});
export type RecipientDesktopInstallPreviewResponse = Schema.Schema.Type<
  typeof RecipientDesktopInstallPreviewResponseSchema
>;

const ErrorMessage = Schema.NonEmptyString;

export class RecipientActionInvalid extends Schema.TaggedErrorClass<RecipientActionInvalid>()(
  "RecipientActionInvalid",
  { action: RecipientActionKindSchema, message: ErrorMessage },
  { httpApiStatus: 400 },
) {}

export class RecipientAccountRequired extends Schema.TaggedErrorClass<RecipientAccountRequired>()(
  "RecipientAccountRequired",
  {
    action: Schema.Literals(["portable_download", "use_once_issue"]),
    invitationId: ShareInvitationIdSchema,
    distributionId: DistributionIdSchema,
    policyResult: Schema.Literal("account_required"),
    message: ErrorMessage,
  },
  { httpApiStatus: 401 },
) {}

export class RecipientActionForbidden extends Schema.TaggedErrorClass<RecipientActionForbidden>()(
  "RecipientActionForbidden",
  { action: RecipientActionKindSchema, message: ErrorMessage },
  { httpApiStatus: 403 },
) {}

export class RecipientActionExpired extends Schema.TaggedErrorClass<RecipientActionExpired>()(
  "RecipientActionExpired",
  {
    action: RecipientActionKindSchema,
    expiredAt: UtcTimestampSchema,
    message: ErrorMessage,
  },
  { httpApiStatus: 410 },
) {}

export class RecipientActionReplay extends Schema.TaggedErrorClass<RecipientActionReplay>()(
  "RecipientActionReplay",
  { action: RecipientActionKindSchema, message: ErrorMessage },
  { httpApiStatus: 409 },
) {}

export class RecipientActionConflict extends Schema.TaggedErrorClass<RecipientActionConflict>()(
  "RecipientActionConflict",
  {
    action: RecipientActionKindSchema,
    distributionId: DistributionIdSchema,
    message: ErrorMessage,
  },
  { httpApiStatus: 409 },
) {}

export const RecipientActionFailureSchema = Schema.Union([
  RecipientActionInvalid,
  RecipientAccountRequired,
  RecipientActionForbidden,
  RecipientActionExpired,
  RecipientActionReplay,
  RecipientActionConflict,
]);
export type RecipientActionFailure = Schema.Schema.Type<typeof RecipientActionFailureSchema>;

export const decodeRecipientPortableDownloadRequest = Schema.decodeUnknownEffect(
  RecipientPortableDownloadRequestSchema,
);
export const decodeRecipientUseOnceIssueRequest = Schema.decodeUnknownEffect(
  RecipientUseOnceIssueRequestSchema,
);
export const decodeRecipientUseOnceConsumeRequest = Schema.decodeUnknownEffect(
  RecipientUseOnceConsumeRequestSchema,
);
export const decodeRecipientDesktopInstallBootstrapRequest = Schema.decodeUnknownEffect(
  RecipientDesktopInstallBootstrapRequestSchema,
);
export const decodeRecipientDesktopInstallPreviewRequest = Schema.decodeUnknownEffect(
  RecipientDesktopInstallPreviewRequestSchema,
);
export const decodeRecipientActionFailure = Schema.decodeUnknownEffect(
  RecipientActionFailureSchema,
);
