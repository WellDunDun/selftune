import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyDesktopOnboarding } from "../../packages/runtime/desktop-onboarding.js";
import {
  buildPackagedClaudeHookCommand,
  installPackagedClaudeHooks,
} from "../../packages/runtime/desktop-claude-hooks.js";
import {
  loadOnboardingPreferences,
  normalizeOnboardingRequest,
} from "../../packages/runtime/onboarding-preferences.js";
import { detectHarnessConnections } from "../../packages/runtime/desktop-settings.js";
import { createDefaultSyncOptions } from "@selftune/orchestration/sync";
import { isSelftuneCommand } from "../../packages/runtime/utils/hooks.js";

const temporaryDirectories: string[] = [];
const originalConfigDir = process.env.SELFTUNE_CONFIG_DIR;

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
  if (originalConfigDir === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
  else process.env.SELFTUNE_CONFIG_DIR = originalConfigDir;
});

describe("desktop onboarding", () => {
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

  test("applies hook selections and maps features to native jobs", () => {
    const home = temporaryDirectory("selftune-onboarding-home-");
    const configDir = temporaryDirectory("selftune-onboarding-config-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    const installed: string[] = [];

    const result = applyDesktopOnboarding(
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
        run: () => 0,
        installHarness: (harnessId) => {
          installed.push(harnessId);
          return { ok: true, message: `${harnessId} installed` };
        },
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

  test("saved import choices become the defaults for every sync path", () => {
    const configDir = temporaryDirectory("selftune-sync-preferences-");
    process.env.SELFTUNE_CONFIG_DIR = configDir;
    applyDesktopOnboarding(
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
      },
    );

    const preferences = loadOnboardingPreferences(configDir);
    const syncOptions = createDefaultSyncOptions();
    expect(preferences.import_sources).toEqual({
      claude_code: false,
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
    expect(JSON.parse(readFileSync(join(configDir, "onboarding.json"), "utf8")).completed).toBe(
      true,
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
                    "node /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
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

    const claude = detectHarnessConnections({ homeDir: home, which: () => null }).find(
      (harness) => harness.id === "claude_code",
    );
    expect(claude?.hooks_installed).toBe(true);
    expect(claude?.status).toBe("connected");
  });

  test("reconciles selected hooks even when an older integration is already detected", () => {
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

    const result = applyDesktopOnboarding(
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
        run: () => 0,
        installHarness: () => {
          installs += 1;
          return { ok: true, message: "reconciled" };
        },
      },
    );

    expect(installs).toBe(1);
    expect(result.install_results[0]?.status).toBe("already_installed");
  });
});
