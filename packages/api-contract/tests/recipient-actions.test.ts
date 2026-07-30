import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  RecipientDesktopDeepLinkHandoffSchema,
  RecipientDesktopInstallBootstrapRequestSchema,
  RecipientDesktopInstallBootstrapResponseSchema,
  RecipientDesktopInstallPreviewRequestSchema,
  RecipientDesktopInstallPreviewResponseSchema,
  RecipientPortableDownloadRequestSchema,
  RecipientPortableDownloadResponseSchema,
  RecipientUseOnceConsumeRequestSchema,
  RecipientUseOnceConsumeResponseSchema,
  RecipientUseOnceHandoffTokenSchema,
  RecipientUseOnceIssueRequestSchema,
  RecipientUseOnceIssueResponseSchema,
  RecipientUseOncePreviewRequestSchema,
  RecipientUseOncePreviewResponseSchema,
  ShareInvitationClaimTokenSchema,
} from "../index";

const ids = {
  request: "10000000-0000-4000-8000-000000000001",
  invitation: "20000000-0000-4000-8000-000000000002",
  share: "30000000-0000-4000-8000-000000000003",
  distribution: "40000000-0000-4000-8000-000000000004",
  sealedObject: "50000000-0000-4000-8000-000000000005",
  authorization: "60000000-0000-4000-8000-000000000006",
  signalRecipient: "70000000-0000-4000-8000-000000000007",
  issue: "80000000-0000-4000-8000-000000000008",
} as const;
const hashes = {
  package: "a".repeat(64),
  terms: "b".repeat(64),
  signals: "c".repeat(64),
  lifecycle: "d".repeat(64),
} as const;
const issuedAt = "2026-07-21T12:00:00.000Z";
const expiresAt = "2026-07-21T12:05:00.000Z";
const token = "A".repeat(43);

const binding = {
  invitationId: ids.invitation,
  shareId: ids.share,
  distributionId: ids.distribution,
  sealedObjectId: ids.sealedObject,
  packagedSha256: hashes.package,
} as const;
const terms = {
  termsDisclosureSha256: hashes.terms,
  termsAcceptance: "accepted",
} as const;
const contributorSignals = {
  _tag: "capable_default_off",
  signalDisclosureSha256: hashes.signals,
  signalRecipientOrganizationId: ids.signalRecipient,
  allowedFields: ["trigger", "grade"],
  capability: "capable",
  defaultState: "off",
  contributorConsent: "not_granted",
  enabled: false,
} as const;
const lifecycleReporting = {
  _tag: "downloaded_status",
  lifecycleDisclosureSha256: hashes.lifecycle,
  consent: "not_granted",
  senderVisibleDownloadedStatus: "disabled",
} as const;
const useOnceLifecycleReporting = {
  _tag: "used_once_status",
  lifecycleDisclosureSha256: hashes.lifecycle,
  consent: "not_granted",
  senderVisibleUsedOnceStatus: "disabled",
} as const;

function succeeds(schema: Schema.Decoder<unknown, never>, value: unknown): boolean {
  return Exit.isSuccess(Schema.decodeUnknownExit(schema)(value));
}

