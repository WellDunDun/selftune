import { randomBytes } from "node:crypto";

import { describe, expect, it } from "bun:test";
import {
  DesktopInstallFinalizeResponseSchema,
  type DesktopInstallFinalizeRequest,
} from "@selftune/api-contract/install-credentials";
import type { DurableInstallReceipt } from "@selftune/runtime/installer/materializer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DesktopRecipientPreview } from "./desktop-install-bootstrap";
import {
  coordinatePostCommitInstallFinalization,
  type DesktopInstallFinalizationCloudClient,
} from "./desktop-install-credential";

const uuid = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const opaque = () => randomBytes(32).toString("base64url");

function preview(): DesktopRecipientPreview {
  return {
    invitationId: uuid("1"),
    shareId: uuid("2"),
    distributionId: uuid("3"),
    sealedObjectId: uuid("4"),
    packagedSha256: "a".repeat(64),
    termsDisclosureSha256: "b".repeat(64),
    termsAcceptance: "accepted",
    contributorSignals: {
      _tag: "signals_unavailable",
      signalDisclosureSha256: "c".repeat(64),
      signalRecipientOrganizationId: null,
      allowedFields: [],
      capability: "not_capable",
      defaultState: "off",
      contributorConsent: "not_applicable",
      enabled: false,
    },
    installLifecycleReporting: {
      _tag: "installed_status",
      lifecycleDisclosureSha256: "2".repeat(64),
      consent: "not_granted",
      senderVisibleInstalledStatus: "disabled",
    },
    status: "preview",
    expiresAt: "2026-07-21T12:00:00.000Z",
    supportedTargetAgents: ["codex"],
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
}

function receipt(state: DurableInstallReceipt["state"] = "active"): DurableInstallReceipt {
  return {
    receiptId: uuid("6"),
    state,
    agent: "codex",
    scope: "project",
    projectRoot: "/private/project",
    registryRoot: "/private/project/.agents/skills",
    targetPath: "/private/project/.agents/skills/example",
    skillName: "example",
    logicalSkillId: "example",
    sealedPackageSha256: "a".repeat(64),
    subjectKind: "standalone",
    skillSet: null,
    logicalVersion: "d".repeat(64),
    distributionId: uuid("3"),
    shareId: uuid("2"),
    handoffId: uuid("7"),
    sealedObjectId: uuid("4"),
    signature: { algorithm: "Ed25519", keyId: "test", value: "signature" },
    license: { spdxExpression: "MIT", licenseFile: null, notices: [] },
    platform: "darwin",
    strategy: "copy",
    conflictDecision: "cancel",
    backupPath: null,
    consent: {
      consentId: uuid("8"),
      recipientPrincipalId: uuid("9"),
      recordedAt: "2026-07-21T10:00:00.000Z",
      action: "install_with_selftune",
      disclosureSha256: "b".repeat(64),
      termsAccepted: true,
      contributorSignals: "not_granted",
      contributorSignalRecipientOwnerId: null,
      contributorSignalAllowedFields: [],
      lifecycleReporting: "not_granted",
      lifecycleAllowedFields: [],
    },
    source: { kind: "remote_sealed", objectId: uuid("4") },
    previewFingerprint: "e".repeat(64),
    operationId: uuid("a"),
    previousReceiptId: null,
    supersededByReceiptId: null,
    createdAt: "2026-07-21T10:01:00.000Z",
    updatedAt: "2026-07-21T10:01:00.000Z",
    removedAt: null,
    files: [
      { path: "SKILL.md", sha256: "f".repeat(64), byteLength: 12, durableSnapshotRef: "snapshot" },
    ],
  };
}

function cloud(record: DesktopInstallFinalizeRequest[]): DesktopInstallFinalizationCloudClient {
  return {
    finalize: async (request) => {
      record.push(request);
      return Schema.decodeUnknownSync(DesktopInstallFinalizeResponseSchema)({
        finalizationId: uuid("e"),
        status: "finalized",
        lifecycleReporting: request.lifecycleReporting,
        finalizedAt: "2026-07-21T10:01:00.000Z",
      });
    },
  };
}

describe("Desktop post-commit install finalization", () => {
  it("finalizes a committed receipt and keeps lifecycle consent independent", async () => {
    const finalizations: DesktopInstallFinalizeRequest[] = [];
    const result = await coordinatePostCommitInstallFinalization(
      {
        receiptId: uuid("6"),
        bootstrapToken: opaque(),
        preview: preview(),
        installLifecycleConsent: "not_granted",
      },
      { receipts: { readReceipt: () => Effect.succeed(receipt()) }, cloud: cloud(finalizations) },
    );
    expect(result).toEqual({ status: "finalized", installLifecycle: "not_reported" });
    expect(finalizations).toHaveLength(1);
    expect(finalizations[0]).not.toHaveProperty("targetPath");
    expect(finalizations[0]).not.toHaveProperty("machineId");
  });

  it("reports only separately granted installed lifecycle status", async () => {
    const finalizations: DesktopInstallFinalizeRequest[] = [];
    const result = await coordinatePostCommitInstallFinalization(
      {
        receiptId: uuid("6"),
        bootstrapToken: opaque(),
        preview: preview(),
        installLifecycleConsent: "granted",
      },
      { receipts: { readReceipt: () => Effect.succeed(receipt()) }, cloud: cloud(finalizations) },
    );
    expect(result).toEqual({ status: "finalized", installLifecycle: "reported" });
    expect(finalizations[0]?.lifecycleReporting).toMatchObject({
      consent: "granted",
      senderVisibleInstalledStatus: "enabled",
    });
  });

  it("requires an active receipt with the exact preview binding", async () => {
    const finalizations: DesktopInstallFinalizeRequest[] = [];
    const inactive = await coordinatePostCommitInstallFinalization(
      {
        receiptId: uuid("6"),
        bootstrapToken: opaque(),
        preview: preview(),
        installLifecycleConsent: "not_granted",
      },
      {
        receipts: { readReceipt: () => Effect.succeed(receipt("removed")) },
        cloud: cloud(finalizations),
      },
    );
    expect(inactive).toEqual({
      status: "not_finalized",
      reason: "receipt_not_committed",
      installLifecycle: "not_reported",
    });
    expect(finalizations).toHaveLength(0);
  });
});
