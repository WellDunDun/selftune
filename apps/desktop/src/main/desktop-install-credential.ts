import { createHash } from "node:crypto";

import {
  DesktopInstallFinalizeRequestSchema,
  DesktopInstallFinalizeResponseSchema,
  type DesktopInstallFinalizeRequest,
  type DesktopInstallFinalizeResponse,
} from "@selftune/api-contract/install-credentials";
import type {
  DurableInstallReceipt,
  DurableInstallReceiptAuthority,
} from "@selftune/runtime/installer/materializer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DesktopRecipientPreview } from "./desktop-install-bootstrap";
import type { SecureDesktopCloudSession } from "./desktop-recipient-preview";

const MaximumResponseBytes = 64 * 1_024;
const RequestTimeoutMilliseconds = 15_000;

export interface DesktopInstallFinalizationCloudClient {
  readonly finalize: (
    request: DesktopInstallFinalizeRequest,
  ) => Promise<DesktopInstallFinalizeResponse>;
}

export interface DesktopPostCommitFinalizationInput {
  readonly receiptId: string;
  readonly bootstrapToken: string;
  readonly preview: DesktopRecipientPreview;
  readonly installLifecycleConsent: "not_granted" | "granted";
}

export type DesktopPostCommitFinalizationResult =
  | { readonly status: "finalized"; readonly installLifecycle: "reported" | "not_reported" }
  | {
      readonly status: "not_finalized";
      readonly reason:
        | "receipt_not_committed"
        | "receipt_binding_mismatch"
        | "authority_unavailable";
      readonly installLifecycle: "not_reported";
    };

interface CoordinatorDependencies {
  readonly receipts: Pick<DurableInstallReceiptAuthority, "readReceipt">;
  readonly cloud: DesktopInstallFinalizationCloudClient;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalReceiptEvidence(receipt: DurableInstallReceipt): string {
  // Intentionally excludes paths, filenames, machine identity, and file-level receipt details.
  return JSON.stringify({
    version: 1,
    receiptId: receipt.receiptId,
    operationId: receipt.operationId,
    state: receipt.state,
    distributionId: receipt.distributionId,
    shareId: receipt.shareId,
    sealedPackageSha256: receipt.sealedPackageSha256,
    logicalSkillId: receipt.logicalSkillId,
    logicalVersion: receipt.logicalVersion,
    previewFingerprint: receipt.previewFingerprint,
    consentId: receipt.consent.consentId,
    disclosureSha256: receipt.consent.disclosureSha256,
    termsAccepted: receipt.consent.termsAccepted,
    createdAt: receipt.createdAt,
  });
}

function receiptBindingFailure(
  receipt: DurableInstallReceipt,
  input: DesktopPostCommitFinalizationInput,
): DesktopPostCommitFinalizationResult | null {
  if (receipt.state !== "active") {
    return {
      status: "not_finalized",
      reason: "receipt_not_committed",
      installLifecycle: "not_reported",
    };
  }
  if (
    receipt.distributionId !== input.preview.distributionId ||
    receipt.shareId !== input.preview.shareId ||
    receipt.sealedPackageSha256 !== input.preview.packagedSha256 ||
    receipt.consent.termsAccepted !== true ||
    receipt.consent.disclosureSha256 !== input.preview.termsDisclosureSha256
  ) {
    return {
      status: "not_finalized",
      reason: "receipt_binding_mismatch",
      installLifecycle: "not_reported",
    };
  }
  return null;
}

/** Finalizes separately consented install lifecycle after an active local receipt reload. */
export async function coordinatePostCommitInstallFinalization(
  input: DesktopPostCommitFinalizationInput,
  dependencies: CoordinatorDependencies,
): Promise<DesktopPostCommitFinalizationResult> {
  const receipt = await Effect.runPromise(dependencies.receipts.readReceipt(input.receiptId)).catch(
    () => null,
  );
  if (receipt === null) {
    return {
      status: "not_finalized",
      reason: "receipt_not_committed",
      installLifecycle: "not_reported",
    };
  }
  const bindingFailure = receiptBindingFailure(receipt, input);
  if (bindingFailure !== null) return bindingFailure;
  const lifecycleDisclosure = input.preview.installLifecycleReporting;
  if (lifecycleDisclosure === undefined) {
    return {
      status: "not_finalized",
      reason: "authority_unavailable",
      installLifecycle: "not_reported",
    };
  }
  const evidence = canonicalReceiptEvidence(receipt);
  try {
    const response = await dependencies.cloud.finalize(
      Schema.decodeUnknownSync(DesktopInstallFinalizeRequestSchema)({
        bootstrapToken: input.bootstrapToken,
        distributionId: receipt.distributionId,
        sealedPackageSha256: receipt.sealedPackageSha256,
        pseudonymousInstallKey: sha256(`selftune:install-key:v1:${receipt.receiptId}`),
        receiptEvidenceSha256: sha256(evidence),
        lifecycleReporting:
          input.installLifecycleConsent === "granted"
            ? {
                ...lifecycleDisclosure,
                consent: "granted",
                senderVisibleInstalledStatus: "enabled",
              }
            : lifecycleDisclosure,
      }),
    );
    return {
      status: "finalized",
      installLifecycle:
        response.lifecycleReporting.consent === "granted" ? "reported" : "not_reported",
    };
  } catch {
    return {
      status: "not_finalized",
      reason: "authority_unavailable",
      installLifecycle: "not_reported",
    };
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MaximumResponseBytes) {
    throw new Error("response_too_large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MaximumResponseBytes) throw new Error("response_too_large");
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createDesktopInstallFinalizationCloudClient(
  session: SecureDesktopCloudSession,
  request: typeof fetch = fetch,
): DesktopInstallFinalizationCloudClient {
  const origin = new URL(session.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.port ||
    (origin.hostname !== "selftune.dev" && !origin.hostname.endsWith(".selftune.dev"))
  ) {
    throw new Error("invalid_cloud_origin");
  }
  return {
    finalize: async (payload) => {
      const response = await request(
        new URL("/api/v1/recipient-actions/desktop/install-finalize", origin),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          cache: "no-store",
          credentials: "omit",
          redirect: "manual",
          signal: AbortSignal.timeout(RequestTimeoutMilliseconds),
        },
      );
      if (!response.ok || response.status >= 300) throw new Error("finalization_authority_failed");
      return Schema.decodeUnknownSync(DesktopInstallFinalizeResponseSchema)(
        await readBoundedJson(response),
      );
    },
  };
}
