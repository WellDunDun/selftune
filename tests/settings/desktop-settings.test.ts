import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadDesktopSettings,
  reconcilePersistedDesktopSchedule,
  updateDesktopSchedule,
  validateScheduleExpression,
} from "../../packages/runtime/desktop-settings.js";
import { detectLocalHarnessConnections } from "../../apps/local/src/harness-registry.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("desktop settings", () => {
  test("derives onboarding completion from config preferences", () => {
    const configDir = temporaryDirectory("selftune-derived-onboarding-");
    const options: Parameters<typeof loadDesktopSettings>[0] = {
      configDir,
      homeDir: temporaryDirectory("selftune-derived-onboarding-home-"),
      platform: "darwin",
      run: () => 1,
      which: () => null,
    };
    expect(loadDesktopSettings(options).onboarding.completed).toBe(false);

    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        preferences: {
          import_sources: {
            claude_code: false,
            cline: false,
            codex: true,
            opencode: false,
            openclaw: false,
            pi: false,
          },
          features: {
            observability: true,
            health_recommendations: false,
            autonomous_improvement: false,
          },
        },
      }),
    );

    const onboarding = loadDesktopSettings(options).onboarding;
    expect(onboarding.completed).toBe(true);
    expect(onboarding.import_sources.codex).toBe(true);
    expect(onboarding.features.health_recommendations).toBe(false);
  });

  test("distinguishes detected harnesses from connected integrations", () => {
    const home = temporaryDirectory("selftune-harnesses-");
    const codexDir = join(home, ".codex");
    const piDir = join(home, ".pi", "extensions", "selftune");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(codexDir, "hooks.json"),
      JSON.stringify({
        hooks: Object.fromEntries(
          ["SessionStart", "PreToolUse", "PostToolUse", "Stop"].map((event) => [
            event,
            [{ hooks: [{ command: "npx -y selftune@latest codex hook" }] }],
          ]),
        ),
      }),
    );
    for (const hook of ["tool_call", "tool_result", "message", "session_shutdown"]) {
      writeFileSync(join(piDir, hook), "# selftune-managed\nnpx selftune pi hook\n");
    }

    const harnesses = detectLocalHarnessConnections({
      homeDir: home,
      which: () => null,
    });
    expect(harnesses.find((harness) => harness.id === "codex")?.status).toBe("connected");
    expect(harnesses.find((harness) => harness.id === "pi")?.status).toBe("connected");
    expect(harnesses.find((harness) => harness.id === "claude_code")?.status).toBe("not_detected");
  });

  test("accepts only schedules supported by launchd and systemd adapters", () => {
    expect(validateScheduleExpression("*/15 * * * *")).toBeNull();
    expect(validateScheduleExpression("0 */4 * * *")).toBeNull();
    expect(validateScheduleExpression("30 9 * * *")).toBeNull();
    expect(validateScheduleExpression("0 9 * * 1")).not.toBeNull();
    expect(validateScheduleExpression("*/90 * * * *")).not.toBeNull();
  });

  test("treats supported session sources as connected import paths", () => {
    const home = temporaryDirectory("selftune-import-sources-");
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    writeFileSync(join(home, ".local", "share", "opencode", "opencode.db"), "");
    mkdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true });

    const harnesses = detectLocalHarnessConnections({
      homeDir: home,
      which: () => null,
    });
    for (const id of ["codex", "opencode", "pi"]) {
      const harness = harnesses.find((entry) => entry.id === id);
      expect(harness?.status).toBe("connected");
      expect(harness?.detail).toBe("Session import available");
    }
  });

  test("does not report a stale launchd artifact as active", () => {
    const home = temporaryDirectory("selftune-existing-schedule-");
    const configDir = temporaryDirectory("selftune-existing-config-");
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "com.selftune.sync.plist"), "<plist />");

    const settings = loadDesktopSettings({
      homeDir: home,
      configDir,
      platform: "darwin",
      run: () => 1,
      userId: 501,
      which: () => null,
    });
    const sync = settings.schedule.jobs.find((job) => job.id === "selftune-sync");
    expect(sync?.active).toBe(false);
    expect(sync?.enabled).toBe(false);
  });

  test("reports launchd jobs active only when the user service is loaded", () => {
    const home = temporaryDirectory("selftune-loaded-schedule-");
    const configDir = temporaryDirectory("selftune-loaded-config-");
    const launchAgents = join(home, "Library", "LaunchAgents");
    const commands: Array<{ command: string; args: string[] }> = [];
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "com.selftune.sync.plist"), "<plist />");

    const settings = loadDesktopSettings({
      homeDir: home,
      configDir,
      platform: "darwin",
      run: (command, args) => {
        commands.push({ command, args });
        return args.at(-1) === "gui/501/com.selftune.sync" ? 0 : 1;
      },
      userId: 501,
      which: () => null,
    });

    expect(settings.schedule.jobs.find((job) => job.id === "selftune-sync")?.active).toBe(true);
    expect(commands).toContainEqual({
      command: "launchctl",
      args: ["print", "gui/501/com.selftune.sync"],
    });
  });

  test("verifies systemd timer state rather than unit-file presence", () => {
    const home = temporaryDirectory("selftune-systemd-schedule-");
    const configDir = temporaryDirectory("selftune-systemd-config-");
    const systemd = join(home, ".config", "systemd", "user");
    mkdirSync(systemd, { recursive: true });
    writeFileSync(join(systemd, "selftune-sync.timer"), "[Timer]");
    writeFileSync(join(systemd, "selftune-sync.service"), "[Service]");

    const inactive = loadDesktopSettings({
      homeDir: home,
      configDir,
      platform: "linux",
      run: () => 1,
      which: () => null,
    });
    expect(inactive.schedule.jobs.find((job) => job.id === "selftune-sync")?.active).toBe(false);

    const active = loadDesktopSettings({
      homeDir: home,
      configDir,
      platform: "linux",
      run: (command, args) =>
        command === "systemctl" && args.join(" ") === "--user is-active --quiet selftune-sync.timer"
          ? 0
          : 1,
      which: () => null,
    });
    expect(active.schedule.jobs.find((job) => job.id === "selftune-sync")?.active).toBe(true);
  });

  test("writes and activates enabled launchd jobs while removing disabled jobs", () => {
    const home = temporaryDirectory("selftune-schedule-home-");
    const configDir = temporaryDirectory("selftune-schedule-config-");
    const commands: Array<{ command: string; args: string[] }> = [];

    const result = updateDesktopSchedule(
      {
        jobs: [
          { id: "selftune-sync", enabled: true, schedule: "*/15 * * * *" },
          { id: "selftune-status", enabled: false, schedule: "0 8 * * *" },
          {
            id: "selftune-orchestrate",
            enabled: true,
            schedule: "0 */4 * * *",
          },
        ],
      },
      {
        homeDir: home,
        configDir,
        platform: "darwin",
        binPath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune-cli",
        userId: 501,
        which: () => null,
        run: (command, args) => {
          commands.push({ command, args });
          return 0;
        },
      },
    );

    expect(result.schedule.jobs.find((job) => job.id === "selftune-sync")?.active).toBe(true);
    expect(result.schedule.jobs.find((job) => job.id === "selftune-status")?.active).toBe(false);
    const plist = readFileSync(
      join(home, "Library", "LaunchAgents", "com.selftune.sync.plist"),
      "utf8",
    );
    expect(plist).toContain("<integer>900</integer>");
    expect(plist).toContain("selftune-cli");
    expect(commands).toContainEqual({
      command: "launchctl",
      args: [
        "bootstrap",
        "gui/501",
        join(home, "Library", "LaunchAgents", "com.selftune.sync.plist"),
      ],
    });
    expect(commands).toContainEqual({
      command: "launchctl",
      args: ["print", "gui/501/com.selftune.sync"],
    });
    expect(commands).toContainEqual({
      command: "launchctl",
      args: ["disable", "gui/501/com.selftune.status"],
    });
    expect(commands.some((entry) => entry.args[0] === "kickstart")).toBe(false);

    const reloaded = loadDesktopSettings({
      homeDir: home,
      configDir,
      platform: "darwin",
      which: () => null,
    });
    expect(reloaded.schedule.jobs.find((job) => job.id === "selftune-sync")?.schedule).toBe(
      "*/15 * * * *",
    );
  });

  test("quotes packaged task CLI paths that contain spaces", () => {
    const home = temporaryDirectory("selftune-spaced-app-home-");
    const configDir = temporaryDirectory("selftune-spaced-app-config-");
    updateDesktopSchedule(
      {
        jobs: [
          { id: "selftune-sync", enabled: true, schedule: "*/30 * * * *" },
          { id: "selftune-status", enabled: true, schedule: "0 8 * * *" },
          {
            id: "selftune-orchestrate",
            enabled: false,
            schedule: "0 */2 * * *",
          },
        ],
      },
      {
        homeDir: home,
        configDir,
        platform: "darwin",
        binPath: "/Volumes/SelfTune Preview/SelfTune.app/Contents/Resources/selftune/selftune-cli",
        which: () => null,
        run: () => 0,
      },
    );

    const syncPlist = readFileSync(
      join(home, "Library", "LaunchAgents", "com.selftune.sync.plist"),
      "utf8",
    );
    const statusPlist = readFileSync(
      join(home, "Library", "LaunchAgents", "com.selftune.status.plist"),
      "utf8",
    );
    expect(syncPlist).toContain("<string>/bin/sh</string>");
    expect(syncPlist).toContain("&apos;/Volumes/SelfTune Preview/SelfTune.app");
    expect(statusPlist).toContain("&amp;&amp;");
  });

  test("restores enabled persisted jobs when the native scheduler lost them", () => {
    const home = temporaryDirectory("selftune-reconcile-home-");
    const configDir = temporaryDirectory("selftune-reconcile-config-");
    const plist = join(home, "Library", "LaunchAgents", "com.selftune.sync.plist");
    updateDesktopSchedule(
      {
        jobs: [
          { id: "selftune-sync", enabled: true, schedule: "*/30 * * * *" },
          { id: "selftune-status", enabled: false, schedule: "0 8 * * *" },
          {
            id: "selftune-orchestrate",
            enabled: false,
            schedule: "0 */2 * * *",
          },
        ],
      },
      {
        homeDir: home,
        configDir,
        platform: "darwin",
        binPath: "/bin/selftune",
        userId: 501,
        run: () => 0,
      },
    );
    rmSync(plist);
    const commands: Array<{ command: string; args: string[] }> = [];

    expect(
      reconcilePersistedDesktopSchedule({
        homeDir: home,
        configDir,
        platform: "darwin",
        binPath: "/bin/selftune",
        userId: 501,
        run: (command, args) => {
          commands.push({ command, args });
          return 0;
        },
      }),
    ).toBe(true);
    expect(readFileSync(plist, "utf8")).toContain("<integer>1800</integer>");
    expect(commands).toContainEqual({
      command: "launchctl",
      args: ["bootstrap", "gui/501", plist],
    });
    expect(commands).toContainEqual({
      command: "launchctl",
      args: ["print", "gui/501/com.selftune.sync"],
    });
  });

  test("rejects launchd activation when bootstrap appears successful but the job is absent", () => {
    const home = temporaryDirectory("selftune-launchd-verification-home-");
    const configDir = temporaryDirectory("selftune-launchd-verification-config-");

    expect(() =>
      updateDesktopSchedule(
        {
          jobs: [
            { id: "selftune-sync", enabled: true, schedule: "*/30 * * * *" },
            { id: "selftune-status", enabled: false, schedule: "0 8 * * *" },
            { id: "selftune-orchestrate", enabled: false, schedule: "0 */2 * * *" },
          ],
        },
        {
          homeDir: home,
          configDir,
          platform: "darwin",
          binPath: "/bin/selftune",
          userId: 501,
          run: (_command, args) => (args[0] === "print" ? 1 : 0),
        },
      ),
    ).toThrow("Could not activate Sync telemetry.");
  });

  test("rejects launchd activation when bootstrap fails", () => {
    const home = temporaryDirectory("selftune-launchd-bootstrap-home-");
    const configDir = temporaryDirectory("selftune-launchd-bootstrap-config-");

    expect(() =>
      updateDesktopSchedule(
        {
          jobs: [
            { id: "selftune-sync", enabled: true, schedule: "*/30 * * * *" },
            { id: "selftune-status", enabled: false, schedule: "0 8 * * *" },
            { id: "selftune-orchestrate", enabled: false, schedule: "0 */2 * * *" },
          ],
        },
        {
          homeDir: home,
          configDir,
          platform: "darwin",
          binPath: "/bin/selftune",
          userId: 501,
          run: (_command, args) => (args[0] === "bootstrap" ? 1 : 0),
        },
      ),
    ).toThrow("Could not activate Sync telemetry.");
  });
});
