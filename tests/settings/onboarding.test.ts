import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDesktopOnboarding,
  loadDesktopSettingsWithMigration,
} from "../../packages/orchestration/src/desktop-onboarding.js";
import {
  buildPackagedClaudeHookCommand,
  installPackagedClaudeHooks,
} from "../../packages/runtime/desktop-claude-hooks.js";
import {
  loadOnboardingPreferences,
  normalizeOnboardingRequest,
} from "../../packages/runtime/onboarding-preferences.js";
import { detectLocalHarnessConnections } from "../../apps/local/src/harness-registry.js";
import { createDefaultSyncOptions } from "@selftune/orchestration/sync";
import { createDefaultCliSetupCapabilities } from "@selftune/orchestration/setup/capabilities";
import { convergeSetup } from "@selftune/orchestration/setup/converge";
import { defaultSetupPlan } from "@selftune/orchestration/setup/plan";
import type { SyncResult } from "@selftune/source-management/sync";
import { isSelftuneCommand } from "../../packages/runtime/utils/hooks.js";

const temporaryDirectories: string[] = [];
const originalConfigDir = process.env.SELFTUNE_CONFIG_DIR;

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function syncResult(synced: number): SyncResult {
  const source = { available: true, scanned: synced, synced, skipped: 0 };
  return {
    since: null,
    dry_run: false,
    sources: {
      claude: source,
      codex: { ...source, synced: 0 },
      opencode: { ...source, synced: 0 },
      openclaw: { ...source, synced: 0 },
      pi: { ...source, synced: 0 },
    },
    repair: {
      ran: true,
      repaired_sessions: 0,
      repaired_records: 0,
      codex_repaired_records: 0,
    },
    creator_contributions: {
      ran: false,
      eligible_skills: 0,
      built_signals: 0,
      staged_signals: 0,
    },
    timings: [],
    total_elapsed_ms: 0,
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
  if (originalConfigDir === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
  else process.env.SELFTUNE_CONFIG_DIR = originalConfigDir;
});

describe("desktop onboarding", () => {
  test("settings read migrates a desktop-only onboarding file without config", async () => {
    const home = temporaryDirectory("selftune-settings-migration-home-");
    const configDir = temporaryDirectory("selftune-settings-migration-config-");
    writeFileSync(
      join(configDir, "onboarding.json"),
      JSON.stringify({
        version: 1,
        completed: true,
        import_sources: { codex: true },
        features: {
          observability: false,
          health_recommendations: true,
          autonomous_improvement: false,
        },
      }),
    );

    const settings = await loadDesktopSettingsWithMigration({
      homeDir: home,
      configDir,
      platform: "darwin",
      binPath: "/tmp/selftune",
      run: () => 1,
      which: () => null,
    });

    expect(settings.onboarding.completed).toBe(true);
    expect(settings.onboarding.import_sources.codex).toBe(true);
    expect(existsSync(join(configDir, "config.json"))).toBe(true);
    expect(existsSync(join(configDir, "onboarding.json"))).toBe(false);
  });

  test("rejects unknown import sources and unsupported hook harnesses", () => {
    expect(() =>
      normalizeOnboardingRequest({
        import_sources: ["unknown"],
        hook_harnesses: [],
        features: {
          observability: true,
          health_recommendations: true,
          autonomous_improvement: false,
        },
      }),
    ).toThrow("unknown import source");
    expect(() =>
      normalizeOnboardingRequest({
        import_sources: [],
        hook_harnesses: ["openclaw"],
        features: {
          observability: true,
          health_recommendations: true,
          autonomous_improvement: false,
        },
      }),
    ).toThrow("does not support hooks");
  });

  test("applies hook selections and maps features to native jobs", async () => {
    const home = temporaryDirectory("selftune-onboarding-home-");
    const configDir = temporaryDirectory("selftune-onboarding-config-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    const installed: string[] = [];

    const result = await applyDesktopOnboarding(
      {
        import_sources: ["claude_code", "codex"],
        hook_harnesses: ["claude_code", "codex"],
        features: {
          observability: true,
          health_recommendations: true,
          autonomous_improvement: false,
        },
      },
      {
        homeDir: home,
        configDir,
        platform: "darwin",
        binPath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
        which: (command) => (command === "claude" || command === "codex" ? command : null),
        loadHarnessConnections: () =>
          detectLocalHarnessConnections({
            homeDir: home,
            which: (command) => (command === "claude" || command === "codex" ? command : null),
          }),
        run: () => 0,
        installHarness: (harnessId) => {
          installed.push(harnessId);
          return { ok: true, changed: true, message: `${harnessId} installed` };
        },
        sourceSync: async () => syncResult(0),
      },
    );

    expect(installed).toEqual(["claude_code", "codex"]);
    expect(result.onboarding.completed).toBe(true);
    expect(result.onboarding.import_sources.opencode).toBe(false);
    expect(result.schedule.jobs.find((job) => job.id === "selftune-sync")?.enabled).toBe(true);
    expect(result.schedule.jobs.find((job) => job.id === "selftune-status")?.enabled).toBe(true);
    expect(result.schedule.jobs.find((job) => job.id === "selftune-orchestrate")?.enabled).toBe(
      false,
    );
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.selftune.sync.plist"))).toBe(true);
    expect(
      existsSync(join(home, "Library", "LaunchAgents", "com.selftune.orchestrate.plist")),
    ).toBe(false);
  });

  test("processes selected history before onboarding completes", async () => {
    const home = temporaryDirectory("selftune-onboarding-sync-home-");
    const configDir = temporaryDirectory("selftune-onboarding-sync-config-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    let syncCalls = 0;

    const result = await applyDesktopOnboarding(
      {
        import_sources: ["claude_code"],
        hook_harnesses: [],
        features: {
          observability: true,
          health_recommendations: true,
          autonomous_improvement: false,
        },
      },
      {
        homeDir: home,
        configDir,
        platform: "darwin",
        binPath: "/tmp/selftune",
        which: () => null,
        run: () => 0,
        sourceSync: async () => {
          syncCalls += 1;
          return syncResult(4);
        },
      },
    );

    expect(syncCalls).toBe(1);
    expect(result.source_sync).toEqual({ status: "processed", message: null });
  });

  test("saved import choices become the defaults for every sync path", async () => {
    const configDir = temporaryDirectory("selftune-sync-preferences-");
    process.env.SELFTUNE_CONFIG_DIR = configDir;
    await applyDesktopOnboarding(
      {
        import_sources: ["codex", "pi"],
        hook_harnesses: [],
        features: {
          observability: false,
          health_recommendations: false,
          autonomous_improvement: false,
        },
      },
      {
        homeDir: temporaryDirectory("selftune-sync-home-"),
        configDir,
        platform: "darwin",
        binPath: "/tmp/selftune",
        which: () => null,
        run: () => 0,
        sourceSync: async () => syncResult(0),
      },
    );

    const preferences = loadOnboardingPreferences(configDir);
    const syncOptions = createDefaultSyncOptions();
    expect(preferences.import_sources).toEqual({
      claude_code: false,
      cline: false,
      codex: true,
      opencode: false,
      openclaw: false,
      pi: true,
    });
    expect(syncOptions.syncClaude).toBe(false);
    expect(syncOptions.syncCodex).toBe(true);
    expect(syncOptions.syncOpenCode).toBe(false);
    expect(syncOptions.syncOpenClaw).toBe(false);
    expect(syncOptions.syncPi).toBe(true);
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).preferences).toEqual({
      import_sources: preferences.import_sources,
      features: preferences.features,
    });
    expect(existsSync(join(configDir, "onboarding.json"))).toBe(false);
  });

  test("maps convergence outcomes to the stable install result statuses", async () => {
    const home = temporaryDirectory("selftune-onboarding-status-home-");
    const configDir = temporaryDirectory("selftune-onboarding-status-config-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    writeFileSync(join(home, ".local", "share", "opencode", "opencode.db"), "");
    const connections = () =>
      detectLocalHarnessConnections({
        homeDir: home,
        which: (command) =>
          command === "claude" || command === "codex" || command === "opencode" ? command : null,
      });

    const result = await applyDesktopOnboarding(
      {
        import_sources: ["claude_code", "codex", "opencode"],
        hook_harnesses: ["claude_code", "codex", "opencode"],
        features: {
          observability: false,
          health_recommendations: false,
          autonomous_improvement: false,
        },
      },
      {
        homeDir: home,
        configDir,
        platform: "darwin",
        binPath: "/tmp/selftune",
        loadHarnessConnections: connections,
        run: () => 0,
        installHarness: (harnessId) =>
          harnessId === "claude_code"
            ? { ok: true, changed: true, message: "installed" }
            : harnessId === "codex"
              ? { ok: true, changed: false, message: "already current" }
              : { ok: false, changed: false, message: "installer failed" },
        sourceSync: async () => syncResult(0),
      },
    );

    expect(result.install_results).toEqual([
      { harness_id: "claude_code", status: "installed", message: "installed" },
      { harness_id: "codex", status: "already_installed", message: "already current" },
      { harness_id: "opencode", status: "failed", message: "installer failed" },
    ]);
  });

  test("desktop and CLI convergence produce identical hook state for equivalent choices", async () => {
    const cliHome = temporaryDirectory("selftune-cli-hook-parity-");
    const desktopHome = temporaryDirectory("selftune-desktop-hook-parity-");
    const cliConfigDir = temporaryDirectory("selftune-cli-hook-config-");
    const desktopConfigDir = temporaryDirectory("selftune-desktop-hook-config-");
    mkdirSync(join(cliHome, ".claude"), { recursive: true });
    mkdirSync(join(desktopHome, ".claude"), { recursive: true });
    const cliPath = "/tmp/selftune";
    const cliCapabilities = createDefaultCliSetupCapabilities({ homeDir: cliHome });
    const desktopHookCapabilities = createDefaultCliSetupCapabilities({ homeDir: desktopHome });

    await convergeSetup(
      defaultSetupPlan({
        agentOverride: "claude_code",
        cliPathOverride: cliPath,
        hookHarnesses: ["claude_code"],
      }),
      cliCapabilities,
      {
        configDir: cliConfigDir,
        homeDir: cliHome,
        which: (command) => (command === "claude" ? command : null),
      },
    );
    await applyDesktopOnboarding(
      {
        import_sources: ["claude_code"],
        hook_harnesses: ["claude_code"],
        features: {
          observability: false,
          health_recommendations: false,
          autonomous_improvement: false,
        },
      },
      {
        homeDir: desktopHome,
        configDir: desktopConfigDir,
        platform: "darwin",
        binPath: cliPath,
        which: (command) => (command === "claude" ? command : null),
        loadHarnessConnections: () =>
          detectLocalHarnessConnections({
            homeDir: desktopHome,
            which: (command) => (command === "claude" ? command : null),
          }),
        run: () => 0,
        installHarness: (_harnessId, binPath) => {
          const installer = desktopHookCapabilities.hooks.claude_code;
          if (!installer) throw new Error("Claude Code installer is unavailable.");
          return installer({ homeDir: desktopHome, cliPath: binPath });
        },
        sourceSync: async () => syncResult(0),
      },
    );

    expect(readFileSync(join(desktopHome, ".claude", "settings.json"), "utf8")).toBe(
      readFileSync(join(cliHome, ".claude", "settings.json"), "utf8"),
    );
  });

  test("packaged Claude reconciliation replaces managed commands and preserves other hooks", () => {
    const root = temporaryDirectory("selftune-packaged-claude-");
    const settingsPath = join(root, "settings.json");
    const snippetPath = join(root, "settings-snippet.json");
    const executablePath = join(
      root,
      "SelfTune Preview.app",
      "Contents",
      "Resources",
      "selftune",
      "selftune",
    );
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ command: "notify-send done" }] },
            {
              hooks: [
                {
                  command: "node /old/bin/run-hook.cjs /old/cli/selftune/hooks/session-stop.ts",
                },
              ],
            },
          ],
        },
      }),
    );
    writeFileSync(
      snippetPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  command:
                    "bun /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
                },
              ],
            },
          ],
        },
      }),
    );

    expect(
      installPackagedClaudeHooks({
        settingsPath,
        snippetPath,
        executablePath,
        platform: "darwin",
      }),
    ).toEqual(["Stop"]);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(JSON.stringify(settings)).toContain("notify-send done");
    expect(JSON.stringify(settings)).toContain(`'${executablePath}' hook session-stop`);
    expect(JSON.stringify(settings)).not.toContain("/old/bin/run-hook.cjs");
    expect(
      installPackagedClaudeHooks({
        settingsPath,
        snippetPath,
        executablePath,
        platform: "darwin",
      }),
    ).toEqual([]);
  });

  test("builds target-aware stable executable commands", () => {
    const posix = buildPackagedClaudeHookCommand(
      "/Applications/Daniel's SelfTune/SelfTune.app/Contents/Resources/selftune/selftune",
      "prompt-log",
      "darwin",
    );
    const windows = buildPackagedClaudeHookCommand(
      "C:\\Program Files\\SelfTune\\selftune.exe",
      "commit-track",
      "win32",
    );

    expect(posix).toBe(
      `'/Applications/Daniel'"'"'s SelfTune/SelfTune.app/Contents/Resources/selftune/selftune' hook prompt-log`,
    );
    expect(windows).toBe('"C:\\Program Files\\SelfTune\\selftune.exe" hook commit-track');
    expect(isSelftuneCommand(posix)).toBe(true);
    expect(isSelftuneCommand(windows)).toBe(true);
    expect(isSelftuneCommand('echo "selftune hook prompt-log"')).toBe(false);
  });

  test("detects stable executable commands as installed Claude hooks", () => {
    const home = temporaryDirectory("selftune-stable-hook-detection-");
    const claudeDir = join(home, ".claude");
    const executablePath = "/Applications/SelfTune.app/Contents/Resources/selftune/selftune";
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  command: buildPackagedClaudeHookCommand(executablePath, "prompt-log", "darwin"),
                },
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                {
                  command: buildPackagedClaudeHookCommand(
                    executablePath,
                    "evolution-guard",
                    "darwin",
                  ),
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  command: buildPackagedClaudeHookCommand(executablePath, "skill-eval", "darwin"),
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  command: buildPackagedClaudeHookCommand(executablePath, "session-stop", "darwin"),
                },
              ],
            },
          ],
        },
      }),
    );

    const claude = detectLocalHarnessConnections({ homeDir: home, which: () => null }).find(
      (harness) => harness.id === "claude_code",
    );
    expect(claude?.hooks_installed).toBe(true);
    expect(claude?.status).toBe("connected");
  });

  test("reconciles selected hooks even when an older integration is already detected", async () => {
    const home = temporaryDirectory("selftune-existing-hook-home-");
    const configDir = temporaryDirectory("selftune-existing-hook-config-");
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: Object.fromEntries(
          ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].map((event) => [
            event,
            [
              {
                hooks: [
                  {
                    command:
                      "node /old/selftune/bin/run-hook.cjs /old/selftune/cli/selftune/hooks/prompt-log.ts",
                  },
                ],
              },
            ],
          ]),
        ),
      }),
    );
    let installs = 0;

    const result = await applyDesktopOnboarding(
      {
        import_sources: ["claude_code"],
        hook_harnesses: ["claude_code"],
        features: {
          observability: false,
          health_recommendations: false,
          autonomous_improvement: false,
        },
      },
      {
        homeDir: home,
        configDir,
        platform: "darwin",
        binPath: "/tmp/selftune",
        which: () => "claude",
        loadHarnessConnections: () =>
          detectLocalHarnessConnections({ homeDir: home, which: () => "claude" }),
        run: () => 0,
        installHarness: () => {
          installs += 1;
          return { ok: true, changed: false, message: "reconciled" };
        },
        sourceSync: async () => syncResult(0),
      },
    );

    expect(installs).toBe(1);
    expect(result.install_results[0]?.status).toBe("already_installed");
  });
});
