import { createHash, timingSafeEqual } from "node:crypto";

import { DISTRIBUTION_PACKAGE_BUNDLE_PROFILE } from "@selftune/control-plane/domain";

import type {
  ContributorSignals,
  HelperContributorSignals,
  SealedObjectDelivery,
  SupportedAgent,
  UseOnceBinding,
  UseOnceConsumption,
  UseOncePreview,
} from "./contracts";
import { SUPPORTED_AGENTS } from "./contracts";
import { UseOnceHelperError } from "./errors";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
export const MAXIMUM_HELPER_PACKAGE_BYTES =
  DISTRIBUTION_PACKAGE_BUNDLE_PROFILE.maximumEncodedPackageBytes;

export function isSupportedAgent(value: string): value is SupportedAgent {
  return (SUPPORTED_AGENTS as readonly string[]).includes(value);
}

export function validateHandoffToken(value: string): string {
  if (!TOKEN.test(value)) {
    throw new UseOnceHelperError(
      "INVALID_ARGUMENTS",
      "The use-once handoff token must be one 43-character base64url value.",
    );
  }
  return value;
}

function exactKeys(value: object, keys: readonly string[], subject: string): void {
  const actual = Object.keys(value).toSorted();
  const expected = keys.toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      `${subject} contains missing or unexpected fields.`,
    );
  }
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", `${subject} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", `${subject} must be non-empty.`);
  }
  return value;
}

function boundedStringField(value: unknown, subject: string, maximum: number): string {
  const output = stringField(value, subject);
  if (output.length > maximum)
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      `${subject} exceeds ${maximum} characters.`,
    );
  return output;
}

function validateContributorSignals(value: unknown): ContributorSignals {
  const input = record(value, "Contributor signal disclosure");
  const keys = [
    "_tag",
    "signalDisclosureSha256",
    "signalRecipientOrganizationId",
    "allowedFields",
    "capability",
    "defaultState",
    "contributorConsent",
    "enabled",
  ];
  exactKeys(input, keys, "Signal disclosure");
  if (!SHA256.test(String(input.signalDisclosureSha256)) || input.defaultState !== "off")
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Invalid signal disclosure.");
  if (input._tag === "signals_unavailable") {
    if (
      input.signalRecipientOrganizationId !== null ||
      input.capability !== "not_capable" ||
      input.contributorConsent !== "not_applicable" ||
      input.enabled !== false ||
      !Array.isArray(input.allowedFields) ||
      input.allowedFields.length !== 0
    ) {
      throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Invalid unavailable signals.");
    }
    return input as unknown as ContributorSignals;
  }
  const allowed = new Set(["trigger", "grade", "miss_category"]);
  if (
    (input._tag !== "capable_default_off" && input._tag !== "capable_consented") ||
    !UUID.test(String(input.signalRecipientOrganizationId)) ||
    input.capability !== "capable" ||
    input.contributorConsent !== (input._tag === "capable_consented" ? "granted" : "not_granted") ||
    input.enabled !== (input._tag === "capable_consented") ||
    !Array.isArray(input.allowedFields) ||
    input.allowedFields.length === 0 ||
    input.allowedFields.some((field) => !allowed.has(String(field)))
  ) {
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "Contributor signal disclosure is not consent-bound.",
    );
  }
  return input as unknown as ContributorSignals;
}

function validateHelperContributorSignals(value: unknown): HelperContributorSignals {
  const input = record(value, "Helper contributor signal disclosure");
  exactKeys(
    input,
    ["_tag", "signalDisclosureSha256", "allowedFields", "defaultState", "trustedTelemetry"],
    "Helper contributor signal disclosure",
  );
  const allowed = new Set(["trigger", "grade", "miss_category"]);
  if (
    (input._tag !== "unavailable" && input._tag !== "portable_unverified") ||
    !SHA256.test(String(input.signalDisclosureSha256)) ||
    input.defaultState !== "off" ||
    input.trustedTelemetry !== "not_authorized" ||
    !Array.isArray(input.allowedFields) ||
    (input._tag === "unavailable" && input.allowedFields.length !== 0) ||
    (input._tag === "portable_unverified" && input.allowedFields.length === 0) ||
    input.allowedFields.some((field) => !allowed.has(String(field)))
  )
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "Helper signals must be unavailable or portable_unverified.",
    );
  return input as unknown as HelperContributorSignals;
}

function validateBinding(input: Record<string, unknown>): UseOnceBinding {
  for (const key of ["issueId", "invitationId", "shareId", "distributionId", "sealedObjectId"]) {
    if (!UUID.test(stringField(input[key], key))) {
      throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", `${key} must be a UUID.`);
    }
  }
  if (!SHA256.test(stringField(input.packagedSha256, "packagedSha256"))) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "packagedSha256 must be SHA-256.");
  }
  return input as unknown as UseOnceBinding;
}

