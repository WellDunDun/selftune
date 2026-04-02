import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildAgentEntries,
  installHooks,
  uninstallHooks,
} from "../../cli/selftune/adapters/opencode/install.js";

let tmpRoot: string;
let homeDir: string;
let repoDir: string;
let otherRepoDir: string;
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
  return join(homeDir, ".config", "opencode", "config.json");
}

function getInstallStatePath(): string {
  return join(homeDir, ".config", "opencode", "selftune-install-target.json");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "selftune-opencode-install-"));
  homeDir = join(tmpRoot, "home");
  repoDir = join(tmpRoot, "repo");
  otherRepoDir = join(tmpRoot, "other-repo");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(otherRepoDir, { recursive: true });

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

describe("OpenCode install", () => {
  test("rejects shape-invalid configs during dry-run", () => {
    writeFileSync(join(repoDir, "opencode.json"), JSON.stringify({ hooks: [] }), "utf-8");

    expect(() => installHooks({ dryRun: true })).toThrow(/non-object "hooks" field/);
  });

  test("uninstall removes the recorded install target instead of rediscovering from cwd", () => {
    const installResult = installHooks();
    const userConfigPath = getUserConfigPath();
    const repoConfigPath = join(otherRepoDir, "opencode.json");
    const originalRepoConfig = {
      hooks: {
        "tool.execute.before": {
          command: "/tmp/custom-opencode-hook.sh",
        },
      },
    };

    expect(installResult.configPath).toBe(userConfigPath);
    expect(existsSync(getInstallStatePath())).toBe(true);

    writeJson(repoConfigPath, originalRepoConfig);

    process.chdir(otherRepoDir);
    const uninstallResult = uninstallHooks();

    expect(uninstallResult.targets).toHaveLength(1);
    expect(uninstallResult.targets[0]?.configPath).toBe(userConfigPath);
    expect(uninstallResult.targets[0]?.viaInstallState).toBe(true);
    expect(uninstallResult.targets[0]?.removedHooks.length).toBeGreaterThan(0);
    expect(existsSync(installResult.shimPath)).toBe(false);
    expect(existsSync(getInstallStatePath())).toBe(false);

    const userConfig = readJson(userConfigPath);
    expect(userConfig.hooks).toBeUndefined();
    expect(userConfig.agent).toBeUndefined();
    expect(readJson(repoConfigPath)).toEqual(originalRepoConfig);
  });

  test("dry-run reports installed, unchanged, and skipped entries from real config state", () => {
    const agentEntries = buildAgentEntries();
    const [conflictingAgentName] = Object.keys(agentEntries);
    const projectShimPath = join(process.cwd(), "selftune-opencode-hook.sh");
    const configPath = join(repoDir, "opencode.json");
    const originalConfig = {
      hooks: {
        "tool.execute.before": {
          command: "/tmp/custom-before.sh",
        },
        "tool.execute.after": {
          command: projectShimPath,
        },
      },
      agent: conflictingAgentName
        ? {
            [conflictingAgentName]: {
              description: "user-defined agent",
            },
          }
        : undefined,
    };

    writeJson(configPath, originalConfig);
    const originalConfigText = readFileSync(configPath, "utf-8");

    const result = installHooks({ dryRun: true });

    expect(result.installedHooks).toEqual(["session.idle"]);
    expect(result.unchangedHooks).toEqual(["tool.execute.after"]);
    expect(result.skippedHooks).toEqual([
      {
        event: "tool.execute.before",
        command: "/tmp/custom-before.sh",
      },
    ]);

    if (conflictingAgentName) {
      expect(result.skippedAgents).toContainEqual({ name: conflictingAgentName });
      expect(result.installedAgents).not.toContain(conflictingAgentName);
    }

    expect(readFileSync(configPath, "utf-8")).toBe(originalConfigText);
    expect(existsSync(projectShimPath)).toBe(false);
    expect(existsSync(getInstallStatePath())).toBe(false);
  });

  test("reordered selftune agent configs are treated as unchanged", () => {
    const configPath = join(repoDir, "opencode.json");
    const agentEntries = buildAgentEntries();
    const [agentName, agentEntry] = Object.entries(agentEntries)[0] ?? [];

    expect(agentName).toBeDefined();
    expect(agentEntry).toBeDefined();

    const reorderedEntry = {
      _selftune: agentEntry?._selftune,
      tools: agentEntry?.tools,
      prompt: agentEntry?.prompt,
      model: agentEntry?.model,
      mode: agentEntry?.mode,
      description: agentEntry?.description,
    };

    writeJson(configPath, {
      agent: {
        [agentName as string]: reorderedEntry,
      },
    });

    const result = installHooks({ dryRun: true });

    expect(result.unchangedAgents).toContain(agentName as string);
    expect(result.installedAgents).not.toContain(agentName as string);
  });

  test("agent-only installs do not create or remove the shim", () => {
    const configPath = join(repoDir, "opencode.json");
    const projectShimPath = join(repoDir, "selftune-opencode-hook.sh");
    const customShim = "#!/bin/bash\necho custom-user-shim\n";

    writeJson(configPath, {
      hooks: {
        "tool.execute.before": { command: "/tmp/custom-before.sh" },
        "tool.execute.after": { command: "/tmp/custom-after.sh" },
        "session.idle": { command: "/tmp/custom-idle.sh" },
      },
    });
    writeFileSync(projectShimPath, customShim, "utf-8");

    const installResult = installHooks();

    expect(installResult.installedHooks).toEqual([]);
    expect(installResult.unchangedHooks).toEqual([]);
    expect(installResult.skippedHooks).toHaveLength(3);
    expect(installResult.installedAgents.length).toBeGreaterThan(0);
    expect(readFileSync(projectShimPath, "utf-8")).toBe(customShim);

    const uninstallResult = uninstallHooks();

    expect(uninstallResult.targets).toHaveLength(1);
    expect(uninstallResult.targets[0]?.removedHooks).toEqual([]);
    expect(uninstallResult.targets[0]?.removedAgents.length).toBeGreaterThan(0);
    expect(uninstallResult.targets[0]?.shimWouldBeRemoved).toBe(false);
    expect(uninstallResult.targets[0]?.shimRemoved).toBe(false);
    expect(existsSync(projectShimPath)).toBe(true);
    expect(readFileSync(projectShimPath, "utf-8")).toBe(customShim);
  });
});
