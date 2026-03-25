import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getClaudeAgentManifestPath,
  installAgentFiles,
  removeInstalledAgentFiles,
} from "../../cli/selftune/claude-agents.js";
import { runInit } from "../../cli/selftune/init.js";
import type { SelftuneConfig } from "../../cli/selftune/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-claude-agents-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("installAgentFiles", () => {
  test("syncs bundled agents, removes stale managed files, and preserves unrelated agents", () => {
    const sourceDir = join(tmpDir, "source-agents");
    const targetDir = join(tmpDir, ".claude", "agents");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    writeFileSync(join(sourceDir, "diagnosis-analyst.md"), "---\nname: diagnosis-analyst\n---\n");
    writeFileSync(join(sourceDir, "evolution-reviewer.md"), "---\nname: evolution-reviewer\n---\n");

    writeFileSync(join(targetDir, "pattern-analyst.md"), "stale managed agent");
    writeFileSync(join(targetDir, "BrowserAgent.md"), "user-owned agent");

    const changed = installAgentFiles({ homeDir: tmpDir, sourceDir });

    expect(changed).toEqual([
      "diagnosis-analyst.md",
      "evolution-reviewer.md",
      "pattern-analyst.md",
    ]);
    expect(readFileSync(join(targetDir, "diagnosis-analyst.md"), "utf-8")).toContain(
      "name: diagnosis-analyst",
    );
    expect(existsSync(join(targetDir, "pattern-analyst.md"))).toBe(false);
    expect(readFileSync(join(targetDir, "BrowserAgent.md"), "utf-8")).toBe("user-owned agent");

    const manifest = JSON.parse(readFileSync(getClaudeAgentManifestPath(tmpDir), "utf-8")) as {
      files: string[];
    };
    expect(manifest.files).toEqual(["diagnosis-analyst.md", "evolution-reviewer.md"]);
  });
});

describe("removeInstalledAgentFiles", () => {
  test("removes only selftune-managed agents and manifest", () => {
    const sourceDir = join(tmpDir, "source-agents");
    const targetDir = join(tmpDir, ".claude", "agents");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    writeFileSync(join(sourceDir, "diagnosis-analyst.md"), "---\nname: diagnosis-analyst\n---\n");
    installAgentFiles({ homeDir: tmpDir, sourceDir });

    writeFileSync(join(targetDir, "BrowserAgent.md"), "user-owned agent");

    const result = removeInstalledAgentFiles({ homeDir: tmpDir });

    expect(result.removed).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(targetDir, "diagnosis-analyst.md"))).toBe(false);
    expect(existsSync(getClaudeAgentManifestPath(tmpDir))).toBe(false);
    expect(readFileSync(join(targetDir, "BrowserAgent.md"), "utf-8")).toBe("user-owned agent");
  });
});

describe("runInit agent sync", () => {
  test("syncs bundled Claude agents during first-time init", async () => {
    const configDir = join(tmpDir, ".selftune");
    const configPath = join(configDir, "config.json");

    await runInit({
      configDir,
      configPath,
      force: false,
      agentOverride: "claude_code",
      cliPathOverride: "/test/cli/selftune/index.ts",
      homeDir: tmpDir,
    });

    expect(existsSync(join(tmpDir, ".claude", "agents", "evolution-reviewer.md"))).toBe(true);
    expect(existsSync(getClaudeAgentManifestPath(tmpDir))).toBe(true);
  });

  test("fast-path init still refreshes managed Claude agents", async () => {
    const configDir = join(tmpDir, ".selftune");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(tmpDir, ".claude", "agents"), { recursive: true });

    const existingConfig: SelftuneConfig = {
      agent_type: "claude_code",
      cli_path: "/old/path/index.ts",
      llm_mode: "agent",
      agent_cli: "claude",
      hooks_installed: true,
      initialized_at: "2026-03-01T00:00:00.000Z",
    };
    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), "utf-8");
    writeFileSync(join(tmpDir, ".claude", "agents", "evolution-reviewer.md"), "stale reviewer");

    const result = await runInit({
      configDir,
      configPath,
      force: false,
      homeDir: tmpDir,
    });

    expect(result.initialized_at).toBe("2026-03-01T00:00:00.000Z");
    expect(
      readFileSync(join(tmpDir, ".claude", "agents", "evolution-reviewer.md"), "utf-8"),
    ).toContain("name: evolution-reviewer");
  });
});
