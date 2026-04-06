import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildAgentEntries } from "../../cli/selftune/adapters/opencode/install.js";

// ---------------------------------------------------------------------------
// buildAgentEntries unit tests (no filesystem setup needed)
// ---------------------------------------------------------------------------

describe("buildAgentEntries", () => {
  test("discovers bundled agents", () => {
    const entries = buildAgentEntries();
    const names = Object.keys(entries);
    expect(names.length).toBeGreaterThan(0);

    for (const entry of Object.values(entries)) {
      expect(entry.description).toMatch(/^\[selftune\]/);
      expect(entry.mode).toBe("subagent");
      expect(entry.prompt).toBeDefined();
      expect(typeof entry.prompt).toBe("string");
      expect(entry.prompt?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("returns empty for nonexistent directory", () => {
    const entries = buildAgentEntries("/nonexistent/path");
    expect(Object.keys(entries)).toHaveLength(0);
  });

  test("agent entries do not contain non-standard keys", () => {
    const entries = buildAgentEntries();
    const validKeys = new Set(["description", "name", "mode", "model", "prompt", "tools"]);

    for (const entry of Object.values(entries)) {
      for (const key of Object.keys(entry)) {
        expect(validKeys.has(key)).toBe(true);
      }
    }
  });

  test("agent entries use provider/model format for model", () => {
    const entries = buildAgentEntries();
    for (const entry of Object.values(entries)) {
      if (entry.model) {
        expect(entry.model).toContain("/");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Install/uninstall integration tests (temp directory isolation)
// ---------------------------------------------------------------------------

describe("OpenCode install integration", () => {
  let tmpRoot: string;
  let homeDir: string;
  let repoDir: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
  }

  function readJson(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  }

  function getUserConfigPath(): string {
    return join(homeDir, ".config", "opencode", "opencode.json");
  }

  function getGlobalPluginsDir(): string {
    return join(homeDir, ".config", "opencode", "plugins");
  }

  function getPluginPath(): string {
    return join(getGlobalPluginsDir(), "selftune-opencode-plugin.ts");
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "selftune-oc-install-"));
    homeDir = join(tmpRoot, "home");
    repoDir = join(tmpRoot, "repo");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = homeDir;
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("install creates plugin in global plugins dir and agents in config", async () => {
    const { cliMain } = await import("../../cli/selftune/adapters/opencode/install.js");

    // Simulate: selftune opencode install (no flags — args are parsed from process.argv)
    const origArgv = process.argv;
    process.argv = ["bun", "install.ts"];
    try {
      await cliMain();
    } finally {
      process.argv = origArgv;
    }

    // Plugin file should exist in global plugins dir
    expect(existsSync(getPluginPath())).toBe(true);
    const pluginContent = readFileSync(getPluginPath(), "utf-8");
    expect(pluginContent).toContain("SelftunePlugin");
    expect(pluginContent).toContain("selftune opencode hook");

    // Config should have agents but no plugin array
    const config = readJson(getUserConfigPath());
    expect(config.plugin).toBeUndefined();
    expect(config.agent).toBeDefined();

    const agents = config.agent as Record<string, Record<string, unknown>>;
    const names = Object.keys(agents);
    expect(names.length).toBeGreaterThan(0);
    for (const agent of Object.values(agents)) {
      expect(typeof agent.description).toBe("string");
      expect((agent.description as string).startsWith("[selftune]")).toBe(true);
    }
  });

  test("install skips user-defined agents with conflicting names", async () => {
    const agentEntries = buildAgentEntries();
    const [conflictName] = Object.keys(agentEntries);
    if (!conflictName) return; // skip if no bundled agents

    // Pre-populate config with a user-defined agent
    writeJson(getUserConfigPath(), {
      agent: {
        [conflictName]: {
          description: "My custom agent",
          mode: "primary",
        },
      },
    });

    const { cliMain } = await import("../../cli/selftune/adapters/opencode/install.js");
    const origArgv = process.argv;
    process.argv = ["bun", "install.ts"];
    try {
      await cliMain();
    } finally {
      process.argv = origArgv;
    }

    // The user's agent should be preserved
    const config = readJson(getUserConfigPath());
    const agents = config.agent as Record<string, Record<string, unknown>>;
    expect(agents[conflictName]?.description).toBe("My custom agent");
  });

  test("uninstall removes plugin file and agent entries", async () => {
    // First install
    const { cliMain } = await import("../../cli/selftune/adapters/opencode/install.js");
    const origArgv = process.argv;

    process.argv = ["bun", "install.ts"];
    try {
      await cliMain();
    } finally {
      process.argv = origArgv;
    }

    expect(existsSync(getPluginPath())).toBe(true);
    const configBefore = readJson(getUserConfigPath());
    expect(configBefore.agent).toBeDefined();

    // Then uninstall
    process.argv = ["bun", "install.ts", "--uninstall"];
    try {
      await cliMain();
    } finally {
      process.argv = origArgv;
    }

    expect(existsSync(getPluginPath())).toBe(false);
    const configAfter = readJson(getUserConfigPath());
    expect(configAfter.agent).toBeUndefined();
  });

  test("install handles malformed config gracefully", async () => {
    const configPath = getUserConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "not valid json", "utf-8");

    // Should throw a clear error, not crash
    await expect(
      (async () => {
        const { cliMain } = await import("../../cli/selftune/adapters/opencode/install.js");
        const origArgv = process.argv;
        process.argv = ["bun", "install.ts"];
        try {
          await cliMain();
        } finally {
          process.argv = origArgv;
        }
      })(),
    ).rejects.toThrow(/not valid JSON/);
  });
});
