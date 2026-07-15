import { describe, expect, it } from "bun:test";

import { validateAgentSkill } from "../../packages/runtime/create/skills-ref-adapter.js";

function buildSpawnResult(exitCode: number | null, stdout = "", stderr = "") {
  return {
    stdout: Buffer.from(stdout, "utf-8"),
    stderr: Buffer.from(stderr, "utf-8"),
    exitCode,
  } as ReturnType<typeof Bun.spawnSync>;
}

describe("skills-ref adapter", () => {
  it("falls back to the legacy uvx invocation when the new agentskills entrypoint is unavailable", async () => {
    const calls: string[][] = [];
    const result = await validateAgentSkill("/tmp/research-assistant", {
      which(command) {
        return command === "uvx" ? `/usr/bin/${command}` : null;
      },
      spawnSync(argv) {
        calls.push(argv);
        if (argv[0] === "uvx" && argv[1] === "--from") {
          return buildSpawnResult(2, "", "error: The executable `agentskills` was not found");
        }
        return buildSpawnResult(0, "warning: optional field missing", "");
      },
    });

    expect(calls).toEqual([
      ["uvx", "--from", "skills-ref", "agentskills", "validate", "/tmp/research-assistant"],
      ["uvx", "skills-ref", "validate", "/tmp/research-assistant"],
    ]);
    expect(result.ok).toBe(true);
    expect(result.command).toBe("uvx skills-ref validate /tmp/research-assistant");
  });

  it("does not fall back when the validator ran and returned real spec validation errors", async () => {
    const calls: string[][] = [];
    const result = await validateAgentSkill("/tmp/research-assistant", {
      which(command) {
        return command === "uvx" || command === "npx" ? `/usr/bin/${command}` : null;
      },
      spawnSync(argv) {
        calls.push(argv);
        return buildSpawnResult(1, "", "Missing YAML frontmatter.");
      },
    });

    expect(calls).toEqual([
      ["uvx", "--from", "skills-ref", "agentskills", "validate", "/tmp/research-assistant"],
    ]);
    expect(result.ok).toBe(false);
    expect(result.command).toBe(
      "uvx --from skills-ref agentskills validate /tmp/research-assistant",
    );
    expect(result.issues[0]?.message).toContain("Missing YAML frontmatter.");
  });
});
