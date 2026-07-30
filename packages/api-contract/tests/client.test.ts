import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ApiClientError,
  CloudBootstrapSchema,
  SelfTuneCloudApi,
  ShareInvitationAcceptance,
  ShareInvitationClaim,
  ShareInvitationPreview,
  ShareInvitationPreviewRequest,
  createCloudApiClient,
  decodeUnknown,
  type CloudBootstrap,
} from "../index";

const bootstrapFixture: CloudBootstrap = {
  viewer: {
    id: "user-1",
    email: "person@example.com",
    name: "Person",
    avatarUrl: null,
  },
  memberships: [
    {
      orgId: "org-1",
      orgName: "Acme",
      orgSlug: "acme",
      role: "owner",
      plan: "team",
    },
  ],
  activeWorkspace: { id: "org-1", name: "Acme", slug: "acme" },
  plan: "team",
  onboardingState: "inventory_seeded",
};

function jsonFetch(
  respond: (request: Request) => Response | Promise<Response>,
  requests: Request[] = [],
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  };
}

describe("Effect cloud contract", () => {
  it("uses Effect Schema as the wire authority", () => {
    expect(Schema.decodeUnknownSync(CloudBootstrapSchema)(bootstrapFixture)).toEqual(
      bootstrapFixture,
    );

    const result = decodeUnknown(CloudBootstrapSchema, {
      ...bootstrapFixture,
      memberships: [{ ...bootstrapFixture.memberships[0], role: "superuser" }],
    });
    expect(result.success).toBe(false);
  });

  it("publishes the canonical API as an Effect HttpApi", () => {
    expect(SelfTuneCloudApi.groups).toHaveProperty("cloud");
    expect(SelfTuneCloudApi.groups).toHaveProperty("shareInvitations");
  });
});