describe("recipient action contracts", () => {
  it("models authorized portable download without implying a local install", () => {
    const request = {
      requestId: ids.request,
      ...binding,
      ...terms,
      recipientAccess: "accountless",
      contributorSignals,
      lifecycleReporting,
    };
    const response = {
      ...request,
      status: "authorized",
      downloadAuthorizationId: ids.authorization,
      accountlessPolicyResult: "public_allowed",
      packageFormat: "selftune-portable-package-v2",
      localInstall: "not_requested",
      authorizedAt: issuedAt,
      expiresAt,
    };

    expect(succeeds(RecipientPortableDownloadRequestSchema, request)).toBe(true);
    expect(succeeds(RecipientPortableDownloadResponseSchema, response)).toBe(true);
  });

  it("models a distinct opaque, single-use handoff with explicit consent and no install trust", () => {
    const issueRequest = {
      requestId: ids.request,
      ...binding,
      ...terms,
      contributorSignals,
      lifecycleReporting: useOnceLifecycleReporting,
      supportedAgent: "codex",
      executionConsent: "granted",
      recipientAccess: "accountless",
    };
    const issueResponse = {
      ...issueRequest,
      status: "issued",
      handoffToken: token,
      issueId: ids.issue,
      accountlessPolicyResult: "public_allowed",
      issuedAt,
      expiresAt,
      persistence: "ephemeral_use_once",
      persistentInstall: "not_authorized",
      trustedTelemetry: "not_authorized",
    };
    const consumeRequest = {
      requestId: ids.request,
      handoffToken: token,
      expectedIssueId: ids.issue,
      expectedInvitationId: ids.invitation,
      expectedShareId: ids.share,
      expectedDistributionId: ids.distribution,
      expectedSealedObjectId: ids.sealedObject,
      expectedPackagedSha256: hashes.package,
      supportedAgent: "codex",
      ...terms,
      contributorSignals,
      lifecycleReporting: useOnceLifecycleReporting,
      executionConsent: "granted",
    };
    const consumeResponse = {
      ...binding,
      requestId: ids.request,
      issueId: ids.issue,
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
    };

    expect(RecipientUseOnceHandoffTokenSchema).not.toBe(ShareInvitationClaimTokenSchema);
    expect(succeeds(RecipientUseOnceIssueRequestSchema, issueRequest)).toBe(true);
    expect(succeeds(RecipientUseOnceIssueResponseSchema, issueResponse)).toBe(true);
    expect(succeeds(RecipientUseOnceConsumeRequestSchema, consumeRequest)).toBe(true);
    expect(succeeds(RecipientUseOnceConsumeResponseSchema, consumeResponse)).toBe(true);
  });

  it("models a read-only helper preview from only token plus agent", () => {
    const request = { handoffToken: token, supportedAgent: "codex" };
    const response = {
      status: "preview",
      issueId: ids.issue,
      ...binding,
      supportedAgent: "codex",
      issuedAt,
      expiresAt,
      package: {
        displayName: "review-helper",
        version: "a".repeat(64),
        format: "selftune-portable-package-v2",
      },
      terms: {
        disclosureSha256: hashes.terms,
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
        signalDisclosureSha256: hashes.signals,
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
    };

    expect(succeeds(RecipientUseOncePreviewRequestSchema, request)).toBe(true);
    expect(succeeds(RecipientUseOncePreviewResponseSchema, response)).toBe(true);
    expect(succeeds(RecipientUseOncePreviewRequestSchema, { ...request, issueId: ids.issue })).toBe(
      false,
    );
    expect(
      succeeds(RecipientUseOncePreviewResponseSchema, {
        ...response,
        authorityLimits: { ...response.authorityLimits, url: "https://objects.example.test" },
      }),
    ).toBe(false);
  });

  it("models Desktop bootstrap and preview without automatic installation or custom paths", () => {
    const bootstrapRequest = {
      requestId: ids.request,
      ...binding,
      ...terms,
      contributorSignals,
    };
    const bootstrapResponse = {
      ...bootstrapRequest,
      status: "issued",
      bootstrapToken: token,
      issuedAt,
      expiresAt,
    };
    const previewRequest = { bootstrapToken: token };
    const previewResponse = {
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
    };

    expect(succeeds(RecipientDesktopInstallBootstrapRequestSchema, bootstrapRequest)).toBe(true);
    expect(succeeds(RecipientDesktopInstallBootstrapResponseSchema, bootstrapResponse)).toBe(true);
    expect(succeeds(RecipientDesktopDeepLinkHandoffSchema, previewRequest)).toBe(true);
    expect(succeeds(RecipientDesktopInstallPreviewRequestSchema, previewRequest)).toBe(true);
    expect(succeeds(RecipientDesktopInstallPreviewResponseSchema, previewResponse)).toBe(true);
  });

  it("rejects path, URL, credential, package-byte, and arbitrary metadata leakage", () => {
    const download = {
      requestId: ids.request,
      ...binding,
      ...terms,
      recipientAccess: "authenticated",
      contributorSignals,
      lifecycleReporting,
    };
    for (const forbidden of [
      { localPath: "/tmp/skill" },
      { downloadUrl: "https://objects.example.test/package" },
      { authorization: "Bearer secret" },
      { packageBytes: new Uint8Array([1, 2, 3]) },
      { metadata: { arbitrary: true } },
    ]) {
      expect(succeeds(RecipientPortableDownloadRequestSchema, { ...download, ...forbidden })).toBe(
        false,
      );
    }
    expect(
      succeeds(RecipientDesktopDeepLinkHandoffSchema, {
        bootstrapToken: token,
        distributionId: ids.distribution,
      }),
    ).toBe(false);
    expect(succeeds(RecipientUseOnceHandoffTokenSchema, `https://example.test/${token}`)).toBe(
      false,
    );
  });

  it("rejects contradictory access-policy and consent-state combinations", () => {
    const downloadResponse = {
      requestId: ids.request,
      ...binding,
      ...terms,
      contributorSignals,
      lifecycleReporting,
      recipientAccess: "accountless",
      status: "authorized",
      downloadAuthorizationId: ids.authorization,
      accountlessPolicyResult: "authenticated_account",
      packageFormat: "selftune-portable-package-v2",
      localInstall: "not_requested",
      authorizedAt: issuedAt,
      expiresAt,
    };
    expect(succeeds(RecipientPortableDownloadResponseSchema, downloadResponse)).toBe(false);
    expect(
      succeeds(RecipientPortableDownloadResponseSchema, {
        ...downloadResponse,
        accountlessPolicyResult: "public_allowed",
        contributorSignals: {
          ...contributorSignals,
          contributorConsent: "granted",
        },
      }),
    ).toBe(false);
    expect(
      succeeds(RecipientPortableDownloadResponseSchema, {
        ...downloadResponse,
        accountlessPolicyResult: "public_allowed",
        lifecycleReporting: {
          ...lifecycleReporting,
          consent: "granted",
        },
      }),
    ).toBe(false);

    const issueResponse = {
      requestId: ids.request,
      ...binding,
      ...terms,
      contributorSignals,
      lifecycleReporting: useOnceLifecycleReporting,
      supportedAgent: "codex",
      executionConsent: "granted",
      recipientAccess: "accountless",
      accountlessPolicyResult: "authenticated_account",
      status: "issued",
      issueId: ids.issue,
      handoffToken: token,
      issuedAt,
      expiresAt,
      persistence: "ephemeral_use_once",
      persistentInstall: "not_authorized",
      trustedTelemetry: "not_authorized",
    };
    expect(succeeds(RecipientUseOnceIssueResponseSchema, issueResponse)).toBe(false);

    const consumeResponse = {
      requestId: ids.request,
      issueId: ids.issue,
      supportedAgent: "codex",
      ...binding,
      ...terms,
      contributorSignals,
      lifecycleReporting: useOnceLifecycleReporting,
      executionConsent: "granted",
      recipientAccess: "authenticated",
      accountlessPolicyResult: "public_allowed",
      status: "consumed",
      consumedAt: issuedAt,
      expiresAt,
      persistence: "ephemeral_use_once",
      persistentInstall: "not_authorized",
      trustedTelemetry: "not_authorized",
    };
    expect(succeeds(RecipientUseOnceConsumeResponseSchema, consumeResponse)).toBe(false);
  });

  it("requires the full use-once issue and distribution binding even for identical bytes", () => {
    const consume = {
      requestId: ids.request,
      handoffToken: token,
      expectedIssueId: ids.issue,
      expectedInvitationId: ids.invitation,
      expectedShareId: ids.share,
      expectedDistributionId: ids.distribution,
      expectedSealedObjectId: ids.sealedObject,
      expectedPackagedSha256: hashes.package,
      supportedAgent: "codex",
      ...terms,
      contributorSignals,
      lifecycleReporting: useOnceLifecycleReporting,
      executionConsent: "granted",
    };
    const { expectedDistributionId: _omitted, ...withoutDistribution } = consume;
    expect(succeeds(RecipientUseOnceConsumeRequestSchema, withoutDistribution)).toBe(false);
    expect(
      succeeds(RecipientUseOnceConsumeRequestSchema, {
        ...consume,
        claimToken: token,
      }),
    ).toBe(false);
  });

  it("rejects lifecycle disclosures from another recipient action", () => {
    expect(
      succeeds(RecipientPortableDownloadRequestSchema, {
        requestId: ids.request,
        ...binding,
        ...terms,
        recipientAccess: "accountless",
        contributorSignals,
        lifecycleReporting: useOnceLifecycleReporting,
      }),
    ).toBe(false);
    expect(
      succeeds(RecipientUseOnceIssueRequestSchema, {
        requestId: ids.request,
        ...binding,
        ...terms,
        contributorSignals,
        lifecycleReporting,
        supportedAgent: "codex",
        executionConsent: "granted",
        recipientAccess: "accountless",
      }),
    ).toBe(false);
    expect(
      succeeds(RecipientDesktopInstallBootstrapRequestSchema, {
        requestId: ids.request,
        ...binding,
        ...terms,
        contributorSignals,
        lifecycleReporting,
      }),
    ).toBe(false);
  });

  it("rejects noncanonical identities, hashes, timestamps, enums, and unsupported custom paths", () => {
    expect(
      succeeds(RecipientPortableDownloadRequestSchema, {
        requestId: "not-a-uuid",
        ...binding,
        ...terms,
        recipientAccess: "public-ish",
        contributorSignals,
        lifecycleReporting,
      }),
    ).toBe(false);
    expect(
      succeeds(RecipientDesktopInstallPreviewResponseSchema, {
        ...binding,
        ...terms,
        contributorSignals,
        status: "preview",
        expiresAt: "2026-07-21",
        supportedTargetAgents: ["unknown_agent"],
        targetAgentSelectionRequired: true,
        scopeChoices: ["project", "global"],
        scopeSelectionRequired: true,
        installModeDefault: "symlink",
        conflictPolicyChoices: ["prompt", "replace", "keep_both"],
        conflictPolicyDefault: "prompt",
        customPathPolicy: "/custom/path",
        automaticDesktopInstall: "not_authorized",
        automaticSkillInstall: "not_authorized",
      }),
    ).toBe(false);
  });
});
