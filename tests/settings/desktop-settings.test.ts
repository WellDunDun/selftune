import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectHarnessConnections,
  loadDesktopSettings,
  updateDesktopSchedule,
  validateScheduleExpression,
} from "../../packages/runtime/desktop-settings.js";

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

    const harnesses = detectHarnessConnections({ homeDir: home, which: () => null });
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

    const harnesses = detectHarnessConnections({ homeDir: home, which: () => null });
    for (const id of ["codex", "opencode", "pi"]) {
      const harness = harnesses.find((entry) => entry.id === id);
      expect(harness?.status).toBe("connected");
      expect(harness?.detail).toBe("Session import available");
    }
  });

  test("initializes switches from existing native scheduler artifacts", () => {
    const home = temporaryDirectory("selftune-existing-schedule-");
    const configDir = temporaryDirectory("selftune-existing-config-");
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "com.selftune.sync.plist"), "<plist />");

    const settings = loadDesktopSettings({
      homeDir: home,
      configDir,
      platform: "darwin",
      which: () => null,
    });
    const sync = settings.schedule.jobs.find((job) => job.id === "selftune-sync");
    expect(sync?.active).toBe(true);
    expect(sync?.enabled).toBe(true);
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
          { id: "selftune-orchestrate", enabled: true, schedule: "0 */4 * * *" },
        ],
      },
      {
        homeDir: home,
        configDir,
        platform: "darwin",
        binPath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune-cli",
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
    expect(commands.some((entry) => entry.args[0] === "load")).toBe(true);

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
          { id: "selftune-orchestrate", enabled: false, schedule: "0 */2 * * *" },
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
});
