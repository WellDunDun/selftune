import { describe, expect, test } from "bun:test";
import { formatAlphaStatus } from "../../packages/runtime/status.js";
import { getAlphaGuidanceForState } from "../../packages/runtime/agent-guidance.js";

describe("local cloud connection status", () => {
  test("offers authentication when not linked", () => {
    const output = formatAlphaStatus(null);
    expect(output).toContain("Cloud Connection");
    expect(output).toContain("not linked");
    expect(output).toContain("selftune init --alpha");
  });

  test("distinguishes stored credentials from a verified server connection", () => {
    const output = formatAlphaStatus({ enrolled: true, linkState: "ready" });
    expect(output).toContain("ready");
    expect(output).toContain("not checked by this command");
    expect(output).toContain("stays on this device");
    expect(output).not.toContain("Cloud verified");
    expect(output).not.toContain("Pending:");
    expect(output).not.toContain("Last upload:");
    expect(output).not.toContain("Total pushes:");
  });

  test("offers remediation without suggesting the retired upload command", () => {
    for (const state of [
      "not_linked",
      "linked_not_enrolled",
      "enrolled_no_credential",
      "ready",
    ] as const) {
      const guidance = getAlphaGuidanceForState(state);
      expect(guidance.next_command).not.toContain("alpha upload");
      expect(guidance.message).not.toContain("upload credential");
    }
    expect(formatAlphaStatus({ enrolled: true, linkState: "enrolled_no_credential" })).toContain(
      "selftune init --alpha",
    );
  });
});
