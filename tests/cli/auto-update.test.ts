import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkForUpdates,
  compareVersions,
  getCachedUpdateStatus,
  getInstalledSkillDirs,
  getSelftuneUpdateHint,
  isAutoUpdateSkipped,
  resolveSelftuneUpdateCommand,
  resolveUpdateChannel,
  syncInstalledSkillFiles,
} from "../../packages/runtime/auto-update.js";

const originalEnv = { ...process.env };
let tmpDir = "";

beforeEach(() => {
  delete process.env.SELFTUNE_SKIP_AUTO_UPDATE;
  delete process.env.SELFTUNE_SKIP_UPDATE_CHECK;
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-auto-update-"));
});

afterEach(() => {
  process.env = { ...originalEnv };
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
    await checkForUpdates({ fetchDistTags: fetchMock });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("update channels and SemVer precedence", () => {
  test("selects beta only for beta prereleases", () => {
    expect(resolveUpdateChannel("2.0.0")).toBe("latest");
    expect(resolveUpdateChannel("2.0.0-beta.3")).toBe("beta");
    expect(resolveUpdateChannel("2.0.0-dev.7")).toBe("latest");
  });

  test("orders beta progression and prerelease promotion", () => {
    expect(compareVersions("2.0.0-beta.2", "2.0.0-beta.10")).toBe(-1);
    expect(compareVersions("2.0.0-beta.10", "2.0.0-beta.2")).toBe(1);
    expect(compareVersions("2.0.0-beta.10", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "2.0.0-beta.10")).toBe(1);
    expect(compareVersions("2.0.0+build.1", "2.0.0+build.2")).toBe(0);
  });

  test("returns no ordering for invalid versions", () => {
    expect(compareVersions("development", "2.0.0")).toBeNull();
    expect(compareVersions("2.0", "2.0.0")).toBeNull();
    expect(compareVersions("2.0.0; install attacker", "2.0.0")).toBeNull();
  });
});

describe("advisory update checks", () => {
  test("caches and reports an update without spawning an installer", async () => {
    const cachePath = join(tmpDir, "state", "update-check.json");
    const fetchDistTags = mock(async () => ({
      json: async () => ({ latest: "2.0.0", beta: "2.1.0-beta.1" }),
      ok: true,
    }));
    const notify = mock((_message: string) => undefined);
    const syncSkills = mock(() => []);
    let now = 1_800_000_000_000;
    const options = {
      cachePath,
      currentVersion: "1.0.0",
      fetchDistTags,
      homeDir: tmpDir,
      moduleDir: join(
        tmpDir,
        ".bun",
        "install",
        "global",
        "node_modules",
        "selftune",
        "cli",
        "selftune",
      ),
      now: () => now,
      notify,
      syncSkills,
    };

    await checkForUpdates(options);

    expect(fetchDistTags).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "[selftune] Update available: v1.0.0 -> v2.0.0. Run: bun add -g selftune@2.0.0",
    );
    expect(syncSkills).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({
      channel: "latest",
      lastCheck: now,
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
    });
    expect(getCachedUpdateStatus(options)).toMatchObject({
      checkedAt: now,
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      updateAvailable: true,
      autoUpdateSupported: false,
      updateHint: "bun add -g selftune@2.0.0",
    });

    await checkForUpdates(options);
    expect(fetchDistTags).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);

    now += 60 * 60 * 1000;
    await checkForUpdates(options);
    expect(fetchDistTags).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test("keeps skill files synchronized when the cached install is current", async () => {
    const cachePath = join(tmpDir, "update-check.json");
    const fetchDistTags = mock(async () => ({
      json: async () => ({ latest: "1.0.0" }),
      ok: true,
    }));
    const notify = mock((_message: string) => undefined);
    const syncSkills = mock(() => []);
    const options = {
      cachePath,
      currentVersion: "1.0.0",
      fetchDistTags,
      now: () => 1_800_000_000_000,
      notify,
      syncSkills,
    };

    await checkForUpdates(options);
    await checkForUpdates(options);

    expect(fetchDistTags).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(syncSkills).toHaveBeenCalledTimes(2);
  });

  test("follows beta progression and preserves an exact beta update hint", async () => {
    const cachePath = join(tmpDir, "update-check.json");
    const notify = mock((_message: string) => undefined);

    await checkForUpdates({
      cachePath,
      currentVersion: "2.0.0-beta.2",
      fetchDistTags: async () => ({
        json: async () => ({ latest: "1.9.0", beta: "2.0.0-beta.10" }),
        ok: true,
      }),
      homeDir: tmpDir,
      moduleDir: join(
        tmpDir,
        ".bun",
        "install",
        "global",
        "node_modules",
        "selftune",
        "cli",
        "selftune",
      ),
      now: () => 1_800_000_000_000,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(
      "[selftune] Update available: v2.0.0-beta.2 -> v2.0.0-beta.10. Run: bun add -g selftune@2.0.0-beta.10",
    );
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toMatchObject({
      channel: "beta",
      currentVersion: "2.0.0-beta.2",
      latestVersion: "2.0.0-beta.10",
    });
    expect(
      getCachedUpdateStatus({
        cachePath,
        currentVersion: "2.0.0-beta.2",
        homeDir: tmpDir,
        moduleDir: join(
          tmpDir,
          ".bun",
          "install",
          "global",
          "node_modules",
          "selftune",
          "cli",
          "selftune",
        ),
      }),
    ).toMatchObject({
      latestVersion: "2.0.0-beta.10",
      updateAvailable: true,
      updateHint: "bun add -g selftune@2.0.0-beta.10",
    });
  });

  test("routes a current dev prerelease through latest", async () => {
    const cachePath = join(tmpDir, "update-check.json");
    const notify = mock((_message: string) => undefined);

    await checkForUpdates({
      cachePath,
      currentVersion: "2.0.0-dev.7",
      fetchDistTags: async () => ({
        json: async () => ({ latest: "2.0.0", beta: "2.1.0-beta.1" }),
        ok: true,
      }),
      now: () => 1_800_000_000_000,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(
      "[selftune] Update available: v2.0.0-dev.7 -> v2.0.0. Run: npx skills add selftune-dev/selftune",
    );
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toMatchObject({
      channel: "latest",
      currentVersion: "2.0.0-dev.7",
      latestVersion: "2.0.0",
    });
  });

  test("keeps a fresh outdated cache silent", async () => {
    const cachePath = join(tmpDir, "update-check.json");
    const now = 1_800_000_000_000;
    writeFileSync(
      cachePath,
      JSON.stringify({
        channel: "latest",
        lastCheck: now - 1,
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
      }),
    );
    const fetchDistTags = mock(async () => ({
      json: async () => ({ latest: "2.0.0" }),
      ok: true,
    }));
    const notify = mock((_message: string) => undefined);
    const syncSkills = mock(() => []);

    await checkForUpdates({
      cachePath,
      currentVersion: "1.0.0",
      fetchDistTags,
      now: () => now,
      notify,
      syncSkills,
    });

    expect(fetchDistTags).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(syncSkills).not.toHaveBeenCalled();
  });

  test("treats malformed cache records as absent", () => {
    const cachePath = join(tmpDir, "update-check.json");
    const malformedRecords: ReadonlyArray<unknown> = [
      null,
      {},
      {
        channel: "latest",
        lastCheck: "recent",
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
      },
      {
        channel: "latest",
        lastCheck: 1_800_000_000_000,
        currentVersion: 1,
        latestVersion: "2.0.0",
      },
      {
        channel: "latest",
        lastCheck: 1_800_000_000_000,
        currentVersion: "1.0.0",
        latestVersion: 2,
      },
      {
        channel: "latest",
        lastCheck: 1_800_000_000_000,
        currentVersion: "1.0.0",
        latestVersion: "2.0.0-beta.1",
      },
    ];

    for (const record of malformedRecords) {
      writeFileSync(cachePath, JSON.stringify(record));
      expect(getCachedUpdateStatus({ cachePath, currentVersion: "1.0.0" })).toMatchObject({
        checkedAt: null,
        latestVersion: null,
        updateAvailable: false,
        updateHint: null,
      });
    }
  });

  test("validates both registry dist-tags and the beta channel", async () => {
    const notify = mock((_message: string) => undefined);
    const syncSkills = mock(() => []);
    const scenarios = [
      {
        currentVersion: "1.0.0",
        tags: { latest: "999.0.0; npm install -g attacker", beta: "2.0.0-beta.1" },
      },
      {
        currentVersion: "1.0.0-beta.1",
        tags: { latest: "2.0.0", beta: "2.0.0" },
      },
    ];

    await Promise.all(
      scenarios.map(async ({ currentVersion, tags }, index) => {
        const cachePath = join(tmpDir, `update-check-${index}.json`);
        await checkForUpdates({
          cachePath,
          currentVersion,
          fetchDistTags: async () => ({
            json: async () => tags,
            ok: true,
          }),
          now: () => 1_800_000_000_000,
          notify,
          syncSkills,
        });

        expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toMatchObject({
          latestVersion: "",
        });
        expect(getCachedUpdateStatus({ cachePath, currentVersion })).toMatchObject({
          latestVersion: null,
          updateAvailable: false,
          updateHint: null,
        });
      }),
    );

    expect(notify).not.toHaveBeenCalled();
    expect(syncSkills).not.toHaveBeenCalled();
  });

  test.each([
    { label: "null", tags: null },
    { label: "array", tags: ["2.0.0"] },
    { label: "string", tags: "2.0.0" },
    { label: "numeric tag", tags: { latest: 2 } },
    { label: "nested tag", tags: { latest: { version: "2.0.0" } } },
  ])("ignores malformed registry $label without syncing or notifying", async ({ tags }) => {
    const cachePath = join(tmpDir, "update-check.json");
    const notify = mock((_message: string) => undefined);
    const syncSkills = mock(() => []);
    await checkForUpdates({
      cachePath,
      currentVersion: "1.0.0",
      fetchDistTags: async () => ({ ok: true, json: async () => tags }),
      notify,
      syncSkills,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(syncSkills).not.toHaveBeenCalled();
    expect(getCachedUpdateStatus({ cachePath, currentVersion: "1.0.0" })).toMatchObject({
      latestVersion: null,
      updateAvailable: false,
    });
  });

  test.each([
    { currentVersion: "1.0.0", tags: { latest: " 2.0.0 ", beta: 42 }, expected: "2.0.0" },
    {
      currentVersion: "1.0.0-beta.1",
      tags: { latest: null, beta: "2.0.0-beta.2" },
      expected: "2.0.0-beta.2",
    },
  ])(
    "preserves the valid channel beside malformed tags for $currentVersion",
    async ({ currentVersion, tags, expected }) => {
      const cachePath = join(tmpDir, "update-check.json");
      const notify = mock((_message: string) => undefined);
      await checkForUpdates({
        cachePath,
        currentVersion,
        fetchDistTags: async () => ({ ok: true, json: async () => tags }),
        notify,
      });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(getCachedUpdateStatus({ cachePath, currentVersion })).toMatchObject({
        latestVersion: expected,
        updateAvailable: true,
      });
    },
  );

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid cached timestamps: %s",
    (lastCheck) => {
      const cachePath = join(tmpDir, "update-check.json");
      writeFileSync(
        cachePath,
        JSON.stringify({
          channel: "latest",
          lastCheck,
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
        }),
      );
      expect(getCachedUpdateStatus({ cachePath, currentVersion: "1.0.0" })).toMatchObject({
        checkedAt: null,
        latestVersion: null,
        updateAvailable: false,
      });
    },
  );

  test("keeps the abort timeout active while parsing the registry body", async () => {
    const cachePath = join(tmpDir, "update-check.json");
    const observedSignals: AbortSignal[] = [];

    await checkForUpdates({
      cachePath,
      currentVersion: "1.0.0",
      fetchDistTags: async (signal) => {
        observedSignals.push(signal);
        return {
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              const rejectAborted = () => reject(new Error("registry body aborted"));
              if (signal.aborted) rejectAborted();
              else signal.addEventListener("abort", rejectAborted, { once: true });
            }),
          ok: true,
        };
      },
      now: () => 1_800_000_000_000,
      timeoutMs: 10,
    });

    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toMatchObject({ latestVersion: "" });
  });

  test("retries negative results after five minutes", async () => {
    const cachePath = join(tmpDir, "update-check.json");
    let now = 1_800_000_000_000;
    let attempts = 0;
    const fetchDistTags = mock(async () => {
      attempts += 1;
      return attempts === 1
        ? { json: async () => ({}), ok: false }
        : { json: async () => ({ latest: "1.0.0" }), ok: true };
    });
    const options = {
      cachePath,
      currentVersion: "1.0.0",
      fetchDistTags,
      now: () => now,
      syncSkills: () => [],
    };

    await checkForUpdates(options);
    now += 4 * 60 * 1000;
    await checkForUpdates(options);
    expect(fetchDistTags).toHaveBeenCalledTimes(1);

    now += 60 * 1000;
    await checkForUpdates(options);
    expect(fetchDistTags).toHaveBeenCalledTimes(2);
  });

  test("does not trust a cache timestamp from the future", async () => {
    const cachePath = join(tmpDir, "update-check.json");
    const now = 1_800_000_000_000;
    writeFileSync(
      cachePath,
      JSON.stringify({
        channel: "latest",
        lastCheck: now + 60 * 60 * 1000,
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
      }),
    );
    const fetchDistTags = mock(async () => ({
      json: async () => ({ latest: "1.0.0" }),
      ok: true,
    }));

    await checkForUpdates({
      cachePath,
      currentVersion: "1.0.0",
      fetchDistTags,
      now: () => now,
      syncSkills: () => [],
    });

    expect(fetchDistTags).toHaveBeenCalledTimes(1);
  });

  test("contains no implicit child-process update path", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "packages", "runtime", "auto-update.ts"),
      "utf-8",
    );

    expect(source).not.toContain('from "node:child_process"');
    expect(source).not.toContain("spawnSync(");
    expect(source).not.toContain("performUpdate");
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
