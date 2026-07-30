import { Exit, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

import {
  ShareInvitationAcceptance,
  ShareInvitationAcceptanceResult,
  ShareInvitationAcceptImport,
  ShareInvitationClaim,
  ShareInvitationClaimResult,
  ShareInvitationConflict,
  ShareInvitationIdSchema,
  ShareInvitationImportResult,
  ShareInvitationPreview,
  ShareInvitationPreviewRequest,
  ShareInvitationRecipientView,
  ShareInvitationUnavailable,
} from "./share-invitations";
import {
  RecipientAccountRequired,
  RecipientActionConflict,
  RecipientActionExpired,
  RecipientActionForbidden,
  RecipientActionInvalid,
  RecipientActionReplay,
  RecipientDesktopInstallBootstrapRequestSchema,
  RecipientDesktopInstallBootstrapResponseSchema,
  RecipientDesktopInstallPreviewRequestSchema,
  RecipientDesktopInstallPreviewResponseSchema,
  RecipientPortableDownloadRequestSchema,
  RecipientPortableDownloadResponseSchema,
  RecipientUseOnceConsumeRequestSchema,
  RecipientUseOnceConsumeResponseSchema,
  RecipientUseOnceIssueRequestSchema,
  RecipientUseOnceIssueResponseSchema,
  RecipientUseOncePreviewRequestSchema,
  RecipientUseOncePreviewResponseSchema,
} from "./recipient-actions";
import {
  CreatorSignalsInventory,
  DistributionReadinessInventory,
} from "./distribution-read-models";
import {
  BillingApiPaths,
  BillingCheckoutFinalizeInput,
  BillingCheckoutFinalizeResult,
  BillingCheckoutInput,
  BillingPlanIdSchema,
  BillingSession,
  BillingStatus,
} from "./billing";
import {
  CloudImproveApiPaths,
  CloudImproveRunDetail,
  CloudImproveRunList,
  CloudProposal,
  CloudProposalApplyInput,
  CloudProposalApplyResult,
  CloudProposalList,
  CloudProposalQuery,
  CloudProposalReviewInput,
} from "./cloud-improve";
import {
  CloudGithubApiPaths,
  CloudGithubConnectionSync,
  CloudGithubInstallSession,
  CloudGithubStatus,
} from "./github";
import { TeamApiPaths, TeamInviteInput, TeamRoleChangeInput, TeamStatus } from "./team";

export const ApiRoleSchema = Schema.Literals(["viewer", "member", "admin", "owner"]);
export type ApiRole = Schema.Schema.Type<typeof ApiRoleSchema>;

export const ApiPlanSchema = BillingPlanIdSchema;
export type ApiPlan = Schema.Schema.Type<typeof ApiPlanSchema>;

export const OnboardingStateSchema = Schema.Literals([
  "workspace_empty",
  "import_review",
  "inventory_seeded",
  "first_run_queued",
  "first_result_ready",
]);
export type OnboardingState = Schema.Schema.Type<typeof OnboardingStateSchema>;

export const CloudBootstrapSchema = Schema.Struct({
  viewer: Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    name: Schema.NullOr(Schema.String),
    avatarUrl: Schema.NullOr(Schema.String),
  }),
  memberships: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        orgId: Schema.String,
        orgName: Schema.String,
        orgSlug: Schema.String,
        role: ApiRoleSchema,
        plan: ApiPlanSchema,
      }),
    ),
  ),
  activeWorkspace: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    slug: Schema.String,
  }),
  plan: ApiPlanSchema,
  onboardingState: OnboardingStateSchema,
});
export type CloudBootstrap = Schema.Schema.Type<typeof CloudBootstrapSchema>;