function validateExpiry(value: unknown, now: Date): string {
  const timestamp = stringField(value, "expiresAt");
  if (!ISO_INSTANT.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "expiresAt must be a UTC instant.");
  }
  if (Date.parse(timestamp) <= now.getTime()) {
    throw new UseOnceHelperError("EXPIRED", "The use-once authority has expired.");
  }
  return timestamp;
}

function validateInstant(value: unknown, subject: string): string {
  const timestamp = stringField(value, subject);
  if (!ISO_INSTANT.test(timestamp) || !Number.isFinite(Date.parse(timestamp)))
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", `${subject} must be a UTC instant.`);
  return timestamp;
}

export function validatePreview(
  value: unknown,
  expectedAgent: SupportedAgent,
  now: Date,
): UseOncePreview {
  const input = record(value, "Use-once preview");
  exactKeys(
    input,
    [
      "issueId",
      "invitationId",
      "shareId",
      "distributionId",
      "sealedObjectId",
      "packagedSha256",
      "status",
      "supportedAgent",
      "issuedAt",
      "expiresAt",
      "publisher",
      "rightsHolder",
      "package",
      "license",
      "provenance",
      "terms",
      "contributorSignals",
      "lifecycleReporting",
      "helperContributorSignals",
      "persistence",
      "persistentInstall",
      "trustedTelemetry",
      "contentRetrieval",
      "previewMutation",
      "usedOnceReporting",
      "consumeRequired",
      "authorityLimits",
    ],
    "Use-once preview",
  );
  validateBinding(input);
  if (input.status !== "preview" || input.supportedAgent !== expectedAgent)
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Agent binding does not match.");
  validateInstant(input.issuedAt, "issuedAt");
  validateExpiry(input.expiresAt, now);
  if (
    input.persistence !== "ephemeral_use_once" ||
    input.persistentInstall !== "not_authorized" ||
    input.trustedTelemetry !== "not_authorized" ||
    input.contentRetrieval !== "repeatable_exact_object_before_consume" ||
    input.previewMutation !== "none" ||
    input.usedOnceReporting !== "not_emitted" ||
    input.consumeRequired !== true
  )
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Use-once policy was broadened.");

  const publisher = record(input.publisher, "Publisher");
  exactKeys(publisher, ["name"], "Publisher");
  boundedStringField(publisher.name, "publisher.name", 512);

  const rightsHolder = record(input.rightsHolder, "Rights holder");
  exactKeys(rightsHolder, ["kind", "name"], "Rights holder");
  if (!new Set(["organization", "user", "external"]).has(String(rightsHolder.kind)))
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Invalid rights holder kind.");
  boundedStringField(rightsHolder.name, "rightsHolder.name", 512);

  const pkg = record(input.package, "Package");
  exactKeys(pkg, ["displayName", "version", "format"], "Package");
  boundedStringField(pkg.displayName, "package.displayName", 512);
  boundedStringField(pkg.version, "package.version", 128);
  if (pkg.format !== "selftune-portable-package-v2")
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Unexpected package format.");

  const license = record(input.license, "License");
  exactKeys(license, ["expression", "kind", "licenseEvidenceSha256", "bundledTerms"], "License");
  boundedStringField(license.expression, "license.expression", 1_024);
  if (
    !new Set(["spdx", "license_ref", "proprietary"]).has(String(license.kind)) ||
    !SHA256.test(String(license.licenseEvidenceSha256))
  )
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Invalid license evidence.");
  if (license.bundledTerms !== null) {
    const bundled = record(license.bundledTerms, "Bundled terms");
    exactKeys(bundled, ["path", "sha256"], "Bundled terms");
    boundedStringField(bundled.path, "license.bundledTerms.path", 1_024);
    if (!SHA256.test(String(bundled.sha256)))
      throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Invalid bundled terms hash.");
  }
  if (license.kind !== "spdx" && license.bundledTerms === null)
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "Non-SPDX terms must be bundled for interactive disclosure.",
    );

  const provenance = record(input.provenance, "Provenance");
  exactKeys(provenance, ["kind", "sourceRepository", "sourceRef", "sourceTreeHash"], "Provenance");
  if (
    !new Set([
      "github_verified",
      "selftune_authored",
      "imported_upstream",
      "self_attested_upload",
    ]).has(String(provenance.kind)) ||
    ["sourceRepository", "sourceRef", "sourceTreeHash"].some((key) => {
      const field = provenance[key];
      return field !== null && (typeof field !== "string" || field.length > 2_048);
    })
  )
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Invalid provenance evidence.");

  const terms = record(input.terms, "Terms");
  exactKeys(terms, ["disclosureSha256", "summary", "issueAcceptance"], "Terms");
  if (!SHA256.test(stringField(terms.disclosureSha256, "terms.disclosureSha256")))
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Invalid terms disclosure hash.");
  boundedStringField(terms.summary, "terms.summary", 4_096);
  if (terms.issueAcceptance !== "accepted_at_issue")
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Terms were not accepted at issue.");
  validateContributorSignals(input.contributorSignals);
  validateHelperContributorSignals(input.helperContributorSignals);

  const lifecycle = record(input.lifecycleReporting, "Lifecycle disclosure");
  exactKeys(
    lifecycle,
    ["_tag", "lifecycleDisclosureSha256", "consent", "senderVisibleUsedOnceStatus"],
    "Lifecycle disclosure",
  );
  if (
    lifecycle._tag !== "used_once_status" ||
    !SHA256.test(String(lifecycle.lifecycleDisclosureSha256)) ||
    !["not_granted", "granted"].includes(String(lifecycle.consent)) ||
    lifecycle.senderVisibleUsedOnceStatus !==
      (lifecycle.consent === "granted" ? "enabled" : "disabled")
  )
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Invalid lifecycle disclosure.");

  const limits = record(input.authorityLimits, "Authority limits");
  exactKeys(
    limits,
    ["localPath", "command", "url", "bytes", "credential", "installAuthority"],
    "Authority limits",
  );
  if (
    limits.localPath !== "not_provided" ||
    limits.command !== "not_provided" ||
    limits.url !== "not_provided" ||
    limits.bytes !== "not_provided" ||
    limits.credential !== "not_provided" ||
    limits.installAuthority !== "not_authorized"
  )
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Preview granted extra authority.");
  return input as unknown as UseOncePreview;
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
  value: unknown,
  preview: UseOncePreview,
  now: Date,
): UseOnceConsumption {
  const input = record(value, "Use-once consumption");
  exactKeys(
    input,
    [
      "requestId",
      "issueId",
      "invitationId",
      "shareId",
      "distributionId",
      "sealedObjectId",
      "packagedSha256",
      "supportedAgent",
      "termsDisclosureSha256",
      "termsAcceptance",
      "executionConsent",
      "status",
      "consumedAt",
      "expiresAt",
      "persistence",
      "persistentInstall",
      "trustedTelemetry",
      "lifecycleReporting",
      "contributorSignals",
      "recipientAccess",
      "accountlessPolicyResult",
    ],
    "Use-once consumption",
  );
  if (!UUID.test(stringField(input.requestId, "requestId")))
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "requestId must be a UUID.");
  const binding = validateBinding(input);
  if (!sameBinding(binding, preview))
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Consumption binding changed.");
  if (
    input.supportedAgent !== preview.supportedAgent ||
    input.termsDisclosureSha256 !== preview.terms.disclosureSha256 ||
    input.termsAcceptance !== "accepted" ||
    input.executionConsent !== "granted" ||
    input.status !== "consumed" ||
    input.persistence !== "ephemeral_use_once" ||
    input.persistentInstall !== "not_authorized" ||
    input.trustedTelemetry !== "not_authorized"
  )
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Consumption policy changed.");
  if (
    (input.recipientAccess !== "authenticated" && input.recipientAccess !== "accountless") ||
    input.accountlessPolicyResult !==
      (input.recipientAccess === "authenticated" ? "authenticated_account" : "public_allowed")
  )
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Invalid recipient access result.");
  validateExpiry(input.expiresAt, now);
  if (!ISO_INSTANT.test(stringField(input.consumedAt, "consumedAt")))
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Invalid consumedAt.");
  const signals = validateContributorSignals(input.contributorSignals);
  if (JSON.stringify(signals) !== JSON.stringify(preview.contributorSignals))
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Signal disclosure changed.");
  if (JSON.stringify(input.lifecycleReporting) !== JSON.stringify(preview.lifecycleReporting))
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Lifecycle disclosure changed.");
  return input as unknown as UseOnceConsumption;
}

