import { Schema } from "effect";

import {
  ContributorSignalFieldSchema,
  DistributionIdSchema,
  OrganizationIdSchema,
  Sha256Schema,
  UtcTimestampSchema,
} from "./distribution";

const Base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const Ed25519SignatureByteLength = 64;

function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length % 4 === 1) return null;
  const bytes: number[] = [];
  let accumulator = 0;
  let bitCount = 0;
  for (const character of value) {
    const digit = Base64UrlAlphabet.indexOf(character);
    if (digit < 0) return null;
    accumulator = (accumulator << 6) | digit;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >> bitCount) & 0xff);
      accumulator &= (1 << bitCount) - 1;
    }
  }
  return Uint8Array.from(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  let accumulator = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 6) {
      bitCount -= 6;
      encoded += Base64UrlAlphabet[(accumulator >> bitCount) & 0x3f];
      accumulator &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0) encoded += Base64UrlAlphabet[(accumulator << (6 - bitCount)) & 0x3f];
  return encoded;
}

export function isCanonicalSignalRoutingCapabilitySignature(value: string): boolean {
  const decoded = decodeBase64Url(value);
  return (
    decoded !== null &&
    decoded.byteLength === Ed25519SignatureByteLength &&
    encodeBase64Url(decoded) === value
  );
}

export const SignalRoutingCapabilityPayloadVersionSchema = Schema.Literal(1);
export type SignalRoutingCapabilityPayloadVersion = Schema.Schema.Type<
  typeof SignalRoutingCapabilityPayloadVersionSchema
>;

export const SignalRoutingSigningKeyIdSchema = Schema.NonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, {
    identifier: "SignalRoutingSigningKeyId",
    description: "a stable public signing-key identifier",
  }),
).pipe(Schema.brand("SignalRoutingSigningKeyId"));
export type SignalRoutingSigningKeyId = Schema.Schema.Type<typeof SignalRoutingSigningKeyIdSchema>;

export const SignalRoutingPublicCapabilityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("SignalRoutingPublicCapabilityId"),
);
export type SignalRoutingPublicCapabilityId = Schema.Schema.Type<
  typeof SignalRoutingPublicCapabilityIdSchema
>;

export const SignalRoutingCapabilitySignatureSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{86}$/, {
    identifier: "Ed25519Signature",
    description: "an unpadded base64url-encoded 64-byte Ed25519 signature",
  }),
  Schema.makeFilter(isCanonicalSignalRoutingCapabilitySignature, {
    identifier: "CanonicalEd25519Signature",
    description: "the canonical base64url encoding of exactly 64 signature bytes",
  }),
).pipe(Schema.brand("SignalRoutingCapabilitySignature"));
export type SignalRoutingCapabilitySignature = Schema.Schema.Type<
  typeof SignalRoutingCapabilitySignatureSchema
>;

export const SignalRoutingAllowedSchema = Schema.Literal("selftune.contributor-signals.v1");
export type SignalRoutingAllowedSchema = Schema.Schema.Type<typeof SignalRoutingAllowedSchema>;

export class SignalRoutingLogicalSkill extends Schema.Class<SignalRoutingLogicalSkill>(
  "SignalRoutingLogicalSkill",
)({
  id: Schema.NonEmptyString,
  /** The immutable source-revision hash is the portable logical version identity. */
  version: Sha256Schema,
}) {}

const CanonicalSignalFields = ["grade", "miss_category", "trigger"] as const;
const MaximumCapabilityLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1_000;

function areCanonicalSignalFields(fields: ReadonlyArray<string>): boolean {
  if (new Set(fields).size !== fields.length) return false;
  const canonical = CanonicalSignalFields.filter((field) => fields.includes(field));
  return (
    canonical.length === fields.length && canonical.every((field, index) => field === fields[index])
  );
}

/**
 * A public, non-secret routing assertion. It provides integrity, not installation
 * authentication or contributor consent.
 */
export class SignalRoutingCapabilityPayload extends Schema.Class<SignalRoutingCapabilityPayload>(
  "SignalRoutingCapabilityPayload",
)(
  Schema.Struct({
    version: SignalRoutingCapabilityPayloadVersionSchema,
    kid: SignalRoutingSigningKeyIdSchema,
    publicCapabilityId: SignalRoutingPublicCapabilityIdSchema,
    distributionId: DistributionIdSchema,
    packagedSha256: Sha256Schema,
    logicalSkill: SignalRoutingLogicalSkill,
    telemetryRecipientOrganizationId: OrganizationIdSchema,
    allowedSignalSchema: SignalRoutingAllowedSchema,
    allowedSignalFields: Schema.NonEmptyArray(ContributorSignalFieldSchema),
    issuedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
  }).check(
    Schema.makeFilter((payload) =>
      !areCanonicalSignalFields(payload.allowedSignalFields)
        ? "Allowed contributor signal fields must be unique and in canonical order"
        : Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)
          ? "Signal routing capability expiry must be after issuance"
          : Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt) >
              MaximumCapabilityLifetimeMilliseconds
            ? "Signal routing capability lifetime exceeds the maximum"
            : undefined,
    ),
  ),
) {}

export class SignalRoutingCapabilityEnvelope extends Schema.Class<SignalRoutingCapabilityEnvelope>(
  "SignalRoutingCapabilityEnvelope",
)({
  payload: SignalRoutingCapabilityPayload,
  signature: SignalRoutingCapabilitySignatureSchema,
}) {}
