import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  SignalRoutingCapabilityEnvelope,
  SignalRoutingCapabilityPayload,
} from "../src/signal-routing-capability";

const payload = {
  version: 1,
  kid: "signals-2026-07",
  publicCapabilityId: "550e8400-e29b-41d4-a716-446655440001",
  distributionId: "550e8400-e29b-41d4-a716-446655440002",
  packagedSha256: "a".repeat(64),
  logicalSkill: {
    id: "review-helper",
    version: "b".repeat(64),
  },
  telemetryRecipientOrganizationId: "550e8400-e29b-41d4-a716-446655440003",
  allowedSignalSchema: "selftune.contributor-signals.v1",
  allowedSignalFields: ["grade", "miss_category", "trigger"],
  issuedAt: "2026-07-21T18:00:00.000Z",
  expiresAt: "2026-08-20T18:00:00.000Z",
} as const;

describe("signal routing capability contract", () => {
  it("models one non-secret signed envelope bound to exact routing authority", () => {
    const decodedPayload = Schema.decodeUnknownSync(SignalRoutingCapabilityPayload)(payload);
    const envelope = Schema.decodeUnknownSync(SignalRoutingCapabilityEnvelope)({
      payload: decodedPayload,
      signature: "A".repeat(86),
    });

    expect(envelope.payload).toEqual(payload);
    expect(envelope.signature).toHaveLength(86);
    expect(JSON.stringify(envelope)).not.toContain("secret");
    expect(JSON.stringify(envelope)).not.toContain("createdBy");
    expect(JSON.stringify(envelope)).not.toContain("publisherId");
  });

  it.each([
    { ...payload, allowedSignalFields: ["trigger", "grade"] },
    { ...payload, allowedSignalFields: ["grade", "grade"] },
    { ...payload, allowedSignalFields: ["prompt_text"] },
    { ...payload, issuedAt: "2026-07-21T18:00:00Z" },
    { ...payload, expiresAt: "2026-08-20T18:00:00Z" },
    { ...payload, expiresAt: payload.issuedAt },
    { ...payload, expiresAt: "2026-07-20T18:00:00.000Z" },
    { ...payload, expiresAt: "2026-08-20T18:00:00.001Z" },
  ])("rejects noncanonical or unsafe routing authority %#", (candidate) => {
    expect(() => Schema.decodeUnknownSync(SignalRoutingCapabilityPayload)(candidate)).toThrow();
  });

  it("rejects a noncanonical base64url spelling of the same 64 signature bytes", () => {
    expect(() =>
      Schema.decodeUnknownSync(SignalRoutingCapabilityEnvelope)({
        payload,
        signature: `${"A".repeat(85)}B`,
      }),
    ).toThrow();
  });
});