export function validateDelivery(value: unknown, preview: UseOncePreview): SealedObjectDelivery {
  const input = record(value, "Sealed object delivery");
  exactKeys(
    input,
    [
      "issueId",
      "invitationId",
      "shareId",
      "distributionId",
      "sealedObjectId",
      "packagedSha256",
      "contentType",
      "contentLength",
      "contentSha256",
      "bytes",
    ],
    "Sealed object delivery",
  );
  const binding = validateBinding(input);
  if (!sameBinding(binding, preview))
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Delivery binding changed.");
  if (input.contentType !== "application/vnd.selftune.portable-package+json")
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Unexpected delivery content type.");
  if (!(input.bytes instanceof Uint8Array) || input.contentLength !== input.bytes.byteLength)
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "Delivery length does not match bytes.",
    );
  if (input.bytes.byteLength > MAXIMUM_HELPER_PACKAGE_BYTES)
    throw new UseOnceHelperError("PACKAGE_INVALID", "Sealed package exceeds the 25 MiB limit.");
  if (input.contentSha256 !== preview.packagedSha256)
    throw new UseOnceHelperError("INVALID_AUTHORITY_RESPONSE", "Delivery hash header changed.");
  const actual = createHash("sha256").update(input.bytes).digest();
  const expected = Buffer.from(preview.packagedSha256, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected))
    throw new UseOnceHelperError("PACKAGE_HASH_MISMATCH", "Sealed package hash does not match.");
  return input as unknown as SealedObjectDelivery;
}
