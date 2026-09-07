import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCreateReplay } from "../../packages/runtime/create/replay.js";

describe("selftune create replay", () => {
  const tempDirs: string[] = [];
  const originalWhich = Bun.which;

  afterEach(() => {
    Bun.which = originalWhich;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stages the full package when package replay is requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-replay-"));
    tempDirs.push(root);

    const skillDir = join(root, "research-assistant");
    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: research-assistant
description: >
  Use when the user needs structured research help.
---

# Research Assistant

## Workflow Routing

| Trigger | Workflow |
| --- | --- |
| research brief | default |
`,
      "utf-8",
    );
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default workflow\n", "utf-8");
    writeFileSync(join(skillDir, "references", "overview.md"), "# Overview\n", "utf-8");
    writeFileSync(
      join(root, "research-assistant-evals.json"),
      JSON.stringify([{ query: "research brief", should_trigger: true }], null, 2),
      "utf-8",
    );
    Bun.which = (name: string) => (name === "claude" ? "/usr/bin/claude" : null);

    const result = await runCreateReplay({
      skillPath: skillDir,
      mode: "package",
      agent: "claude",
      evalSetPath: join(root, "research-assistant-evals.json"),
      runtimeInvoker: async (input) => {
        expect(
          readFileSync(
            join(
              input.workspaceRoot,
              ".claude",
              "skills",
              "research-assistant",
              "workflows",
              "default.md",
            ),
            "utf8",
          ),
        ).toBe("# Default workflow\n");
        return {
          triggeredSkillNames: ["research-assistant"],
          readSkillPaths: [
            join(
              input.workspaceRoot,
              ".claude",
              "skills",
              "research-assistant",
              "workflows",
              "default.md",
            ),
          ],
          rawOutput: "",
          sessionId: "create-replay-package-1",
          metrics: {
            platform: "claude_code",
            model: "claude-opus-4-6",
            session_id: "create-replay-package-1",
            input_tokens: 50,
            output_tokens: 15,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 6,
            total_cost_usd: 0.01,
            duration_ms: 700,
            num_turns: 1,
          },
        };
      },
    });

    expect(result.mode).toBe("package");
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.runtime_metrics).toEqual({
      eval_runs: 1,
      usage_observations: 1,
      total_duration_ms: 700,
      avg_duration_ms: 700,
      total_input_tokens: 50,
      total_output_tokens: 15,
      total_cache_creation_input_tokens: 3,
      total_cache_read_input_tokens: 6,
      total_cost_usd: 0.01,
      total_turns: 1,
    });
  });
});
