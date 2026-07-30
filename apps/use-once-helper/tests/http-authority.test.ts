import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { encodePortablePackageBundleSync } from "@selftune/control-plane/domain";

import type {
  PinnedUseOnceAuthorityClientOptions,
  UseOnceConsumption,
  UseOncePreview,
} from "../src";
import {
  makePinnedUseOnceAuthorityClient,
  PINNED_USE_ONCE_AUTHORITY_ORIGIN,
  USE_ONCE_AUTHORITY_PATHS,
} from "../src";

const TOKEN = "u".repeat(43);
const NOW = new Date("2026-07-21T00:00:00.000Z");
const REQUEST_ID = "10000000-0000-4000-8000-000000000006";

function fixture() {
  const bytes = encodePortablePackageBundleSync({
    files: [{ path: "SKILL.md", content: new TextEncoder().encode("# Shared skill\n") }],
  });
  const packagedSha256 = createHash("sha256").update(bytes).digest("hex");
  const preview: UseOncePreview = {
    issueId: "10000000-0000-4000-8000-000000000001",
    invitationId: "10000000-0000-4000-8000-000000000002",
    shareId: "10000000-0000-4000-8000-000000000003",
    distributionId: "10000000-0000-4000-8000-000000000004",
    sealedObjectId: "10000000-0000-4000-8000-000000000005",
    packagedSha256,
    status: "preview",
    supportedAgent: "codex",
    issuedAt: "2026-07-21T00:00:00.000Z",
    expiresAt: "2026-07-21T01:00:00.000Z",
    publisher: { name: "Example Publisher" },
    rightsHolder: { kind: "organization", name: "Example Publisher" },
    package: {
      displayName: "Example skill",
      version: "1.2.3",
      format: "selftune-portable-package-v2",
    },
    license: {
      expression: "MIT",
      kind: "spdx",
      licenseEvidenceSha256: "c".repeat(64),
      bundledTerms: null,
    },
    provenance: {
      kind: "github_verified",
      sourceRepository: "https://github.com/example/skill",
      sourceRef: "refs/tags/v1.2.3",
      sourceTreeHash: "e".repeat(64),
    },
    terms: {
      disclosureSha256: "a".repeat(64),
      summary: "MIT licensed skill.",
      issueAcceptance: "accepted_at_issue",
    },
    contributorSignals: {
      _tag: "signals_unavailable",
      signalDisclosureSha256: "f".repeat(64),
      signalRecipientOrganizationId: null,
      allowedFields: [],
      capability: "not_capable",
      defaultState: "off",
      contributorConsent: "not_applicable",
      enabled: false,
    },
    lifecycleReporting: {
      _tag: "used_once_status",
      lifecycleDisclosureSha256: "b".repeat(64),
      consent: "not_granted",
      senderVisibleUsedOnceStatus: "disabled",
    },
    helperContributorSignals: {
      _tag: "unavailable",
      signalDisclosureSha256: "f".repeat(64),
      allowedFields: [],
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
  const consumption: UseOnceConsumption = {
    issueId: preview.issueId,
    invitationId: preview.invitationId,
    shareId: preview.shareId,
    distributionId: preview.distributionId,
    sealedObjectId: preview.sealedObjectId,
    packagedSha256,
    requestId: REQUEST_ID,
    supportedAgent: "codex",
    termsDisclosureSha256: preview.terms.disclosureSha256,
    termsAcceptance: "accepted",
    executionConsent: "granted",
    status: "consumed",
    consumedAt: "2026-07-21T00:00:01.000Z",
    expiresAt: "2026-07-21T00:05:00.000Z",
    persistence: "ephemeral_use_once",
    persistentInstall: "not_authorized",
    trustedTelemetry: "not_authorized",
    lifecycleReporting: preview.lifecycleReporting,
    contributorSignals: preview.contributorSignals,
    recipientAccess: "accountless",
    accountlessPolicyResult: "public_allowed",
  };
  return { bytes, preview, consumption };
}

function contentResponse(
  bytes: Uint8Array,
  preview: UseOncePreview,
  overrides: Record<string, string> = {},
): Response {
  return new Response(Uint8Array.from(bytes).buffer, {
    status: 200,
    headers: {
      "cache-control": "no-store, private",
      pragma: "no-cache",
      "content-type": "application/vnd.selftune.portable-package+json",
      "content-length": String(bytes.byteLength),
      etag: `"${preview.packagedSha256}"`,
      "x-selftune-content-sha256": preview.packagedSha256,
      "x-selftune-use-once-issue-id": preview.issueId,
      "x-selftune-invitation-id": preview.invitationId,
      "x-selftune-share-id": preview.shareId,
      "x-selftune-distribution-id": preview.distributionId,
      "x-selftune-sealed-object-id": preview.sealedObjectId,
      "x-selftune-supported-agent": preview.supportedAgent,
      ...overrides,
    },
  });
}

function client(fetch: NonNullable<PinnedUseOnceAuthorityClientOptions["fetch"]>) {
  return makePinnedUseOnceAuthorityClient({
    fetch,
    now: () => NOW,
    requestId: () => REQUEST_ID,
    timeoutMilliseconds: 1_000,
  });
}

describe("pinned HTTPS use-once authority", () => {
  test("uses only fixed requests and exact preview-derived consume fields", async () => {
    const { bytes, preview, consumption } = fixture();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      Response.json(preview),
      contentResponse(bytes, preview),
      Response.json(consumption),
    ];
    const authority = client(async (input, init = {}) => {
      requests.push({ url: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    const actualPreview = await authority.preview({
      handoffToken: TOKEN,
      supportedAgent: "codex",
    });
    await authority.retrievePreviewObject({ handoffToken: TOKEN, preview: actualPreview });
    await authority.consume({
      handoffToken: TOKEN,
      preview: actualPreview,
      confirmation: {
        termsDisclosureSha256: actualPreview.terms.disclosureSha256,
        termsAcceptance: "accepted",
        executionConsent: "granted",
      },
    });

    expect(requests.map(({ url }) => url)).toEqual([
      `${PINNED_USE_ONCE_AUTHORITY_ORIGIN}${USE_ONCE_AUTHORITY_PATHS.preview}`,
      `${PINNED_USE_ONCE_AUTHORITY_ORIGIN}${USE_ONCE_AUTHORITY_PATHS.content(preview.issueId)}?supportedAgent=codex`,
      `${PINNED_USE_ONCE_AUTHORITY_ORIGIN}${USE_ONCE_AUTHORITY_PATHS.consume}`,
    ]);
    for (const { init } of requests) {
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(init.cache).toBe("no-store");
      const headers = new Headers(init.headers);
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("x-selftune-org-id")).toBe(false);
    }
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      handoffToken: TOKEN,
      supportedAgent: "codex",
    });
    expect(new Headers(requests[1]?.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(requests[2]?.init.body))).toEqual({
      requestId: REQUEST_ID,
      handoffToken: TOKEN,
      expectedIssueId: preview.issueId,
      expectedInvitationId: preview.invitationId,
      expectedShareId: preview.shareId,
      expectedDistributionId: preview.distributionId,
      expectedSealedObjectId: preview.sealedObjectId,
      expectedPackagedSha256: preview.packagedSha256,
      supportedAgent: "codex",
      termsDisclosureSha256: preview.terms.disclosureSha256,
      termsAcceptance: "accepted",
      contributorSignals: preview.contributorSignals,
      lifecycleReporting: preview.lifecycleReporting,
      executionConsent: "granted",
    });
  });

  test("rejects a followed redirect even when it looks successful", async () => {
    const { preview } = fixture();
    const redirected = Response.json(preview);
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(
      client(async () => redirected).preview({ handoffToken: TOKEN, supportedAgent: "codex" }),
    ).rejects.toMatchObject({ code: "AUTHORITY_REQUEST_FAILED" });
  });

  test("rejects every content binding header drift", async () => {
    const { bytes, preview } = fixture();
    const drifts = [
      "x-selftune-content-sha256",
      "x-selftune-use-once-issue-id",
      "x-selftune-invitation-id",
      "x-selftune-share-id",
      "x-selftune-distribution-id",
      "x-selftune-sealed-object-id",
      "x-selftune-supported-agent",
      "etag",
    ];
    await Promise.all(
      drifts.map(async (header) => {
        const authority = client(async () =>
          contentResponse(bytes, preview, { [header]: "drift" }),
        );
        await expect(
          authority.retrievePreviewObject({ handoffToken: TOKEN, preview }),
        ).rejects.toMatchObject({ code: "INVALID_AUTHORITY_RESPONSE" });
      }),
    );
  });

  test("rejects wrong media, declared length, body hash, and status", async () => {
    const { bytes, preview } = fixture();
    const cases = [
      contentResponse(bytes, preview, { "content-type": "application/octet-stream" }),
      contentResponse(bytes, preview, { "content-length": String(bytes.byteLength + 1) }),
      contentResponse(new TextEncoder().encode("tampered"), preview),
      new Response("unavailable", { status: 503 }),
    ];
    await Promise.all(
      cases.map(async (response) => {
        await expect(
          client(async () => response).retrievePreviewObject({ handoffToken: TOKEN, preview }),
        ).rejects.toBeInstanceOf(Error);
      }),
    );
  });

  test("maps a one-winner replay without retrying", async () => {
    const { preview } = fixture();
    let calls = 0;
    const authority = client(async () => {
      calls += 1;
      return Response.json({ _tag: "RecipientActionReplay" }, { status: 409 });
    });
    await expect(
      authority.consume({
        handoffToken: TOKEN,
        preview,
        confirmation: {
          termsDisclosureSha256: preview.terms.disclosureSha256,
          termsAcceptance: "accepted",
          executionConsent: "granted",
        },
      }),
    ).rejects.toMatchObject({ code: "AUTHORITY_REPLAY" });
    expect(calls).toBe(1);
  });

  test("propagates caller abort to the in-flight request", async () => {
    const controller = new AbortController();
    const authority = client(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const request = authority.preview({
      handoffToken: TOKEN,
      supportedAgent: "codex",
      signal: controller.signal,
    });
    controller.abort(new DOMException("stopped", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
