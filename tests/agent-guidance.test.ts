import { describe, expect, test } from "bun:test";

import { getAlphaGuidanceForState } from "../cli/selftune/agent-guidance.js";

describe("getAlphaGuidanceForState", () => {
  test("includes a trimmed safe alpha email in next_command", () => {
    const guidance = getAlphaGuidanceForState("not_linked", {
      email: "  user@example.com  ",
    });

    expect(guidance.next_command).toBe("selftune init --alpha --alpha-email user@example.com");
  });

  test("omits unsafe alpha email values from next_command", () => {
    const guidance = getAlphaGuidanceForState("not_linked", {
      email: "user@example.com --force\nselftune doctor",
    });

    expect(guidance.next_command).toBe("selftune init --alpha");
  });
});
