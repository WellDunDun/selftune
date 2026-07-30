import { SignalRoutingCapabilityEnvelope as RootSignalRoutingCapabilityEnvelope } from "@selftune/api-contract";
import { SignalRoutingCapabilityEnvelope as SubpathSignalRoutingCapabilityEnvelope } from "@selftune/api-contract/signal-routing-capability";
import { describe, expect, it } from "vitest";

describe("signal-routing capability package exports", () => {
  it("exposes the contract from the root and official package subpath", () => {
    expect(RootSignalRoutingCapabilityEnvelope).toBe(SubpathSignalRoutingCapabilityEnvelope);
  });
});