export const CloudLibrarySkillSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  lifecycle: Schema.Literals(["active", "library", "draft", "archived"]),
  status: Schema.String,
  updateStatus: Schema.Literals(["available", "current", "unknown", "untracked"]),
  sources: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["github", "upload", "draft", "local", "other"]),
        label: Schema.String,
        href: Schema.optional(Schema.NullOr(Schema.String)),
        path: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  locations: Schema.mutable(Schema.Array(Schema.Never)),
  revisionHashes: Schema.mutable(Schema.Array(Schema.String)),
  modifiedAt: Schema.optional(Schema.NullOr(Schema.String)),
  lastUsedAt: Schema.optional(Schema.NullOr(Schema.String)),
  detailHref: Schema.optional(Schema.NullOr(Schema.String)),
});

export const CloudLibraryInventorySchema = Schema.Struct({
  skills: Schema.mutable(Schema.Array(CloudLibrarySkillSchema)),
  categoryOptions: Schema.mutable(
    Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  ),
  summary: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ready: Schema.Int,
        snapshots: Schema.Int,
        pendingActions: Schema.Int,
      }),
    ),
  ),
  note: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        title: Schema.String,
        description: Schema.String,
        link: Schema.optional(
          Schema.NullOr(Schema.Struct({ label: Schema.String, href: Schema.String })),
        ),
      }),
    ),
  ),
});
export type CloudLibraryInventory = Schema.Schema.Type<typeof CloudLibraryInventorySchema>;

/** A compact operational view of one workspace skill.
 *
 * This deliberately keeps trace-sized activity collections out of the initial
 * detail response. The detail screen needs identity, source health, and enough
 * activity context to direct the next action; runs and proposals own their
 * respective deeper screens.
 */
export const CloudSkillDetailSourceSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["github", "upload", "draft", "local", "other"]),
  status: Schema.String,
  capabilityStatus: Schema.NullOr(Schema.String),
  repoFullName: Schema.NullOr(Schema.String),
  skillPath: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

export const CloudSkillDetailSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  platform: Schema.String,
  description: Schema.NullOr(Schema.String),
  sources: Schema.mutable(Schema.Array(CloudSkillDetailSourceSchema)),
  activity: Schema.Struct({
    evalSuites: Schema.Int,
    improvementRuns: Schema.Int,
    pendingProposals: Schema.Int,
  }),
});
export type CloudSkillDetail = Schema.Schema.Type<typeof CloudSkillDetailSchema>;

export const CloudSkillDetailParams = Schema.Struct({
  skillId: Schema.NonEmptyString,
});

export const ProjectConnectionSchema = Schema.Literals([
  "codex",
  "claude_code",
  "opencode",
  "openclaw",
  "pi",
]);

export const CloudInstalledSkillSetInputSkillSchema = Schema.Struct({
  name: Schema.String,
  packagePath: Schema.String,
  provenance: Schema.optional(Schema.Literal("installed")),
});

export const CloudSkillSetInputSkillSchema = Schema.Union([
  CloudInstalledSkillSetInputSkillSchema,
  Schema.Struct({
    name: Schema.String,
    provenance: Schema.Literal("catalog"),
    catalogId: Schema.String,
    source: Schema.String,
    installSpec: Schema.String,
    downloadUrl: Schema.optional(Schema.NullOr(Schema.String)),
  }),
]);

export const CloudSkillSetInputSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  connections: Schema.mutable(Schema.Array(ProjectConnectionSchema)),
  skills: Schema.mutable(Schema.Array(CloudSkillSetInputSkillSchema)),
});
export type CloudSkillSetInput = Schema.Schema.Type<typeof CloudSkillSetInputSchema>;

export const CloudSkillSetUpdatePayloadSchema = Schema.Struct({
  parentRevisionHash: Schema.String,
  name: Schema.String,
  description: Schema.String,
  connections: Schema.mutable(Schema.Array(ProjectConnectionSchema)),
  skills: Schema.mutable(Schema.Array(CloudInstalledSkillSetInputSkillSchema)),
});
export type CloudSkillSetUpdatePayload = Schema.Schema.Type<
  typeof CloudSkillSetUpdatePayloadSchema
>;

export const CloudSkillSetUpdateSchema = Schema.Struct({
  id: Schema.String,
  ...CloudSkillSetUpdatePayloadSchema.fields,
});
export type CloudSkillSetUpdate = Schema.Schema.Type<typeof CloudSkillSetUpdateSchema>;

