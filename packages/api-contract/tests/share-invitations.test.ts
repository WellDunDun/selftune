import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ShareInvitationAcceptance,
  ShareInvitationAcceptanceResult,
  ShareInvitationClaim,
  ShareInvitationClaimResult,
  ShareInvitationDisclosure,
  ShareInvitationIssue,
  ShareInvitationPreview,
  ShareInvitationRecipientView,
  ShareInvitationSenderView,
  ShareInvitationUnavailable,
  decodeShareInvitationClaim,
} from "../index";

const ids = {
  invitation: "550e8400-e29b-41d4-a716-446655440010",
  distribution: "550e8400-e29b-41d4-a716-446655440011",
};
const expiresAt = "2026-07-22T00:00:00.000Z";
const recipientAuthority = {
  actionBindings: {
    invitationId: ids.invitation,
    distributionId: ids.distribution,
    shareId: "550e8400-e29b-41d4-a716-446655440013",
    sealedObjectId: "550e8400-e29b-41d4-a716-446655440014",
    packagedSha256: "b".repeat(64),
  },
  packageInspection: {
    fileManifest: [{ path: "SKILL.md", sha256: "3".repeat(64), byteLength: 12 }],
    fileManifestSha256: "4".repeat(64),
    securityDecision: {
      _tag: "authorized_sealed",
      policyVersion: "recipient-sealed-package-inspection-v1",
      transform: { name: "selftune-portable-package", version: "1" },
      packagedSha256: "b".repeat(64),
    },
  },
} as const;
const disclosureInput = {
  publisher: { name: "Acme Skills" },
  rightsHolder: { kind: "external", name: "Example Author" },
  artifact: {
    subjectKind: "skill_revision",
    subjectId: "review-helper",
    sourceRevisionHash: "a".repeat(64),
    packagedSha256: "b".repeat(64),
  },
  license: {
    expression: "Proprietary",
    kind: "proprietary",
    licenseEvidenceSha256: "c".repeat(64),
    bundledTerms: { path: "LICENSE.txt", sha256: "d".repeat(64) },
  },
  provenance: {
    kind: "self_attested_upload",
    sourceRepository: null,
    sourceRef: null,
    sourceTreeHash: null,
  },
  contributorSignals: {
    status: "disabled",
    enabled: false,
    includedInPackage: false,
    activeCapability: false,
    capabilityVersion: null,
    signalSchema: null,
    allowedSignals: [],
  },
  recipientActions: {
    accountlessEligibility: "account_required",
    contributorSignals: {
      _tag: "signals_unavailable",
      signalDisclosureSha256: "f".repeat(64),
      signalRecipientOrganizationId: null,
      allowedFields: [],
      capability: "not_capable",
      defaultState: "off",
    },
    portableDownloadLifecycle: {
      _tag: "downloaded_status",
      lifecycleDisclosureSha256: "1".repeat(64),
      defaultConsent: "not_granted",
      senderVisibleDownloadedStatus: "disabled",
    },
    useOnceLifecycle: {
      _tag: "used_once_status",
      lifecycleDisclosureSha256: "2".repeat(64),
      defaultConsent: "not_granted",
      senderVisibleUsedOnceStatus: "disabled",
    },
  },
  acceptance: {
    required: true,
    policyVersion: "skill-share-license-acceptance-v1",
    disclosureSha256: "e".repeat(64),
  },
} as const;

