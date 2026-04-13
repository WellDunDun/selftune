import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autoUpdate,
  getInstalledSkillDirs,
  getSelftuneUpdateHint,
  isAutoUpdateSkipped,
  resolveSelftuneUpdateCommand,
  syncInstalledSkillFiles,
} from "../../cli/selftune/auto-update.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let tmpDir = "";

beforeEach(() => {
  delete process.env.SELFTUNE_SKIP_AUTO_UPDATE;
  delete process.env.SELFTUNE_SKIP_UPDATE_CHECK;
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-auto-update-"));
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("auto-update skip controls", () => {
  test("honors legacy source-smoke skip env", () => {
    process.env.SELFTUNE_SKIP_AUTO_UPDATE = "1";

    expect(isAutoUpdateSkipped()).toBe(true);
  });

  test("honors explicit update-check skip env", () => {
    process.env.SELFTUNE_SKIP_UPDATE_CHECK = "true";

    expect(isAutoUpdateSkipped()).toBe(true);
  });

  test("treats false-like values as disabled", () => {
    process.env.SELFTUNE_SKIP_AUTO_UPDATE = "0";
    process.env.SELFTUNE_SKIP_UPDATE_CHECK = "false";

    expect(isAutoUpdateSkipped()).toBe(false);
  });

  test("skip env avoids registry calls", async () => {
    process.env.SELFTUNE_SKIP_AUTO_UPDATE = "1";
    const fetchMock = mock(async () => new Response("{}"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await autoUpdate();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("update command resolution", () => {
  test("uses Bun for Bun global installs", () => {
    const command = resolveSelftuneUpdateCommand("0.2.23", {
      homeDir: "/Users/tester",
      moduleDir: "/Users/tester/.bun/install/global/node_modules/selftune/cli/selftune",
      npmGlobalRoot: "/opt/homebrew/lib/node_modules",
    });

    expect(command).toEqual({
      source: "bun-global",
      command: "bun",
      args: ["add", "-g", "selftune@0.2.23"],
      manualCommand: "bun add -g selftune@0.2.23",
    });
  });

  test("uses npm for npm global installs", () => {
    const command = resolveSelftuneUpdateCommand("0.2.23", {
      homeDir: "/Users/tester",
      moduleDir: "/opt/homebrew/lib/node_modules/selftune/cli/selftune",
      npmGlobalRoot: "/opt/homebrew/lib/node_modules",
    });

    expect(command).toEqual({
      source: "npm-global",
      command: "npm",
      args: ["install", "-g", "selftune@0.2.23"],
      manualCommand: "npm install -g selftune@0.2.23",
    });
  });

  test("falls back to skill reinstall guidance when install source is unknown", () => {
    const updateHint = getSelftuneUpdateHint("latest", {
      homeDir: "/Users/tester",
      moduleDir: "/Users/tester/src/selftune/cli/selftune",
      npmGlobalRoot: "/opt/homebrew/lib/node_modules",
    });

    expect(updateHint).toBe("npx skills add selftune-dev/selftune");
  });
});

describe("installed skill sync", () => {
  test("discovers both Claude and .agents skill registries", () => {
    const claudeDir = join(tmpDir, ".claude", "skills", "selftune");
    const agentDir = join(tmpDir, ".agents", "skills", "selftune");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    expect(getInstalledSkillDirs(tmpDir).toSorted()).toEqual([agentDir, claudeDir].toSorted());
  });

  test("syncs newer bundled skill files into both registries", () => {
    const packageSkillDir = join(tmpDir, "skill");
    const claudeDir = join(tmpDir, ".claude", "skills", "selftune");
    const agentDir = join(tmpDir, ".agents", "skills", "selftune");

    mkdirSync(join(packageSkillDir, "workflows"), { recursive: true });
    writeFileSync(packageSkillDir + "/SKILL.md", "---\nversion: 0.2.22\n---\n");
    writeFileSync(packageSkillDir + "/settings_snippet.json", '{\n  "ok": true\n}\n');
    writeFileSync(join(packageSkillDir, "workflows", "Doctor.md"), "# doctor\n");

    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(claudeDir, "SKILL.md"), "---\nversion: 0.2.10\n---\n");
    writeFileSync(join(agentDir, "SKILL.md"), "---\nversion: 0.2.10\n---\n");

    const syncedDirs = syncInstalledSkillFiles({ homeDir: tmpDir, packageSkillDir });

    expect(syncedDirs.toSorted()).toEqual([agentDir, claudeDir].toSorted());
    expect(readFileSync(join(agentDir, "SKILL.md"), "utf-8")).toContain("0.2.22");
    expect(readFileSync(join(claudeDir, "workflows", "Doctor.md"), "utf-8")).toBe("# doctor\n");
  });
});