describe("createCloudApiClient", () => {
  it("uses the generated HttpApi client with auth and organization context", async () => {
    const requests: Request[] = [];
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev/",
      getAccessToken: async () => "jwt-token",
      getActiveOrganizationId: () => "org-1",
      fetch: jsonFetch(() => Response.json(bootstrapFixture), requests),
    });

    await expect(client.bootstrap()).resolves.toEqual(bootstrapFixture);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://cloud.selftune.dev/api/v1/cloud/bootstrap");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.credentials).toBe("include");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer jwt-token");
    expect(requests[0]?.headers.get("x-selftune-active-org-id")).toBe("org-1");
  });

  it("exposes the canonical Cloud Library and Skill Set operations", async () => {
    const requests: Request[] = [];
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: jsonFetch((request) => {
        if (request.url.endsWith("/device-code")) {
          return Response.json({ status: "approved" });
        }
        if (request.method === "DELETE") return Response.json({ deleted: true });
        if (request.url.includes("/export")) {
          return Response.json({
            filename: "set.json",
            contentType: "application/json",
            content: "{}",
          });
        }
        if (request.url.endsWith("/library")) {
          return Response.json({ skills: [], categoryOptions: [] });
        }
        if (request.method === "GET") {
          return Response.json({
            skillSets: [],
            availableSkills: [],
            receipts: [],
          });
        }
        return Response.json(
          {
            id: "engineering",
            name: "Engineering",
            description: "",
            connections: ["codex"],
            skills: [],
            revision: 1,
            revisionHash: "hash",
            updatedAt: "2026-07-19T00:00:00.000Z",
          },
          { status: request.method === "POST" ? 201 : 200 },
        );
      }, requests),
    });

    await client.library();
    await client.skillSets();
    await client.createSkillSet({
      name: "Engineering",
      description: "",
      connections: ["codex"],
      skills: [{ name: "tdd", packagePath: "cloud://tdd" }],
    });
    await client.updateSkillSet({
      id: "engineering",
      parentRevisionHash: "hash",
      name: "Engineering",
      description: "",
      connections: ["codex"],
      skills: [{ name: "tdd", packagePath: "cloud://tdd" }],
    });
    await client.deleteSkillSet("engineering");
    await client.exportSkillSet("engineering");
    await client.materializeSkillSetExport("engineering");
    await client.decideDeviceCode({ userCode: "ABCD-1234", action: "approve" });

    expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      "GET /api/v1/cloud/library",
      "GET /api/v1/cloud/skill-sets",
      "POST /api/v1/cloud/skill-sets",
      "PATCH /api/v1/cloud/skill-sets/engineering",
      "DELETE /api/v1/cloud/skill-sets/engineering",
      "GET /api/v1/cloud/skill-sets/engineering/export",
      "POST /api/v1/cloud/skill-sets/engineering/export/materialize",
      "POST /api/v1/cloud/device-code",
    ]);
    await expect(requests[2]?.json()).resolves.toEqual({
      name: "Engineering",
      description: "",
      connections: ["codex"],
      skills: [{ name: "tdd", packagePath: "cloud://tdd" }],
    });
  });

  it("decodes typed HttpApi failures", async () => {
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: jsonFetch(() =>
        Response.json(
          {
            _tag: "CloudForbidden",
            code: "workspace_forbidden",
            message: "You cannot access this workspace.",
          },
          { status: 403 },
        ),
      ),
    });

    await expect(client.bootstrap()).rejects.toMatchObject({
      name: "ApiClientError",
      kind: "http",
      status: 403,
      code: "workspace_forbidden",
      message: "You cannot access this workspace.",
    });
  });

  it("preserves the materialization action conflict as a typed client error", async () => {
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: jsonFetch(() =>
        Response.json(
          {
            _tag: "CloudConflict",
            code: "cloud_skill_set_export_materialization_conflict",
            message: "Another authorized actor owns the active lease.",
          },
          { status: 409 },
        ),
      ),
    });

    await expect(client.materializeSkillSetExport("engineering")).rejects.toMatchObject({
      name: "ApiClientError",
      kind: "http",
      status: 409,
      code: "cloud_skill_set_export_materialization_conflict",
    });
  });

  it("preserves a retriable export failure as a typed service-unavailable error", async () => {
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: jsonFetch(() =>
        Response.json(
          {
            _tag: "CloudServiceUnavailable",
            code: "cloud_skill_set_export_unavailable",
            message: "The materialized export is temporarily unavailable.",
          },
          { status: 503 },
        ),
      ),
    });

    await expect(client.exportSkillSet("engineering")).rejects.toMatchObject({
      name: "ApiClientError",
      kind: "http",
      status: 503,
      code: "cloud_skill_set_export_unavailable",
    });
  });

  it("exposes preview, claim, recipient view, and exact acceptance through the generated client", async () => {
    const requests: Request[] = [];
    const recipientAuthority = {
      actionBindings: {
        invitationId: "11111111-1111-4111-8111-111111111111",
        distributionId: "22222222-2222-4222-8222-222222222222",
        shareId: "44444444-4444-4444-8444-444444444444",
        sealedObjectId: "55555555-5555-4555-8555-555555555555",
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
    const preview = Schema.decodeUnknownSync(ShareInvitationPreview)({
      invitationId: "11111111-1111-4111-8111-111111111111",
      distributionId: "22222222-2222-4222-8222-222222222222",
      status: "available",
      expiresAt: "2026-07-22T00:00:00.000Z",
      ...recipientAuthority,
      disclosure: {
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
      },
    });
    const claim = Schema.decodeUnknownSync(ShareInvitationClaim)({
      claimToken: "A".repeat(43),
      claimedOrganizationId: "33333333-3333-4333-8333-333333333333",
    });
    const acceptance = Schema.decodeUnknownSync(ShareInvitationAcceptance)({
      disclosureSha256: "e".repeat(64),
    });
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: jsonFetch((request) => {
        if (request.url.endsWith("/preview")) return Response.json(preview);
        if (request.url.endsWith("/claim")) {
          return Response.json({
            invitationId: preview.invitationId,
            distributionId: preview.distributionId,
            status: "claimed",
            licenseAcceptanceRequired: true,
            licenseAcceptanceSatisfied: false,
            importStatus: "not_imported",
          });
        }
        if (request.url.endsWith("/license-acceptance")) {
          return Response.json({
            invitationId: preview.invitationId,
            distributionId: preview.distributionId,
            status: "accepted",
            acceptanceReference: "skill-share-license-acceptance-v1:" + acceptance.disclosureSha256,
            acceptedAt: "2026-07-21T12:01:00.000Z",
            disclosure: preview.disclosure,
            importStatus: "not_imported",
          });
        }
        return Response.json({
          invitationId: preview.invitationId,
          distributionId: preview.distributionId,
          status: "claimed",
          expiresAt: preview.expiresAt,
          claimedAt: "2026-07-21T12:00:00.000Z",
          disclosure: preview.disclosure,
          actionBindings: preview.actionBindings,
          packageInspection: preview.packageInspection,
          licenseAcceptance: {
            required: true,
            satisfied: false,
            reference: null,
            acceptedAt: null,
          },
          importStatus: "not_imported",
        });
      }, requests),
    });
    const previewInput = Schema.decodeUnknownSync(ShareInvitationPreviewRequest)({
      claimToken: "A".repeat(43),
    });

    await client.previewShareInvitation(previewInput.claimToken);
    await client.claimShareInvitation(claim);
    await client.getShareInvitation(preview.invitationId);
    await client.acceptShareInvitationLicense(preview.invitationId, acceptance);

    expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      "POST /api/v1/public/share-invitations/preview",
      "POST /api/v1/share-invitations/claim",
      `GET /api/v1/share-invitations/${preview.invitationId}`,
      `POST /api/v1/share-invitations/${preview.invitationId}/license-acceptance`,
    ]);
  });

  it("distinguishes invalid successful payloads from transport failures", async () => {
    const invalid = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: jsonFetch(() => Response.json({ viewer: null })),
    });
    await expect(invalid.bootstrap()).rejects.toBeInstanceOf(ApiClientError);
    await expect(invalid.bootstrap()).rejects.toMatchObject({
      kind: "invalid_response",
      code: "invalid_response_payload",
    });

    const offline = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: async () => {
        throw new Error("socket closed");
      },
    });
    await expect(offline.bootstrap()).rejects.toMatchObject({
      kind: "network",
      status: null,
      message: "Unable to reach the selftune API.",
    });
  });
});