describe("share invitation contract", () => {
  it("keeps recipient email and claim tokens confined to write inputs", () => {
    const issue = Schema.decodeUnknownSync(ShareInvitationIssue)({
      distributionId: ids.distribution,
      recipientEmail: "recipient@example.com",
      expiresAt,
    });
    const claim = Schema.decodeUnknownSync(ShareInvitationClaim)({
      claimToken: "A".repeat(43),
      claimedOrganizationId: "550e8400-e29b-41d4-a716-446655440012",
    });

    expect(issue.recipientEmail).toBe("recipient@example.com");
    expect(claim.claimToken).toHaveLength(43);
    for (const response of [
      Schema.decodeUnknownSync(ShareInvitationSenderView)({
        invitationId: ids.invitation,
        distributionId: ids.distribution,
        status: "pending",
        expiresAt,
        licenseAcceptanceRequired: true,
      }),
      Schema.decodeUnknownSync(ShareInvitationPreview)({
        invitationId: ids.invitation,
        distributionId: ids.distribution,
        status: "available",
        expiresAt,
        disclosure: disclosureInput,
        ...recipientAuthority,
      }),
      Schema.decodeUnknownSync(ShareInvitationClaimResult)({
        invitationId: ids.invitation,
        distributionId: ids.distribution,
        status: "claimed",
        licenseAcceptanceRequired: true,
        licenseAcceptanceSatisfied: false,
        importStatus: "not_imported",
      }),
    ]) {
      expect(JSON.stringify(response)).not.toContain("recipient@example.com");
      expect(JSON.stringify(response)).not.toContain("claimToken");
      expect(JSON.stringify(response)).not.toContain("claimedOrganizationId");
      expect(JSON.stringify(response)).not.toContain("claimedUserId");
    }
  });

  it("rejects malformed or excess claim input at the security boundary", async () => {
    await expect(
      Effect.runPromise(
        decodeShareInvitationClaim({
          claimToken: "short",
          claimedOrganizationId: ids.invitation,
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        decodeShareInvitationClaim({
          claimToken: "A".repeat(43),
          claimedOrganizationId: ids.invitation,
          recipientEmail: "leak@example.com",
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("uses one enumeration-safe claim failure without recipient details", () => {
    const error = ShareInvitationUnavailable.make({
      message: "This invitation is unavailable.",
    });
    expect(error._tag).toBe("ShareInvitationUnavailable");
    expect(JSON.stringify(error)).not.toContain(ids.invitation);
    expect(JSON.stringify(error)).not.toContain("email");
  });

  it("binds preview and acceptance to the exact public-safe distribution disclosure", () => {
    const disclosure = Schema.decodeUnknownSync(ShareInvitationDisclosure)(disclosureInput);
    const preview = Schema.decodeUnknownSync(ShareInvitationPreview)({
      invitationId: ids.invitation,
      distributionId: ids.distribution,
      status: "available",
      expiresAt,
      disclosure,
      ...recipientAuthority,
    });
    const command = Schema.decodeUnknownSync(ShareInvitationAcceptance)({
      disclosureSha256: disclosure.acceptance.disclosureSha256,
    });
    const acceptedAt = "2026-07-21T18:00:00.000Z";
    const acceptance = Schema.decodeUnknownSync(ShareInvitationAcceptanceResult)({
      invitationId: ids.invitation,
      distributionId: ids.distribution,
      status: "accepted",
      acceptanceReference:
        "skill-share-license-acceptance-v1:" + disclosure.acceptance.disclosureSha256,
      acceptedAt,
      disclosure,
      importStatus: "not_imported",
    });

    expect(preview.disclosure).toEqual(disclosure);
    expect(command.disclosureSha256).toBe(disclosure.acceptance.disclosureSha256);
    expect(acceptance.acceptanceReference).toContain(disclosure.acceptance.disclosureSha256);
    expect(JSON.stringify([preview, acceptance])).not.toContain("recipientEmail");
    expect(JSON.stringify([preview, acceptance])).not.toContain("claimedUserId");
    expect(JSON.stringify([preview, acceptance])).not.toContain("objectUrl");
    expect(JSON.stringify([preview, acceptance])).not.toContain("install");
  });

  it.each([null, "12", 12.5, 1e-1, true, undefined])(
    "rejects malformed package byteLength value %s at the wire boundary",
    (byteLength) => {
      const file = {
        path: "SKILL.md",
        sha256: "3".repeat(64),
        ...(byteLength === undefined ? {} : { byteLength }),
      };
      expect(() =>
        Schema.decodeUnknownSync(ShareInvitationPreview)({
          invitationId: ids.invitation,
          distributionId: ids.distribution,
          status: "available",
          expiresAt,
          disclosure: disclosureInput,
          ...recipientAuthority,
          packageInspection: {
            ...recipientAuthority.packageInspection,
            fileManifest: [file],
          },
        }),
      ).toThrow();
    },
  );

  it("rejects Skill Set disclosure until a complete component license BOM is supported", () => {
    expect(() =>
      Schema.decodeUnknownSync(ShareInvitationDisclosure)({
        ...disclosureInput,
        artifact: { ...disclosureInput.artifact, subjectKind: "skill_set" },
      }),
    ).toThrow();
  });

  it("keeps authenticated recipient view separate from claim, acceptance, and import", () => {
    const view = Schema.decodeUnknownSync(ShareInvitationRecipientView)({
      invitationId: ids.invitation,
      distributionId: ids.distribution,
      status: "claimed",
      expiresAt,
      claimedAt: "2026-07-21T17:00:00.000Z",
      ...recipientAuthority,
      disclosure: {
        publisher: { name: "Acme Skills" },
        rightsHolder: { kind: "organization", name: "Acme Skills" },
        artifact: {
          subjectKind: "skill_revision",
          subjectId: "review-helper",
          sourceRevisionHash: "a".repeat(64),
          packagedSha256: "b".repeat(64),
        },
        license: {
          expression: "MIT",
          kind: "spdx",
          licenseEvidenceSha256: "c".repeat(64),
          bundledTerms: null,
        },
        provenance: {
          kind: "github_verified",
          sourceRepository: "https://github.com/acme/review-helper",
          sourceRef: "v1.0.0",
          sourceTreeHash: "f".repeat(40),
        },
        contributorSignals: {
          status: "enabled",
          enabled: true,
          includedInPackage: true,
          activeCapability: true,
          capabilityVersion: "1",
          signalSchema: "selftune.signal.v1",
          allowedSignals: ["trigger"],
        },
        recipientActions: {
          accountlessEligibility: "public_allowed",
          contributorSignals: {
            _tag: "capable_default_off",
            signalDisclosureSha256: "9".repeat(64),
            signalRecipientOrganizationId: "550e8400-e29b-41d4-a716-446655440099",
            allowedFields: ["trigger"],
            capability: "capable",
            defaultState: "off",
          },
          portableDownloadLifecycle: {
            _tag: "downloaded_status",
            lifecycleDisclosureSha256: "1".repeat(64),
            defaultConsent: "not_granted",
            senderVisibleDownloadedStatus: "disabled",
          },
          useOnceLifecycle: {
            _tag: "used_once_status",
            lifecycleDisclosureSha256: "2".repeat(64),
            defaultConsent: "not_granted",
            senderVisibleUsedOnceStatus: "disabled",
          },
        },
        acceptance: {
          required: false,
          policyVersion: "skill-share-license-acceptance-v1",
          disclosureSha256: "e".repeat(64),
        },
      },
      licenseAcceptance: {
        required: false,
        satisfied: true,
        reference: null,
        acceptedAt: null,
      },
      importStatus: "not_imported",
    });

    expect(view.status).toBe("claimed");
    expect(view.importStatus).toBe("not_imported");
    expect(JSON.stringify(view)).not.toContain("claimedUserId");
    expect(JSON.stringify(view)).not.toContain("claimedOrganizationId");
  });
});
