import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  RecipientAccountRequired,
  RecipientActionConflict,
  RecipientActionExpired,
  RecipientActionForbidden,
  RecipientActionInvalid,
  RecipientActionReplay,
  RecipientActionApi,
  RecipientDesktopInstallBootstrapRequestSchema,
  RecipientDesktopInstallPreviewRequestSchema,
  RecipientPortableDownloadRequestSchema,
  RecipientUseOnceConsumeRequestSchema,
  RecipientUseOnceIssueRequestSchema,
  RecipientUseOncePreviewRequestSchema,
  UtcTimestampSchema,
  createCloudApiClient,
} from "../index";

const requestId = "10000000-0000-4000-8000-000000000001";
const invitationId = "20000000-0000-4000-8000-000000000002";
const shareId = "30000000-0000-4000-8000-000000000003";
const distributionId = "40000000-0000-4000-8000-000000000004";
const sealedObjectId = "50000000-0000-4000-8000-000000000005";
const authorizationId = "60000000-0000-4000-8000-000000000006";
const signalRecipientOrganizationId = "70000000-0000-4000-8000-000000000007";
const issueId = "80000000-0000-4000-8000-000000000008";
const packageHash = "a".repeat(64);
const termsHash = "b".repeat(64);
const signalsHash = "c".repeat(64);
const lifecycleHash = "d".repeat(64);
const handoffToken = "A".repeat(43);
const issuedAt = "2026-07-21T12:00:00.000Z";
const expiresAt = "2026-07-21T12:05:00.000Z";

const binding = {
  invitationId,
  shareId,
  distributionId,
  sealedObjectId,
  packagedSha256: packageHash,
};
const terms = { termsDisclosureSha256: termsHash, termsAcceptance: "accepted" } as const;
const contributorSignals = {
  _tag: "capable_default_off",
  signalDisclosureSha256: signalsHash,
  signalRecipientOrganizationId,
  allowedFields: ["trigger", "grade"],
  capability: "capable",
  defaultState: "off",
  contributorConsent: "not_granted",
  enabled: false,
} as const;
const lifecycleReporting = {
  _tag: "downloaded_status",
  lifecycleDisclosureSha256: lifecycleHash,
  consent: "not_granted",
  senderVisibleDownloadedStatus: "disabled",
} as const;
const useOnceLifecycleReporting = {
  _tag: "used_once_status",
  lifecycleDisclosureSha256: lifecycleHash,
  consent: "not_granted",
  senderVisibleUsedOnceStatus: "disabled",
} as const;
const download = Schema.decodeUnknownSync(RecipientPortableDownloadRequestSchema)({
  requestId,
  ...binding,
  ...terms,
  recipientAccess: "accountless",
  contributorSignals,
  lifecycleReporting,
});
const issueUseOnce = Schema.decodeUnknownSync(RecipientUseOnceIssueRequestSchema)({
  requestId,
  ...binding,
  ...terms,
  contributorSignals,
  lifecycleReporting: useOnceLifecycleReporting,
  supportedAgent: "codex",
  executionConsent: "granted",
  recipientAccess: "accountless",
});
const consumeUseOnce = Schema.decodeUnknownSync(RecipientUseOnceConsumeRequestSchema)({
  requestId,
  handoffToken,
  expectedIssueId: issueId,
  expectedInvitationId: invitationId,
  expectedShareId: shareId,
  expectedDistributionId: distributionId,
  expectedSealedObjectId: sealedObjectId,
  expectedPackagedSha256: packageHash,
  supportedAgent: "codex",
  ...terms,
  contributorSignals,
  lifecycleReporting: useOnceLifecycleReporting,
  executionConsent: "granted",
});
const bootstrapDesktop = Schema.decodeUnknownSync(RecipientDesktopInstallBootstrapRequestSchema)({
  requestId,
  ...binding,
  ...terms,
  contributorSignals,
});
const previewDesktop = Schema.decodeUnknownSync(RecipientDesktopInstallPreviewRequestSchema)({
  bootstrapToken: handoffToken,
});
const previewUseOnce = Schema.decodeUnknownSync(RecipientUseOncePreviewRequestSchema)({
  handoffToken,
  supportedAgent: "codex",
});
const helperPreviewResponse = {
  status: "preview",
  issueId,
  ...binding,
  supportedAgent: "codex",
  issuedAt,
  expiresAt,
  package: {
    displayName: "review-helper",
    version: packageHash,
    format: "selftune-portable-package-v2",
  },
  terms: {
    disclosureSha256: termsHash,
    summary: "Use once under MIT; persistent install and trusted telemetry are not authorized.",
    issueAcceptance: "accepted_at_issue",
  },
  publisher: { name: "Acme Skills" },
  rightsHolder: { kind: "organization", name: "Acme Skills" },
  license: {
    expression: "MIT",
    kind: "spdx",
    licenseEvidenceSha256: "e".repeat(64),
    bundledTerms: null,
  },
  provenance: {
    kind: "selftune_authored",
    sourceRepository: null,
    sourceRef: null,
    sourceTreeHash: null,
  },
  contributorSignals,
  lifecycleReporting: useOnceLifecycleReporting,
  helperContributorSignals: {
    _tag: "portable_unverified",
    signalDisclosureSha256: signalsHash,
    allowedFields: ["trigger", "grade"],
    defaultState: "off",
    trustedTelemetry: "not_authorized",
  },
  persistence: "ephemeral_use_once",
  persistentInstall: "not_authorized",
  trustedTelemetry: "not_authorized",
  contentRetrieval: "repeatable_exact_object_before_consume",
  previewMutation: "none",
  usedOnceReporting: "not_emitted",
  consumeRequired: true,
  authorityLimits: {
    localPath: "not_provided",
    command: "not_provided",
    url: "not_provided",
    bytes: "not_provided",
    credential: "not_provided",
    installAuthority: "not_authorized",
  },
} as const;

