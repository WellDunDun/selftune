import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildAgentEntries } from "@selftune/harness-opencode/adapters/opencode/install";
import { OpenCodeConfig } from "@selftune/harness-opencode/adapters/opencode/config";
import * as Schema from "effect/Schema";

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
      expect(entry.prompt?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("returns empty for nonexistent directory", () => {
    const missingDir = join(tmpdir(), `selftune-missing-${process.pid}-${Date.now()}`);
    expect(existsSync(missingDir)).toBe(false);
    const entries = buildAgentEntries(missingDir);
    expect(Object.keys(entries)).toHaveLength(0);
  });

  test("agent entries do not contain non-standard keys", () => {
    const entries = buildAgentEntries();
    const validKeys = new Set(["description", "mode", "model", "prompt", "tools"]);

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
        expect(entry.model).toMatch(/^[^/\s]+\/[^/\s]+$/);
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

  function writeJson(path: string, value: Schema.Json): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
  }

  function readJson(path: string): OpenCodeConfig {
    return Schema.decodeUnknownSync(Schema.fromJsonString(OpenCodeConfig))(
      readFileSync(path, "utf-8"),
    );
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
    const { cliMain } = await import("@selftune/harness-opencode/adapters/opencode/install");

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

    const agents = config.agent ?? {};
    const names = Object.keys(agents);
    expect(names.length).toBeGreaterThan(0);
    for (const agent of Object.values(agents)) {
      expect(agent.description).toMatch(/^\[selftune\]/);
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

    const { cliMain } = await import("@selftune/harness-opencode/adapters/opencode/install");
    const origArgv = process.argv;
    process.argv = ["bun", "install.ts"];
    try {
      await cliMain();
    } finally {
      process.argv = origArgv;
    }

    // The user's agent should be preserved
    const config = readJson(getUserConfigPath());
    const agents = config.agent ?? {};
    expect(agents[conflictName]?.description).toBe("My custom agent");
  });

  test("uninstall removes plugin file and agent entries", async () => {
    // First install
    const { cliMain } = await import("@selftune/harness-opencode/adapters/opencode/install");
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

  test("uninstall preserves user-defined agents while removing selftune agents", async () => {
    // Pre-populate with a user-defined agent
    writeJson(getUserConfigPath(), {
      agent: {
        "my-user-agent": {
          description: "My custom agent",
          mode: "primary",
        },
      },
    });

    const { cliMain } = await import("@selftune/harness-opencode/adapters/opencode/install");
    const origArgv = process.argv;

    // Install (adds selftune agents alongside user agent)
    process.argv = ["bun", "install.ts"];
    try {
      await cliMain();
    } finally {
      process.argv = origArgv;
    }

    // Uninstall (should only remove selftune agents)
    process.argv = ["bun", "install.ts", "--uninstall"];
    try {
      await cliMain();
    } finally {
      process.argv = origArgv;
    }

    expect(existsSync(getPluginPath())).toBe(false);
    const configAfter = readJson(getUserConfigPath());
    const agents = configAfter.agent ?? {};
    expect(agents["my-user-agent"]?.description).toBe("My custom agent");
    for (const a of Object.values(agents)) {
      expect(a.description?.startsWith("[selftune]")).toBe(false);
    }
  });

  test("install handles malformed config gracefully", async () => {
    const configPath = getUserConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "not valid json", "utf-8");

    // Should throw a clear error, not crash
    await expect(
      (async () => {
        const { cliMain } = await import("@selftune/harness-opencode/adapters/opencode/install");
        const origArgv = process.argv;
        process.argv = ["bun", "install.ts"];
        try {
          await cliMain();
        } finally {
          process.argv = origArgv;
        }
      })(),
    ).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(configPath, "utf-8")).toBe("not valid json");
    expect(existsSync(getPluginPath())).toBe(false);
  });

  const invalidConfigs: Array<{ label: string; value: Schema.Json }> = [
    { label: "null", value: null },
    { label: "array", value: [] },
    { label: "string", value: "config" },
    { label: "null agent", value: { agent: null } },
    { label: "array agent", value: { agent: [] } },
    { label: "null agent entry", value: { agent: { custom: null } } },
    { label: "invalid description", value: { agent: { custom: { description: 42 } } } },
    { label: "invalid plugin", value: { plugin: [42] } },
    { label: "plugin object", value: { plugin: { custom: "path" } } },
  ];
  test.each(invalidConfigs)(
    "leaves $label config and existing plugin untouched on install and uninstall",
    async ({ value }) => {
      const configPath = getUserConfigPath();
      writeJson(configPath, value);
      const original = readFileSync(configPath, "utf-8");
      mkdirSync(dirname(getPluginPath()), { recursive: true });
      writeFileSync(getPluginPath(), "existing plugin bytes", "utf-8");
      const { cliMain } = await import("@selftune/harness-opencode/adapters/opencode/install");
      const origArgv = process.argv;
      try {
        process.argv = ["bun", "install.ts"];
        await expect(cliMain()).rejects.toThrow(/refusing to overwrite/);
        expect(readFileSync(configPath, "utf-8")).toBe(original);
        expect(readFileSync(getPluginPath(), "utf-8")).toBe("existing plugin bytes");
        process.argv = ["bun", "install.ts", "--uninstall"];
        await expect(cliMain()).rejects.toThrow(/refusing to overwrite/);
        expect(readFileSync(configPath, "utf-8")).toBe(original);
        expect(readFileSync(getPluginPath(), "utf-8")).toBe("existing plugin bytes");
      } finally {
        process.argv = origArgv;
      }
    },
  );

  test("preserves custom config and agent fields through install and uninstall", async () => {
    const custom = {
      $schema: "https://opencode.ai/config.json",
      permission: { bash: "ask", read: "allow" },
      provider: { custom: { options: { retries: 0, enabled: false } } },
      agent: {
        custom: { description: "Personal agent", temperature: 0.25, permission: { edit: "deny" } },
      },
      plugin: ["custom-plugin"],
    };
    writeJson(getUserConfigPath(), custom);
    const { cliMain } = await import("@selftune/harness-opencode/adapters/opencode/install");
    const origArgv = process.argv;
    try {
      process.argv = ["bun", "install.ts"];
      await cliMain();
      const first = readFileSync(getUserConfigPath(), "utf-8");
      await cliMain();
      expect(readFileSync(getUserConfigPath(), "utf-8")).toBe(first);
      const installed = readJson(getUserConfigPath());
      expect(installed.agent?.custom).toEqual(custom.agent.custom);
      expect(installed.permission).toEqual(custom.permission);
      expect(installed.provider).toEqual(custom.provider);
      expect(installed.plugin).toEqual(custom.plugin);
      process.argv = ["bun", "install.ts", "--uninstall"];
      await cliMain();
      expect(readJson(getUserConfigPath())).toEqual(custom);
      expect(existsSync(getPluginPath())).toBe(false);
    } finally {
      process.argv = origArgv;
    }
  });

  test("dry-run does not create config or plugin files", async () => {
    const { cliMain } = await import("@selftune/harness-opencode/adapters/opencode/install");
    const origArgv = process.argv;
    try {
      process.argv = ["bun", "install.ts", "--dry-run"];
      await cliMain();
      expect(existsSync(getUserConfigPath())).toBe(false);
      expect(existsSync(getPluginPath())).toBe(false);
    } finally {
      process.argv = origArgv;
    }
  });

  test("keeps an unknown model name as text and maps known aliases", () => {
    const agentsDir = join(tmpRoot, "agents");
    mkdirSync(agentsDir);
    for (const model of ["toString", "haiku", "custom/model"]) {
      writeFileSync(
        join(agentsDir, `${model.replace("/", "-")}.md`),
        `---\nname: agent-${model}\nmodel: ${model}\n---\nAgent instructions`,
      );
    }
    const entries = buildAgentEntries(agentsDir);
    expect(entries["agent-toString"]?.model).toBe("toString");
    expect(entries["agent-haiku"]?.model).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(entries["agent-custom/model"]?.model).toBe("custom/model");
  });
});