export const CloudSkillSetSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  connections: Schema.mutable(Schema.Array(ProjectConnectionSchema)),
  skills: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        packagePath: Schema.String,
        contentHash: Schema.String,
      }),
    ),
  ),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  revisionHash: Schema.String,
  updatedAt: Schema.String,
  ownerScope: Schema.optional(Schema.Literals(["personal", "workspace"])),
  ownerName: Schema.optional(Schema.NullOr(Schema.String)),
  workspacePolicy: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        action: Schema.Literals(["allow", "require_approval", "block", "require"]),
        reason: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});

export const CloudSkillSetInventorySchema = Schema.Struct({
  skillSets: Schema.mutable(Schema.Array(CloudSkillSetSchema)),
  availableSkills: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        packagePath: Schema.String,
        contentHash: Schema.String,
        lifecycle: Schema.String,
      }),
    ),
  ),
  receipts: Schema.mutable(Schema.Array(Schema.Never)),
});
export type CloudSkillSetInventory = Schema.Schema.Type<typeof CloudSkillSetInventorySchema>;
export type CloudSkillSet = Schema.Schema.Type<typeof CloudSkillSetSchema>;

export const CloudSkillSetExportSchema = Schema.Struct({
  filename: Schema.String,
  contentType: Schema.String,
  content: Schema.String,
});
export type CloudSkillSetExport = Schema.Schema.Type<typeof CloudSkillSetExportSchema>;

export const DeletedSchema = Schema.Struct({ deleted: Schema.Literal(true) });
export type Deleted = Schema.Schema.Type<typeof DeletedSchema>;

const ErrorFields = {
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
};

export class CloudBadRequest extends Schema.TaggedErrorClass<CloudBadRequest>()(
  "CloudBadRequest",
  ErrorFields,
  { httpApiStatus: 400 },
) {}

export class CloudUnauthorized extends Schema.TaggedErrorClass<CloudUnauthorized>()(
  "CloudUnauthorized",
  ErrorFields,
  { httpApiStatus: 401 },
) {}

export class CloudForbidden extends Schema.TaggedErrorClass<CloudForbidden>()(
  "CloudForbidden",
  ErrorFields,
  { httpApiStatus: 403 },
) {}

export class CloudPaymentRequired extends Schema.TaggedErrorClass<CloudPaymentRequired>()(
  "CloudPaymentRequired",
  ErrorFields,
  { httpApiStatus: 402 },
) {}

export class CloudNotFound extends Schema.TaggedErrorClass<CloudNotFound>()(
  "CloudNotFound",
  ErrorFields,
  { httpApiStatus: 404 },
) {}

export class CloudConflict extends Schema.TaggedErrorClass<CloudConflict>()(
  "CloudConflict",
  ErrorFields,
  { httpApiStatus: 409 },
) {}

export class CloudServiceUnavailable extends Schema.TaggedErrorClass<CloudServiceUnavailable>()(
  "CloudServiceUnavailable",
  ErrorFields,
  { httpApiStatus: 503 },
) {}

export class CloudUpstreamFailure extends Schema.TaggedErrorClass<CloudUpstreamFailure>()(
  "CloudUpstreamFailure",
  ErrorFields,
  { httpApiStatus: 502 },
) {}

export const CloudApiErrorSchema = Schema.Union([
  CloudBadRequest,
  CloudUnauthorized,
  CloudForbidden,
  CloudPaymentRequired,
  CloudNotFound,
  CloudConflict,
  CloudServiceUnavailable,
  CloudUpstreamFailure,
]);
export type CloudApiError = Schema.Schema.Type<typeof CloudApiErrorSchema>;

export const CloudDeviceCodeDecisionInputSchema = Schema.Struct({
  userCode: Schema.String,
  action: Schema.Literals(["approve", "deny"]),
});
export type CloudDeviceCodeDecisionInput = Schema.Schema.Type<
  typeof CloudDeviceCodeDecisionInputSchema
>;

