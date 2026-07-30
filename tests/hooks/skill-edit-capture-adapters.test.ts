import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Codex, OpenCode, and Pi invoke revision capture only across their real before/after handlers", async () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-adapter-skill-edit-"));
  const previousConfigDir = process.env.SELFTUNE_CONFIG_DIR;
  process.env.SELFTUNE_CONFIG_DIR = root;
  try {
    const skill = join(root, "skill", "SKILL.md");
    mkdirSync(join(root, "skill"), { recursive: true });
    writeFileSync(skill, "# Before\n");
    const codex = await import("@selftune/harness-codex/adapters/codex/hook");
    const opencode = await import("@selftune/harness-opencode/adapters/opencode/hook");
    const pi = await import("@selftune/harness-pi/adapters/pi/hook");

    await codex.handlePreToolUse({
      session_id: "codex",
      tool_name: "Edit",
      tool_use_id: "c",
      tool_input: { file_path: skill },
    });
    writeFileSync(skill, "# Codex\n");
    await codex.handlePostToolUse({
      session_id: "codex",
      tool_name: "Edit",
      tool_use_id: "c",
      tool_input: { file_path: skill },
      tool_response: { success: true },
    });

    await opencode.handleToolBefore({
      event: "tool.execute.before",
      session_id: "opencode",
      tool: { name: "Edit", args: { file_path: skill } },
    });
    writeFileSync(skill, "# OpenCode\n");
    await opencode.handleToolAfter({
      event: "tool.execute.after",
      session_id: "opencode",
      tool: { name: "Edit", args: { file_path: skill }, result: { success: true } },
    });

    await pi.handlePreToolUse({
      session_id: "pi",
      tool_name: "Edit",
      tool_use_id: "p",
      tool_input: { file_path: skill },
    });
    writeFileSync(skill, "# Pi\n");
    await pi.handlePostToolUse({
      session_id: "pi",
      tool_name: "Edit",
      tool_use_id: "p",
      tool_input: { file_path: skill },
      tool_output: { success: true },
    });

    const lines = readFileSync(join(root, "skill-edit-captures.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line).status)).toEqual([
      "captured",
      "captured",
      "captured",
    ]);
  } finally {
    if (previousConfigDir === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
    else process.env.SELFTUNE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  }
});
