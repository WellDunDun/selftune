import { describe, expect, test } from "bun:test";

import { buildAgentInvocation, parseUseOnceArguments, UseOnceHelperError } from "../src";

const TOKEN = "a".repeat(43);

describe("use-once arguments", () => {
  test("accepts exactly one handoff token and an explicit supported agent", () => {
    expect(parseUseOnceArguments(["--agent", "codex", "--token", TOKEN])).toEqual({
      handoffToken: TOKEN,
      supportedAgent: "codex",
    });
  });

  test.each<readonly string[]>([
    ["--token", "a".repeat(42), "--agent", "codex"],
    ["--token", "a".repeat(44), "--agent", "codex"],
    ["--token", `https://example.test/${TOKEN}`, "--agent", "codex"],
    ["--token", TOKEN, "--agent", "unknown"],
    ["--token", TOKEN, "--agent", "codex", "--path", "/tmp/skill"],
    ["--token", TOKEN, "--agent", "codex", "--command", "touch /tmp/pwned"],
    ["--token", TOKEN, "--token", TOKEN],
  ])("rejects malformed, unsupported, duplicated, or broadened input %#", (argv) => {
    expect(() => parseUseOnceArguments(argv)).toThrow(UseOnceHelperError);
  });

  test("builds fixed argv without a shell even when the temporary path contains metacharacters", () => {
    const invocation = buildAgentInvocation("codex", "/tmp/skill;touch PWNED");
    expect(invocation.executable).toBe("codex");
    expect(invocation.argv).not.toContain("-c");
    expect(invocation.argv).not.toContain("sh");
    expect(invocation.argv).toContain("/tmp/skill;touch PWNED");
  });
});