export const CloudDeviceCodeDecisionSchema = Schema.Struct({
  status: Schema.Literals(["approved", "denied"]),
});
export type CloudDeviceCodeDecision = Schema.Schema.Type<typeof CloudDeviceCodeDecisionSchema>;

export const LegacyApiErrorEnvelopeSchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optional(Schema.String),
    message: Schema.String,
    status: Schema.optional(Schema.Int),
    details: Schema.optional(Schema.Unknown),
  }),
});
export type LegacyApiErrorEnvelope = Schema.Schema.Type<typeof LegacyApiErrorEnvelopeSchema>;

const CloudEndpointErrors = [
  CloudBadRequest,
  CloudUnauthorized,
  CloudForbidden,
  CloudPaymentRequired,
  CloudNotFound,
  CloudConflict,
  CloudServiceUnavailable,
  CloudUpstreamFailure,
] as const;

export const CloudApiPaths = {
  bootstrap: "/api/v1/cloud/bootstrap",
  library: "/api/v1/cloud/library",
  skillDetail: "/api/v1/cloud/skills/:skillId",
  skillSets: "/api/v1/cloud/skill-sets",
  skillSet: "/api/v1/cloud/skill-sets/:id",
  skillSetExport: "/api/v1/cloud/skill-sets/:id/export",
  skillSetExportMaterialize: "/api/v1/cloud/skill-sets/:id/export/materialize",
  deviceCode: "/api/v1/cloud/device-code",
  distributionReadiness: "/api/v1/cloud/distribution-readiness",
  creatorSignals: "/api/v1/cloud/creator-signals",
} as const;

