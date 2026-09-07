import { createHash } from "node:crypto";
import type { Json } from "effect/Schema";

import { describe, expect, test } from "bun:test";
import {
  DISTRIBUTION_PACKAGE_BUNDLE_PROFILE,
  encodePortablePackageBundleSync,
} from "@selftune/control-plane/domain";

import type {
  AgentExecutionPort,
  DisclosurePort,
  StagedUseOnceWorkspace,
  UseOnceBinding,
  UseOnceConsumption,
  UseOncePreview,
  UseOnceWorkspacePort,
} from "../src";
import {
  MAXIMUM_HELPER_PACKAGE_BYTES,
  makePinnedUseOnceAuthorityClient,
  runUseOnce,
  USE_ONCE_AUTHORITY_PATHS,
  UseOnceHelperError,
} from "../src";

const TOKEN = "u".repeat(43);
const NOW = new Date("2026-07-21T00:00:00.000Z");

const ids = {
  issueId: "10000000-0000-4000-8000-000000000001",
  invitationId: "10000000-0000-4000-8000-000000000002",
  shareId: "10000000-0000-4000-8000-000000000003",
  distributionId: "10000000-0000-4000-8000-000000000004",
  sealedObjectId: "10000000-0000-4000-8000-000000000005",
};

function fixture() {
  const licenseBytes = new TextEncoder().encode("MIT License\n");
  const bytes = encodePortablePackageBundleSync({
    files: [
      { path: "SKILL.md", content: new TextEncoder().encode("# Shared skill\n") },
      { path: "LICENSE", content: licenseBytes },
    ],
  });
  const packagedSha256 = createHash("sha256").update(bytes).digest("hex");
  const binding: UseOnceBinding = { ...ids, packagedSha256 };
  const preview: UseOncePreview = {
    ...binding,
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
      bundledTerms: {
        path: "LICENSE",
        sha256: createHash("sha256").update(licenseBytes).digest("hex"),
      },
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
    ...binding,
    requestId: "10000000-0000-4000-8000-000000000006",
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
  return { bytes, binding, preview, consumption };
}

function harness(overrides?: {
  readonly preview?: Json;
  readonly consumption?: Json;
  readonly contentType?: string;
  readonly bytes?: Uint8Array;
  readonly confirmation?: null | "accepted";
  readonly execute?: AgentExecutionPort["execute"];
}) {
  const data = fixture();
  const events: string[] = [];
  let inspectedPreview = data.preview;
  const authority = makePinnedUseOnceAuthorityClient({
    now: () => NOW,
    requestId: () => data.consumption.requestId,
    async fetch(input) {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (pathname === USE_ONCE_AUTHORITY_PATHS.preview) {
        events.push("preview");
        return Response.json(overrides?.preview ?? data.preview);
      }
      if (pathname === USE_ONCE_AUTHORITY_PATHS.consume) {
        events.push("consume");
        return Response.json(overrides?.consumption ?? data.consumption);
      }
      if (pathname !== USE_ONCE_AUTHORITY_PATHS.content(inspectedPreview.issueId)) {
        throw new Error(`Unexpected authority request: ${pathname}`);
      }
      events.push("retrieve");
      const bytes = overrides?.bytes ?? data.bytes;
      return new Response(Uint8Array.from(bytes).buffer, {
        headers: {
          "cache-control": "no-store, private",
          pragma: "no-cache",
          "content-type":
            overrides?.contentType ?? "application/vnd.selftune.portable-package+json",
          "content-length": String(bytes.byteLength),
          etag: `"${inspectedPreview.packagedSha256}"`,
          "x-selftune-content-sha256": inspectedPreview.packagedSha256,
          "x-selftune-use-once-issue-id": inspectedPreview.issueId,
          "x-selftune-invitation-id": inspectedPreview.invitationId,
          "x-selftune-share-id": inspectedPreview.shareId,
          "x-selftune-distribution-id": inspectedPreview.distributionId,
          "x-selftune-sealed-object-id": inspectedPreview.sealedObjectId,
          "x-selftune-supported-agent": inspectedPreview.supportedAgent,
        },
      });
    },
  });
  const requestPreview = authority.preview.bind(authority);
  authority.preview = async (input) => {
    inspectedPreview = await requestPreview(input);
    return inspectedPreview;
  };
  const disclosure: DisclosurePort = {
    async show({ preview, bundledTerms }) {
      events.push(`show:${preview.publisher.name}:${preview.license.expression}`);
      events.push(`terms:${bundledTerms?.sha256 ?? "none"}`);
    },
    async confirm({ preview }) {
      events.push("confirm");
      return overrides?.confirmation === null
        ? null
        : {
            termsDisclosureSha256: preview.terms.disclosureSha256,
            termsAcceptance: "accepted",
            executionConsent: "granted",
          };
    },
  };
  const staged: StagedUseOnceWorkspace = {
    rootDirectory: "/tmp/owned",
    skillDirectory: "/tmp/owned/skill",
    async cleanup() {
      events.push("cleanup");
    },
  };
  const workspace: UseOnceWorkspacePort = {
    async recoverStale() {
      events.push("recover");
    },
    async stage(input) {
      events.push(`stage:${input.files.map((file) => file.path).join(",")}`);
      return staged;
    },
  };
  const agentExecution: AgentExecutionPort = {
    execute:
      overrides?.execute ??
      (async (invocation) => {
        events.push(`execute:${invocation.executable}`);
        return 0;
      }),
  };
  return { data, events, authority, disclosure, workspace, agentExecution };
}

describe("use-once workflow", () => {
  test("shares the canonical 25 MiB encoded-package ceiling", () => {
    expect(MAXIMUM_HELPER_PACKAGE_BYTES).toBe(25 * 1024 * 1024);
    expect(MAXIMUM_HELPER_PACKAGE_BYTES).toBe(
      DISTRIBUTION_PACKAGE_BUNDLE_PROFILE.maximumEncodedPackageBytes,
    );
  });

  test("previews disclosures, confirms, validates exact bytes, runs once, and cleans up", async () => {
    const h = harness();
    const result = await runUseOnce(
      { handoffToken: TOKEN, supportedAgent: "codex" },
      { ...h, now: () => NOW },
    );
    expect(result).toEqual({
      status: "used_once",
      issueId: ids.issueId,
      lifecycleReported: false,
      contributorSignalsEmitted: "none",
    });
    expect(h.events).toEqual([
      "recover",
      "preview",
      "retrieve",
      "show:Example Publisher:MIT",
      `terms:${h.data.preview.license.bundledTerms?.sha256}`,
      "confirm",
      "stage:LICENSE,SKILL.md",
      "consume",
      "execute:codex",
      "cleanup",
    ]);
  });

  test("does not consume when terms are refused", async () => {
    const h = harness({ confirmation: null });
    await expect(
      runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
    ).rejects.toMatchObject({ code: "TERMS_REFUSED" });
    expect(h.events).not.toContain("consume");
    expect(h.events.some((event) => event.startsWith("stage"))).toBe(false);
  });

  test("rejects an exact-object hash mismatch before staging or execution", async () => {
    const h = harness({ bytes: new TextEncoder().encode("tampered") });
    await expect(
      runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
    ).rejects.toMatchObject({ code: "PACKAGE_HASH_MISMATCH" });
    expect(h.events.some((event) => event.startsWith("stage"))).toBe(false);
    expect(h.events.some((event) => event.startsWith("execute"))).toBe(false);
  });

  test("requires the canonical portable-package media type while V2 stays decoder-enforced", async () => {
    const h = harness({ contentType: "application/vnd.selftune.portable-package-v2+json" });
    await expect(
      runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
    ).rejects.toMatchObject({ code: "INVALID_AUTHORITY_RESPONSE" });
    expect(h.events).not.toContain("consume");
  });

  test("rejects content one byte above the canonical encoded-package ceiling", async () => {
    const oversized = new Uint8Array(MAXIMUM_HELPER_PACKAGE_BYTES + 1);
    const hash = createHash("sha256").update(oversized).digest("hex");
    const data = fixture();
    const h = harness({
      preview: { ...data.preview, packagedSha256: hash },
      consumption: { ...data.consumption, packagedSha256: hash },
      bytes: oversized,
    });
    await expect(
      runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
    ).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
    expect(h.events.some((event) => event.startsWith("stage"))).toBe(false);
  });

  test("rejects a malformed canonical package before consumption or execution", async () => {
    const malformed = new TextEncoder().encode("not-json");
    const data = fixture();
    const hash = createHash("sha256").update(malformed).digest("hex");
    const preview = { ...data.preview, packagedSha256: hash };
    const consumption = { ...data.consumption, packagedSha256: hash };
    const h = harness({ preview, consumption, bytes: malformed });
    await expect(
      runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
    ).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
    expect(h.events).not.toContain("consume");
    expect(h.events.filter((event) => event.startsWith("execute"))).toHaveLength(0);
  });

  test("rejects package bytes whose bundled license terms do not match inspection", async () => {
    const data = fixture();
    const h = harness({
      preview: {
        ...data.preview,
        license: {
          ...data.preview.license,
          bundledTerms: { path: "LICENSE", sha256: "0".repeat(64) },
        },
      },
    });
    await expect(
      runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
    ).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
    expect(h.events).not.toContain("consume");
  });

  test("rejects bundled terms above the bounded interactive disclosure limit", async () => {
    const licenseBytes = new Uint8Array(64 * 1024 + 1).fill(65);
    const bytes = encodePortablePackageBundleSync({
      files: [
        { path: "SKILL.md", content: new TextEncoder().encode("# Shared skill\n") },
        { path: "LICENSE", content: licenseBytes },
      ],
    });
    const packagedSha256 = createHash("sha256").update(bytes).digest("hex");
    const licenseSha256 = createHash("sha256").update(licenseBytes).digest("hex");
    const data = fixture();
    const h = harness({
      preview: {
        ...data.preview,
        packagedSha256,
        license: {
          ...data.preview.license,
          bundledTerms: { path: "LICENSE", sha256: licenseSha256 },
        },
      },
      consumption: { ...data.consumption, packagedSha256 },
      bytes,
    });
    await expect(
      runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
    ).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
    expect(h.events).not.toContain("consume");
  });

  test("always cleans the ephemeral workspace when the agent fails or is interrupted", async () => {
    const h = harness({
      execute: async () => {
        h.events.push("execute:aborted");
        throw new DOMException("aborted", "AbortError");
      },
    });
    await expect(
      runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
    ).rejects.toThrow("aborted");
    expect(h.events.at(-1)).toBe("cleanup");
  });

  test("an abort during a long stage cleans up without consuming the authority", async () => {
    const controller = new AbortController();
    const h = harness();
    const stage = h.workspace.stage.bind(h.workspace);
    h.workspace.stage = async (input) => {
      const staged = await stage(input);
      controller.abort(new DOMException("interrupted during stage", "AbortError"));
      return staged;
    };
    await expect(
      runUseOnce(
        { handoffToken: TOKEN, supportedAgent: "codex", signal: controller.signal },
        { ...h, now: () => NOW },
      ),
    ).rejects.toThrow("interrupted during stage");
    expect(h.events).not.toContain("consume");
    expect(h.events.at(-1)).toBe("cleanup");
  });

  test("rejects expired, agent-mismatched, broadened telemetry responses", async () => {
    await Promise.all(
      [
        { ...fixture().preview, expiresAt: "2026-07-20T23:59:59.000Z" },
        { ...fixture().preview, supportedAgent: "pi" },
        { ...fixture().preview, trustedTelemetry: "authorized" },
        { ...fixture().preview, telemetryCredential: "secret" },
        { ...fixture().preview, publisher: { name: "x".repeat(513) } },
        {
          ...fixture().preview,
          license: { ...fixture().preview.license, kind: "proprietary", bundledTerms: null },
        },
      ].map(async (preview) => {
        const h = harness({ preview });
        await expect(
          runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
        ).rejects.toBeInstanceOf(UseOnceHelperError);
        expect(h.events).not.toContain("consume");
      }),
    );
  });

  test("a replay race can spawn the agent at most once", async () => {
    const h = harness();
    let consumed = false;
    h.authority.consume = async () => {
      if (consumed) throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "replay");
      consumed = true;
      return h.data.consumption;
    };
    const outcomes = await Promise.allSettled([
      runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
      runUseOnce({ handoffToken: TOKEN, supportedAgent: "codex" }, { ...h, now: () => NOW }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(h.events.filter((event) => event.startsWith("execute"))).toHaveLength(1);
  });
});
