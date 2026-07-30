import { Cause, Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import {
  RecipientActionApi,
  SelfTuneCloudApi,
  type CloudApiError,
  type CloudBootstrap,
  type CloudDeviceCodeDecision,
  type CloudDeviceCodeDecisionInput,
  type CloudLibraryInventory,
  type CloudSkillDetail,
  type CloudSkillSet,
  type CloudSkillSetExport,
  type CloudSkillSetInput,
  type CloudSkillSetInventory,
  type CloudSkillSetUpdate,
} from "./contracts";
import type { BillingCheckoutFinalizeResult, BillingSession, BillingStatus } from "./billing";
import type {
  CloudGithubConnectionSync,
  CloudGithubInstallSession,
  CloudGithubStatus,
} from "./github";
import { BillingCheckoutFinalizeInput, BillingCheckoutInput } from "./billing";
import { TeamInviteInput, TeamRoleChangeInput } from "./team";
import type { TeamStatus } from "./team";
import {
  CloudProposalApplyInput,
  CloudProposalQuery,
  CloudProposalReviewInput,
} from "./cloud-improve";
import type {
  CloudImproveRunDetail,
  CloudImproveRunList,
  CloudProposal,
  CloudProposalApplyResult,
  CloudProposalList,
} from "./cloud-improve";
import type {
  CreatorSignalsInventory,
  DistributionReadinessInventory,
} from "./distribution-read-models";
import {
  ShareInvitationConflict,
  ShareInvitationPreviewRequest,
  ShareInvitationUnavailable,
} from "./share-invitations";
import type {
  ShareInvitationAcceptance,
  ShareInvitationAcceptanceResult,
  ShareInvitationAcceptImport,
  ShareInvitationClaim,
  ShareInvitationClaimToken,
  ShareInvitationClaimResult,
  ShareInvitationId,
  ShareInvitationImportResult,
  ShareInvitationPreview,
  ShareInvitationRecipientView,
} from "./share-invitations";
import {
  RecipientAccountRequired,
  RecipientActionConflict,
  RecipientActionExpired,
  RecipientActionForbidden,
  RecipientActionInvalid,
  RecipientActionReplay,
} from "./recipient-actions";
import type {
  RecipientDesktopInstallBootstrapRequest,
  RecipientDesktopInstallBootstrapResponse,
  RecipientDesktopInstallPreviewRequest,
  RecipientDesktopInstallPreviewResponse,
  RecipientPortableDownloadRequest,
  RecipientPortableDownloadResponse,
  RecipientUseOnceConsumeRequest,
  RecipientUseOnceConsumeResponse,
  RecipientUseOnceIssueRequest,
  RecipientUseOnceIssueResponse,
  RecipientUseOncePreviewRequest,
  RecipientUseOncePreviewResponse,
} from "./recipient-actions";

export type ApiClientErrorKind = "http" | "invalid_response" | "network";

interface ApiClientErrorOptions {
  readonly kind: ApiClientErrorKind;
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly cause?: unknown;
}

/** Stable Promise-boundary error for React and other non-Effect consumers. */
export class ApiClientError extends Error {
  readonly kind: ApiClientErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly details: unknown;

  constructor(options: ApiClientErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "ApiClientError";
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.details = options.details;
  }
}

export interface ApiRequestOptions {
  readonly signal?: AbortSignal;
}

export interface CloudApiClientOptions {
  /** Origin only, such as `https://cloud.selftune.dev`. Defaults to same-origin. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: HeadersInit;
  readonly credentials?: RequestCredentials;
  readonly getAccessToken?: () => null | string | Promise<null | string>;
  readonly getActiveOrganizationId?: () => null | string;
}

export interface CloudApiClient {
  readonly bootstrap: (options?: ApiRequestOptions) => Promise<CloudBootstrap>;
  readonly distributionReadiness: (
    options?: ApiRequestOptions,
  ) => Promise<DistributionReadinessInventory>;
  readonly creatorSignals: (options?: ApiRequestOptions) => Promise<CreatorSignalsInventory>;
  readonly library: (options?: ApiRequestOptions) => Promise<CloudLibraryInventory>;
  readonly skillDetail: (skillId: string, options?: ApiRequestOptions) => Promise<CloudSkillDetail>;
  readonly skillSets: (options?: ApiRequestOptions) => Promise<CloudSkillSetInventory>;
  readonly createSkillSet: (
    input: CloudSkillSetInput,
    options?: ApiRequestOptions,
  ) => Promise<CloudSkillSet>;
  readonly updateSkillSet: (
    input: CloudSkillSetUpdate,
    options?: ApiRequestOptions,
  ) => Promise<CloudSkillSet>;
  readonly deleteSkillSet: (id: string, options?: ApiRequestOptions) => Promise<void>;
  readonly exportSkillSet: (
    id: string,
    options?: ApiRequestOptions,
  ) => Promise<CloudSkillSetExport>;
  readonly materializeSkillSetExport: (
    id: string,
    options?: ApiRequestOptions,
  ) => Promise<CloudSkillSetExport>;
  readonly decideDeviceCode: (
    input: CloudDeviceCodeDecisionInput,
    options?: ApiRequestOptions,
  ) => Promise<CloudDeviceCodeDecision>;
  readonly billingStatus: (options?: ApiRequestOptions) => Promise<BillingStatus>;
  readonly createBillingCheckout: (
    input: BillingCheckoutInput,
    options?: ApiRequestOptions,
  ) => Promise<BillingSession>;
  readonly createBillingPortal: (options?: ApiRequestOptions) => Promise<BillingSession>;
  readonly finalizeBillingCheckout: (
    input: BillingCheckoutFinalizeInput,
    options?: ApiRequestOptions,
  ) => Promise<BillingCheckoutFinalizeResult>;
  readonly teamStatus: (options?: ApiRequestOptions) => Promise<TeamStatus>;
  readonly inviteTeamMember: (
    input: TeamInviteInput,
    options?: ApiRequestOptions,
  ) => Promise<TeamStatus>;
  readonly changeTeamMemberRole: (
    userId: string,
    input: TeamRoleChangeInput,
    options?: ApiRequestOptions,
  ) => Promise<TeamStatus>;
  readonly removeTeamMember: (userId: string, options?: ApiRequestOptions) => Promise<TeamStatus>;
  readonly cancelTeamInvitation: (
    invitationId: string,
    options?: ApiRequestOptions,
  ) => Promise<TeamStatus>;
  readonly improveRuns: (options?: ApiRequestOptions) => Promise<CloudImproveRunList>;
  readonly improveRun: (
    runId: string,
    options?: ApiRequestOptions,
  ) => Promise<CloudImproveRunDetail>;
  readonly proposals: (
    query?: CloudProposalQuery,
    options?: ApiRequestOptions,
  ) => Promise<CloudProposalList>;
  readonly proposal: (proposalId: string, options?: ApiRequestOptions) => Promise<CloudProposal>;
  readonly reviewProposal: (
    proposalId: string,
    input: CloudProposalReviewInput,
    options?: ApiRequestOptions,
  ) => Promise<CloudProposal>;
  readonly applyProposal: (
    proposalId: string,
    input?: CloudProposalApplyInput,
    options?: ApiRequestOptions,
  ) => Promise<CloudProposalApplyResult>;
  readonly githubStatus: (options?: ApiRequestOptions) => Promise<CloudGithubStatus>;
  readonly startGithubInstall: (options?: ApiRequestOptions) => Promise<CloudGithubInstallSession>;
  readonly syncGithubConnection: (
    connectionId: string,
    options?: ApiRequestOptions,
  ) => Promise<CloudGithubConnectionSync>;
  readonly previewShareInvitation: (
    claimToken: ShareInvitationClaimToken,
    options?: ApiRequestOptions,
  ) => Promise<ShareInvitationPreview>;
  readonly claimShareInvitation: (
    input: ShareInvitationClaim,
    options?: ApiRequestOptions,
  ) => Promise<ShareInvitationClaimResult>;
  readonly getShareInvitation: (
    invitationId: ShareInvitationId,
    options?: ApiRequestOptions,
  ) => Promise<ShareInvitationRecipientView>;
  readonly acceptShareInvitationLicense: (
    invitationId: ShareInvitationId,
    input: ShareInvitationAcceptance,
    options?: ApiRequestOptions,
  ) => Promise<ShareInvitationAcceptanceResult>;
  readonly acceptAndImportShareInvitation: (
    invitationId: ShareInvitationId,
    input: ShareInvitationAcceptImport,
    options?: ApiRequestOptions,
  ) => Promise<ShareInvitationImportResult>;
  readonly requestRecipientPortableDownload: (
    input: RecipientPortableDownloadRequest,
    options?: ApiRequestOptions,
  ) => Promise<RecipientPortableDownloadResponse>;
  readonly issueRecipientUseOnce: (
    input: RecipientUseOnceIssueRequest,
    options?: ApiRequestOptions,
  ) => Promise<RecipientUseOnceIssueResponse>;
  readonly previewRecipientUseOnce: (
    input: RecipientUseOncePreviewRequest,
    options?: ApiRequestOptions,
  ) => Promise<RecipientUseOncePreviewResponse>;
  readonly consumeRecipientUseOnce: (
    input: RecipientUseOnceConsumeRequest,
    options?: ApiRequestOptions,
  ) => Promise<RecipientUseOnceConsumeResponse>;
  readonly bootstrapRecipientDesktopInstall: (
    input: RecipientDesktopInstallBootstrapRequest,
    options?: ApiRequestOptions,
  ) => Promise<RecipientDesktopInstallBootstrapResponse>;
  readonly previewRecipientDesktopInstall: (
    input: RecipientDesktopInstallPreviewRequest,
    options?: ApiRequestOptions,
  ) => Promise<RecipientDesktopInstallPreviewResponse>;
}

function isTaggedCloudApiError(error: unknown): error is CloudApiError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  const tag = error._tag;
  return (
    tag === "CloudBadRequest" ||
    tag === "CloudUnauthorized" ||
    tag === "CloudForbidden" ||
    tag === "CloudPaymentRequired" ||
    tag === "CloudNotFound" ||
    tag === "CloudConflict" ||
    tag === "CloudServiceUnavailable" ||
    tag === "CloudUpstreamFailure"
  );
}

function isTaggedShareInvitationError(
  error: unknown,
): error is ShareInvitationUnavailable | ShareInvitationConflict {
  return error instanceof ShareInvitationUnavailable || error instanceof ShareInvitationConflict;
}

type RecipientClientFailure =
  | RecipientActionInvalid
  | RecipientAccountRequired
  | RecipientActionForbidden
  | RecipientActionExpired
  | RecipientActionReplay
  | RecipientActionConflict;

function isTaggedRecipientActionError(error: unknown): error is RecipientClientFailure {
  return (
    error instanceof RecipientActionInvalid ||
    error instanceof RecipientAccountRequired ||
    error instanceof RecipientActionForbidden ||
    error instanceof RecipientActionExpired ||
    error instanceof RecipientActionReplay ||
    error instanceof RecipientActionConflict
  );
}

function statusForRecipientActionError(error: RecipientClientFailure): number {
  switch (error._tag) {
    case "RecipientActionInvalid":
      return 400;
    case "RecipientAccountRequired":
      return 401;
    case "RecipientActionForbidden":
      return 403;
    case "RecipientActionExpired":
      return 410;
    case "RecipientActionReplay":
    case "RecipientActionConflict":
      return 409;
  }
}

function statusForCloudApiError(error: CloudApiError): number {
  switch (error._tag) {
    case "CloudBadRequest":
      return 400;
    case "CloudUnauthorized":
      return 401;
    case "CloudForbidden":
      return 403;
    case "CloudPaymentRequired":
      return 402;
    case "CloudNotFound":
      return 404;
    case "CloudConflict":
      return 409;
    case "CloudServiceUnavailable":
      return 503;
    case "CloudUpstreamFailure":
      return 502;
  }
}

function normalizeClientError(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) return error;
  if (isTaggedCloudApiError(error)) {
    return new ApiClientError({
      kind: "http",
      message: error.message,
      status: statusForCloudApiError(error),
      code: error.code,
      details: error.details,
      cause: error,
    });
  }
  if (isTaggedShareInvitationError(error)) {
    return new ApiClientError({
      kind: "http",
      message: error.message,
      status: error._tag === "ShareInvitationUnavailable" ? 404 : 409,
      code: error._tag,
      cause: error,
    });
  }
  if (isTaggedRecipientActionError(error)) {
    return new ApiClientError({
      kind: "http",
      message: error.message,
      status: statusForRecipientActionError(error),
      code: error._tag,
      cause: error,
    });
  }
  if (Schema.isSchemaError(error)) {
    return new ApiClientError({
      kind: "invalid_response",
      message: "selftune API returned an invalid response payload.",
      code: "invalid_response_payload",
      details: String(error),
      cause: error,
    });
  }
  if (HttpClientError.isHttpClientError(error)) {
    const status = error.response?.status;
    return new ApiClientError({
      kind: status === undefined ? "network" : "http",
      message:
        status === undefined
          ? "Unable to reach the selftune API."
          : `selftune API request failed with ${status}.`,
      status,
      cause: error,
    });
  }
  return new ApiClientError({
    kind: "network",
    message: "Unable to reach the selftune API.",
    cause: error,
  });
}

export function createCloudApiClient(options: CloudApiClientOptions = {}): CloudApiClient {
  const baseUrl =
    options.baseUrl ??
    (typeof globalThis.location === "undefined" ? "http://localhost" : globalThis.location.origin);
  const configuredHeaders = new Headers(options.headers);
  const configuredHeaderEntries: Array<readonly [string, string]> = [];
  configuredHeaders.forEach((value, key) => configuredHeaderEntries.push([key, value]));
  const transformClient = HttpClient.mapRequestEffect((request) =>
    Effect.gen(function* () {
      let next = HttpClientRequest.setHeaders(request, configuredHeaderEntries);
      const token = options.getAccessToken
        ? yield* Effect.promise(() => Promise.resolve(options.getAccessToken?.() ?? null))
        : null;
      const organizationId = options.getActiveOrganizationId?.();
      if (token && !configuredHeaders.has("authorization")) {
        next = HttpClientRequest.setHeader(next, "authorization", `Bearer ${token}`);
      }
      if (organizationId && !configuredHeaders.has("x-selftune-active-org-id")) {
        next = HttpClientRequest.setHeader(next, "x-selftune-active-org-id", organizationId);
      }
      return next;
    }),
  );

  const generated = Effect.runSync(
    HttpApiClient.make(SelfTuneCloudApi, {
      baseUrl,
      transformClient,
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  const recipientActionsGenerated = Effect.runSync(
    HttpApiClient.make(RecipientActionApi, {
      baseUrl,
      transformClient,
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  function run<A, E>(effect: Effect.Effect<A, E>, requestOptions: ApiRequestOptions = {}) {
    let runnable = effect.pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials: options.credentials ?? "include",
      }),
      Effect.catchCause((cause) => Effect.fail(normalizeClientError(Cause.squash(cause)))),
    );
    if (options.fetch) {
      runnable = runnable.pipe(Effect.provideService(FetchHttpClient.Fetch, options.fetch));
    }
    return Effect.runPromise(runnable, { signal: requestOptions.signal });
  }

  return {
    bootstrap: (requestOptions) => run(generated.cloud.bootstrap(), requestOptions),
    distributionReadiness: (requestOptions) =>
      run(generated.cloud.distributionReadiness(), requestOptions),
    creatorSignals: (requestOptions) => run(generated.cloud.creatorSignals(), requestOptions),
    library: (requestOptions) => run(generated.cloud.library(), requestOptions),
    skillDetail: (skillId, requestOptions) =>
      run(generated.cloud.skillDetail({ params: { skillId } }), requestOptions),
    skillSets: (requestOptions) => run(generated.cloud.skillSets(), requestOptions),
    createSkillSet: (input, requestOptions) =>
      run(generated.cloud.createSkillSet({ payload: input }), requestOptions),
    updateSkillSet: ({ id, ...payload }, requestOptions) =>
      run(generated.cloud.updateSkillSet({ params: { id }, payload }), requestOptions),
    deleteSkillSet: async (id, requestOptions) => {
      await run(generated.cloud.deleteSkillSet({ params: { id } }), requestOptions);
    },
    exportSkillSet: (id, requestOptions) =>
      run(generated.cloud.exportSkillSet({ params: { id } }), requestOptions),
    materializeSkillSetExport: (id, requestOptions) =>
      run(generated.cloud.materializeSkillSetExport({ params: { id } }), requestOptions),
    decideDeviceCode: (input, requestOptions) =>
      run(generated.cloud.decideDeviceCode({ payload: input }), requestOptions),
    billingStatus: (requestOptions) => run(generated.billing.billingStatus(), requestOptions),
    createBillingCheckout: (input, requestOptions) =>
      run(
        generated.billing.createBillingCheckout({ payload: new BillingCheckoutInput(input) }),
        requestOptions,
      ),
    createBillingPortal: (requestOptions) =>
      run(generated.billing.createBillingPortal(), requestOptions),
    finalizeBillingCheckout: (input, requestOptions) =>
      run(
        generated.billing.finalizeBillingCheckout({
          payload: new BillingCheckoutFinalizeInput(input),
        }),
        requestOptions,
      ),
    teamStatus: (requestOptions) => run(generated.team.teamStatus(), requestOptions),
    inviteTeamMember: (input, requestOptions) =>
      run(generated.team.inviteTeamMember({ payload: new TeamInviteInput(input) }), requestOptions),
    changeTeamMemberRole: (userId, input, requestOptions) =>
      run(
        generated.team.changeTeamMemberRole({
          params: { userId },
          payload: new TeamRoleChangeInput(input),
        }),
        requestOptions,
      ),
    removeTeamMember: (userId, requestOptions) =>
      run(generated.team.removeTeamMember({ params: { userId } }), requestOptions),
    cancelTeamInvitation: (invitationId, requestOptions) =>
      run(generated.team.cancelTeamInvitation({ params: { invitationId } }), requestOptions),
    improveRuns: (requestOptions) => run(generated.cloudImprove.improveRuns(), requestOptions),
    improveRun: (runId, requestOptions) =>
      run(generated.cloudImprove.improveRun({ params: { runId } }), requestOptions),
    proposals: (query = {}, requestOptions) =>
      run(
        generated.cloudImprove.proposals({ query: new CloudProposalQuery(query) }),
        requestOptions,
      ),
    proposal: (proposalId, requestOptions) =>
      run(generated.cloudImprove.proposal({ params: { proposalId } }), requestOptions),
    reviewProposal: (proposalId, input, requestOptions) =>
      run(
        generated.cloudImprove.reviewProposal({
          params: { proposalId },
          payload: new CloudProposalReviewInput(input),
        }),
        requestOptions,
      ),
    applyProposal: (proposalId, input = {}, requestOptions) =>
      run(
        generated.cloudImprove.applyProposal({
          params: { proposalId },
          payload: new CloudProposalApplyInput(input),
        }),
        requestOptions,
      ),
    githubStatus: (requestOptions) => run(generated.cloudGithub.githubStatus(), requestOptions),
    startGithubInstall: (requestOptions) =>
      run(generated.cloudGithub.startGithubInstall(), requestOptions),
    syncGithubConnection: (connectionId, requestOptions) =>
      run(generated.cloudGithub.syncGithubConnection({ params: { connectionId } }), requestOptions),
    previewShareInvitation: (claimToken, requestOptions) =>
      run(
        generated.shareInvitations.preview({
          payload: new ShareInvitationPreviewRequest({ claimToken }),
        }),
        requestOptions,
      ),
    claimShareInvitation: (input, requestOptions) =>
      run(generated.shareInvitations.claim({ payload: input }), requestOptions),
    getShareInvitation: (invitationId, requestOptions) =>
      run(
        generated.shareInvitations.recipientView({ params: { id: invitationId } }),
        requestOptions,
      ),
    acceptShareInvitationLicense: (invitationId, input, requestOptions) =>
      run(
        generated.shareInvitations.acceptLicense({
          params: { id: invitationId },
          payload: input,
        }),
        requestOptions,
      ),
    acceptAndImportShareInvitation: (invitationId, input, requestOptions) =>
      run(
        generated.shareInvitations.acceptImport({
          params: { id: invitationId },
          payload: input,
        }),
        requestOptions,
      ),
    requestRecipientPortableDownload: (input, requestOptions) =>
      run(
        recipientActionsGenerated.recipientActions.portableDownload({ payload: input }),
        requestOptions,
      ),
    issueRecipientUseOnce: (input, requestOptions) =>
      run(
        recipientActionsGenerated.recipientActions.useOnceIssue({ payload: input }),
        requestOptions,
      ),
    previewRecipientUseOnce: (input, requestOptions) =>
      run(
        recipientActionsGenerated.recipientActions.useOncePreview({ payload: input }),
        requestOptions,
      ),
    consumeRecipientUseOnce: (input, requestOptions) =>
      run(
        recipientActionsGenerated.recipientActions.useOnceConsume({ payload: input }),
        requestOptions,
      ),
    bootstrapRecipientDesktopInstall: (input, requestOptions) =>
      run(
        recipientActionsGenerated.recipientActions.desktopBootstrap({ payload: input }),
        requestOptions,
      ),
    previewRecipientDesktopInstall: (input, requestOptions) =>
      run(
        recipientActionsGenerated.recipientActions.desktopPreview({ payload: input }),
        requestOptions,
      ),
  };
}
