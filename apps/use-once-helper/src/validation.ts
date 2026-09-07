import { createHash, timingSafeEqual } from "node:crypto";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DISTRIBUTION_PACKAGE_BUNDLE_PROFILE } from "@selftune/control-plane/domain";

import type {
  SealedObjectDelivery,
  SupportedAgent,
  UseOnceBinding,
  UseOnceConsumption,
  UseOncePreview,
} from "./contracts";
import {
  SupportedAgentSchema,
  UseOncePreviewSchema,
  UseOnceConsumptionSchema,
  SealedObjectDeliverySchema,
} from "./authority-contract";
import { UseOnceHelperError } from "./errors";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const MAXIMUM_HELPER_PACKAGE_BYTES =
  DISTRIBUTION_PACKAGE_BUNDLE_PROFILE.maximumEncodedPackageBytes;

export const isSupportedAgent = Schema.is(SupportedAgentSchema);

const decodePreview = Schema.decodeUnknownOption(UseOncePreviewSchema);
const decodeConsumption = Schema.decodeUnknownOption(UseOnceConsumptionSchema);
const decodeDelivery = Schema.decodeUnknownOption(SealedObjectDeliverySchema);
const sameContributorSignals = Schema.toEquivalence(UseOncePreviewSchema.fields.contributorSignals);
const sameLifecycle = Schema.toEquivalence(UseOncePreviewSchema.fields.lifecycleReporting);

export function validateHandoffToken(value: string): string {
  if (!TOKEN.test(value)) {
    throw new UseOnceHelperError(
      "INVALID_ARGUMENTS",
      "The use-once handoff token must be one 43-character base64url value.",
    );
  }
  return value;
}

function validateExpiry(timestamp: string, now: Date): void {
  if (Date.parse(timestamp) <= now.getTime()) {
    throw new UseOnceHelperError("EXPIRED", "The use-once authority has expired.");
  }
}

export function validatePreview(
  value: UseOncePreview | Schema.Json,
  expectedAgent: SupportedAgent,
  now: Date,
): UseOncePreview {
  const decoded = decodePreview(value, { onExcessProperty: "error" });
  if (Option.isNone(decoded)) {
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "Use-once preview does not match the exact authority contract.",
    );
  }
  const input = decoded.value;
  if (input.supportedAgent !== expectedAgent) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Agent binding does not match.");
  }
  validateExpiry(input.expiresAt, now);
  return input;
}

function sameBinding(left: UseOnceBinding, right: UseOnceBinding): boolean {
  return (
    left.issueId === right.issueId &&
    left.invitationId === right.invitationId &&
    left.shareId === right.shareId &&
    left.distributionId === right.distributionId &&
    left.sealedObjectId === right.sealedObjectId &&
    left.packagedSha256 === right.packagedSha256
  );
}

export function validateConsumption(
  value: UseOnceConsumption | Schema.Json,
  preview: UseOncePreview,
  now: Date,
): UseOnceConsumption {
  const decoded = decodeConsumption(value, { onExcessProperty: "error" });
  if (Option.isNone(decoded)) {
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "Use-once consumption does not match the exact authority contract.",
    );
  }
  const input = decoded.value;
  if (!sameBinding(input, preview)) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Consumption binding changed.");
  }
  if (
    input.supportedAgent !== preview.supportedAgent ||
    input.termsDisclosureSha256 !== preview.terms.disclosureSha256
  ) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Consumption policy changed.");
  }
  validateExpiry(input.expiresAt, now);
  if (!sameContributorSignals(input.contributorSignals, preview.contributorSignals)) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Signal disclosure changed.");
  }
  if (!sameLifecycle(input.lifecycleReporting, preview.lifecycleReporting)) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Lifecycle disclosure changed.");
  }
  return input;
}

export function validateDelivery(
  value: SealedObjectDelivery,
  preview: UseOncePreview,
): SealedObjectDelivery {
  const decoded = decodeDelivery(value, { onExcessProperty: "error" });
  if (Option.isNone(decoded)) {
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "Sealed object delivery does not match the exact authority contract.",
    );
  }
  const input = decoded.value;
  if (!sameBinding(input, preview)) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Delivery binding changed.");
  }
  if (input.contentLength !== input.bytes.byteLength) {
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "Delivery length does not match bytes.",
    );
  }
  if (input.bytes.byteLength > MAXIMUM_HELPER_PACKAGE_BYTES) {
    throw new UseOnceHelperError("PACKAGE_INVALID", "Sealed package exceeds the 25 MiB limit.");
  }
  if (input.contentSha256 !== preview.packagedSha256) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Delivery hash header changed.");
  }
  const actual = createHash("sha256").update(input.bytes).digest();
  const expected = Buffer.from(preview.packagedSha256, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
    throw new UseOnceHelperError("PACKAGE_HASH_MISMATCH", "Sealed package hash does not match.");
  }
  return input;
}