export class CloudApiGroup extends HttpApiGroup.make("cloud")
  .add(
    HttpApiEndpoint.get("distributionReadiness", CloudApiPaths.distributionReadiness, {
      success: DistributionReadinessInventory,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("creatorSignals", CloudApiPaths.creatorSignals, {
      success: CreatorSignalsInventory,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("bootstrap", CloudApiPaths.bootstrap, {
      success: CloudBootstrapSchema,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("library", CloudApiPaths.library, {
      success: CloudLibraryInventorySchema,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillDetail", CloudApiPaths.skillDetail, {
      params: CloudSkillDetailParams,
      success: CloudSkillDetailSchema,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillSets", CloudApiPaths.skillSets, {
      success: CloudSkillSetInventorySchema,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createSkillSet", CloudApiPaths.skillSets, {
      payload: CloudSkillSetInputSchema,
      success: CloudSkillSetSchema.pipe(HttpApiSchema.status("Created")),
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateSkillSet", CloudApiPaths.skillSet, {
      params: { id: Schema.String },
      payload: CloudSkillSetUpdatePayloadSchema,
      success: CloudSkillSetSchema,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteSkillSet", CloudApiPaths.skillSet, {
      params: { id: Schema.String },
      success: DeletedSchema,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("exportSkillSet", CloudApiPaths.skillSetExport, {
      params: { id: Schema.String },
      success: CloudSkillSetExportSchema,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("materializeSkillSetExport", CloudApiPaths.skillSetExportMaterialize, {
      params: { id: Schema.String },
      success: CloudSkillSetExportSchema,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("decideDeviceCode", CloudApiPaths.deviceCode, {
      payload: CloudDeviceCodeDecisionInputSchema,
      success: CloudDeviceCodeDecisionSchema,
      error: CloudEndpointErrors,
    }),
  ) {}

export class BillingApiGroup extends HttpApiGroup.make("billing")
  .add(
    HttpApiEndpoint.get("billingStatus", BillingApiPaths.status, {
      success: BillingStatus,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createBillingCheckout", BillingApiPaths.checkout, {
      payload: BillingCheckoutInput,
      success: BillingSession,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createBillingPortal", BillingApiPaths.portal, {
      success: BillingSession,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("finalizeBillingCheckout", BillingApiPaths.finalizeCheckout, {
      payload: BillingCheckoutFinalizeInput,
      success: BillingCheckoutFinalizeResult,
      error: CloudEndpointErrors,
    }),
  ) {}

export class TeamApiGroup extends HttpApiGroup.make("team")
  .add(
    HttpApiEndpoint.get("teamStatus", TeamApiPaths.status, {
      success: TeamStatus,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("inviteTeamMember", TeamApiPaths.invite, {
      payload: TeamInviteInput,
      success: TeamStatus,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("changeTeamMemberRole", TeamApiPaths.member, {
      params: { userId: Schema.String },
      payload: TeamRoleChangeInput,
      success: TeamStatus,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeTeamMember", TeamApiPaths.member, {
      params: { userId: Schema.String },
      success: TeamStatus,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("cancelTeamInvitation", TeamApiPaths.invitation, {
      params: { invitationId: Schema.String },
      success: TeamStatus,
      error: CloudEndpointErrors,
    }),
  ) {}

export class CloudImproveApiGroup extends HttpApiGroup.make("cloudImprove")
  .add(
    HttpApiEndpoint.get("improveRuns", CloudImproveApiPaths.runs, {
      success: CloudImproveRunList,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("improveRun", CloudImproveApiPaths.run, {
      params: { runId: Schema.String },
      success: CloudImproveRunDetail,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("proposals", CloudImproveApiPaths.proposals, {
      query: CloudProposalQuery,
      success: CloudProposalList,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("proposal", CloudImproveApiPaths.proposal, {
      params: { proposalId: Schema.String },
      success: CloudProposal,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("reviewProposal", CloudImproveApiPaths.proposal, {
      params: { proposalId: Schema.String },
      payload: CloudProposalReviewInput,
      success: CloudProposal,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("applyProposal", CloudImproveApiPaths.proposalApply, {
      params: { proposalId: Schema.String },
      payload: CloudProposalApplyInput,
      success: CloudProposalApplyResult,
      error: CloudEndpointErrors,
    }),
  ) {}

/** Cloud-hosted GitHub App connection management. The app callback binds the installation here. */
export class CloudGithubApiGroup extends HttpApiGroup.make("cloudGithub")
  .add(
    HttpApiEndpoint.get("githubStatus", CloudGithubApiPaths.status, {
      success: CloudGithubStatus,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("startGithubInstall", CloudGithubApiPaths.startInstall, {
      success: CloudGithubInstallSession,
      error: CloudEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("syncGithubConnection", CloudGithubApiPaths.syncConnection, {
      params: { connectionId: Schema.String },
      success: CloudGithubConnectionSync,
      error: CloudEndpointErrors,
    }),
  ) {}

export const ShareInvitationApiPaths = {
  preview: "/api/v1/public/share-invitations/preview",
  claim: "/api/v1/share-invitations/claim",
  recipientView: "/api/v1/share-invitations/:id",
  acceptance: "/api/v1/share-invitations/:id/license-acceptance",
  acceptImport: "/api/v1/share-invitations/:id/import",
} as const;

const ShareInvitationEndpointErrors = [
  ShareInvitationUnavailable,
  ShareInvitationConflict,
  CloudBadRequest,
  CloudUnauthorized,
  CloudUpstreamFailure,
] as const;

export class ShareInvitationApiGroup extends HttpApiGroup.make("shareInvitations")
  .add(
    HttpApiEndpoint.post("preview", ShareInvitationApiPaths.preview, {
      payload: ShareInvitationPreviewRequest,
      success: ShareInvitationPreview,
      error: ShareInvitationEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("claim", ShareInvitationApiPaths.claim, {
      payload: ShareInvitationClaim,
      success: ShareInvitationClaimResult,
      error: ShareInvitationEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("recipientView", ShareInvitationApiPaths.recipientView, {
      params: { id: ShareInvitationIdSchema },
      success: ShareInvitationRecipientView,
      error: ShareInvitationEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("acceptLicense", ShareInvitationApiPaths.acceptance, {
      params: { id: ShareInvitationIdSchema },
      payload: ShareInvitationAcceptance,
      success: ShareInvitationAcceptanceResult,
      error: ShareInvitationEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("acceptImport", ShareInvitationApiPaths.acceptImport, {
      params: { id: ShareInvitationIdSchema },
      payload: ShareInvitationAcceptImport,
      success: ShareInvitationImportResult,
      error: ShareInvitationEndpointErrors,
    }),
  ) {}

export const RecipientActionApiPaths = {
  portableDownload: "/api/v1/recipient-actions/download",
  useOnceIssue: "/api/v1/recipient-actions/use-once/issue",
  useOncePreview: "/api/v1/recipient-actions/use-once/preview",
  useOnceConsume: "/api/v1/recipient-actions/use-once/consume",
  desktopBootstrap: "/api/v1/recipient-actions/desktop/bootstrap",
  desktopPreview: "/api/v1/recipient-actions/desktop/preview",
} as const;

const RecipientActionEndpointErrors = [
  RecipientActionInvalid,
  RecipientAccountRequired,
  RecipientActionForbidden,
  RecipientActionExpired,
  RecipientActionReplay,
  RecipientActionConflict,
] as const;

export class RecipientActionApiGroup extends HttpApiGroup.make("recipientActions")
  .add(
    HttpApiEndpoint.post("portableDownload", RecipientActionApiPaths.portableDownload, {
      payload: RecipientPortableDownloadRequestSchema,
      success: RecipientPortableDownloadResponseSchema,
      error: RecipientActionEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("useOnceIssue", RecipientActionApiPaths.useOnceIssue, {
      payload: RecipientUseOnceIssueRequestSchema,
      success: RecipientUseOnceIssueResponseSchema,
      error: RecipientActionEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("useOncePreview", RecipientActionApiPaths.useOncePreview, {
      payload: RecipientUseOncePreviewRequestSchema,
      success: RecipientUseOncePreviewResponseSchema,
      error: RecipientActionEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("useOnceConsume", RecipientActionApiPaths.useOnceConsume, {
      payload: RecipientUseOnceConsumeRequestSchema,
      success: RecipientUseOnceConsumeResponseSchema,
      error: RecipientActionEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("desktopBootstrap", RecipientActionApiPaths.desktopBootstrap, {
      payload: RecipientDesktopInstallBootstrapRequestSchema,
      success: RecipientDesktopInstallBootstrapResponseSchema,
      error: RecipientActionEndpointErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("desktopPreview", RecipientActionApiPaths.desktopPreview, {
      payload: RecipientDesktopInstallPreviewRequestSchema,
      success: RecipientDesktopInstallPreviewResponseSchema,
      error: RecipientActionEndpointErrors,
    }),
  ) {}

/** Separate contract surface so Phase 4A adds no host route implementation requirement. */
export const RecipientActionApi = HttpApi.make("selftune-recipient-actions").add(
  RecipientActionApiGroup,
);

export const SelfTuneCloudApi = HttpApi.make("selftune-cloud")
  .add(CloudApiGroup)
  .add(BillingApiGroup)
  .add(TeamApiGroup)
  .add(CloudImproveApiGroup)
  .add(CloudGithubApiGroup)
  .add(ShareInvitationApiGroup);

export interface DecodeSuccess<A> {
  readonly success: true;
  readonly data: A;
}

export interface DecodeFailure {
  readonly success: false;
  readonly issues: string;
}

export type DecodeResult<A> = DecodeSuccess<A> | DecodeFailure;

/** Plain adapter for legacy runtimes that must not import a second validation library. */
export function decodeUnknown<S extends Schema.Decoder<unknown, never>>(
  schema: S,
  input: unknown,
): DecodeResult<S["Type"]> {
  const result = Schema.decodeUnknownExit(schema)(input);
  return Exit.isSuccess(result)
    ? { success: true, data: result.value }
    : { success: false, issues: String(result.cause) };
}

export function decodeUnknownOrThrow<S extends Schema.Decoder<unknown, never>>(
  schema: S,
  input: unknown,
): S["Type"] {
  const result = decodeUnknown(schema, input);
  if (result.success) return result.data;
  throw new TypeError(result.issues);
}