function recordingFetch(requests: Request[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/download")) {
      return Response.json({
        ...download,
        status: "authorized",
        downloadAuthorizationId: authorizationId,
        accountlessPolicyResult: "public_allowed",
        packageFormat: "selftune-portable-package-v2",
        localInstall: "not_requested",
        authorizedAt: issuedAt,
        expiresAt,
      });
    }
    if (path.endsWith("/use-once/issue")) {
      return Response.json({
        ...issueUseOnce,
        status: "issued",
        issueId,
        handoffToken,
        accountlessPolicyResult: "public_allowed",
        issuedAt,
        expiresAt,
        persistence: "ephemeral_use_once",
        persistentInstall: "not_authorized",
        trustedTelemetry: "not_authorized",
      });
    }
    if (path.endsWith("/use-once/preview")) {
      return Response.json(helperPreviewResponse);
    }
    if (path.endsWith("/use-once/consume")) {
      return Response.json({
        ...binding,
        requestId,
        issueId,
        supportedAgent: "codex",
        ...terms,
        contributorSignals,
        lifecycleReporting: useOnceLifecycleReporting,
        executionConsent: "granted",
        recipientAccess: "accountless",
        accountlessPolicyResult: "public_allowed",
        status: "consumed",
        consumedAt: issuedAt,
        expiresAt,
        persistence: "ephemeral_use_once",
        persistentInstall: "not_authorized",
        trustedTelemetry: "not_authorized",
      });
    }
    if (path.endsWith("/desktop/bootstrap")) {
      return Response.json({
        ...bootstrapDesktop,
        status: "issued",
        bootstrapToken: handoffToken,
        issuedAt,
        expiresAt,
      });
    }
    return Response.json({
      ...binding,
      ...terms,
      contributorSignals,
      status: "preview",
      expiresAt,
      supportedTargetAgents: ["codex", "claude_code"],
      targetAgentSelectionRequired: true,
      scopeChoices: ["project", "global"],
      scopeSelectionRequired: true,
      installModeDefault: "copy",
      conflictPolicyChoices: ["prompt", "replace", "keep_both"],
      conflictPolicyDefault: "prompt",
      customPathPolicy: "unsupported_v1",
      automaticDesktopInstall: "not_authorized",
      automaticSkillInstall: "not_authorized",
    });
  };
}

describe("recipient action HttpApi client seam", () => {
  it("publishes the recipient action group and all six host-neutral requests", async () => {
    expect(RecipientActionApi.groups).toHaveProperty("recipientActions");
    const requests: Request[] = [];
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: recordingFetch(requests),
    });

    await expect(client.requestRecipientPortableDownload(download)).resolves.toMatchObject({
      accountlessPolicyResult: "public_allowed",
      localInstall: "not_requested",
    });
    await client.issueRecipientUseOnce(issueUseOnce);
    await expect(client.previewRecipientUseOnce(previewUseOnce)).resolves.toMatchObject({
      issueId,
      contentRetrieval: "repeatable_exact_object_before_consume",
      trustedTelemetry: "not_authorized",
    });
    await client.consumeRecipientUseOnce(consumeUseOnce);
    await client.bootstrapRecipientDesktopInstall(bootstrapDesktop);
    await client.previewRecipientDesktopInstall(previewDesktop);

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "POST /api/v1/recipient-actions/download",
        "POST /api/v1/recipient-actions/use-once/issue",
        "POST /api/v1/recipient-actions/use-once/preview",
        "POST /api/v1/recipient-actions/use-once/consume",
        "POST /api/v1/recipient-actions/desktop/bootstrap",
        "POST /api/v1/recipient-actions/desktop/preview",
      ],
    );
    await expect(requests[5]?.json()).resolves.toEqual({ bootstrapToken: handoffToken });
  });

  it.each([
    [new RecipientActionInvalid({ action: "portable_download", message: "invalid" }), 400],
    [
      new RecipientAccountRequired({
        action: "portable_download",
        invitationId: download.invitationId,
        distributionId: download.distributionId,
        policyResult: "account_required",
        message: "account required",
      }),
      401,
    ],
    [
      new RecipientAccountRequired({
        action: "use_once_issue",
        invitationId: issueUseOnce.invitationId,
        distributionId: issueUseOnce.distributionId,
        policyResult: "account_required",
        message: "account required for use once",
      }),
      401,
    ],
    [
      new RecipientActionExpired({
        action: "portable_download",
        expiredAt: Schema.decodeUnknownSync(UtcTimestampSchema)(expiresAt),
        message: "expired",
      }),
      410,
    ],
    [
      RecipientActionForbidden.make({
        action: "portable_download",
        message: "recipient action unavailable",
      }),
      403,
    ],
    [
      new RecipientActionConflict({
        action: "portable_download",
        distributionId: download.distributionId,
        message: "conflict",
      }),
      409,
    ],
    [new RecipientActionReplay({ action: "use_once_consume", message: "already used" }), 409],
  ] as const)("decodes typed recipient failure %s", async (failure, status) => {
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: async () => Response.json(failure, { status }),
    });

    await expect(client.requestRecipientPortableDownload(download)).rejects.toMatchObject({
      kind: "http",
      status,
      code: failure._tag,
      message: failure.message,
    });
  });
});
