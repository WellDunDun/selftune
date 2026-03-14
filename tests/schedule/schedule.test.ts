import { describe, expect, test } from "bun:test";

import {
  applyCronArtifact,
  buildInstallPlan,
  formatOutput,
  generateCrontab,
  generateLaunchd,
  generateSystemd,
  installSchedule,
  mergeManagedCrontab,
  SCHEDULE_ENTRIES,
  selectInstallFormat,
  wrapManagedCrontabBlock,
} from "../../cli/selftune/schedule.js";

// ---------------------------------------------------------------------------
// 1. SCHEDULE_ENTRIES structure
// ---------------------------------------------------------------------------
describe("SCHEDULE_ENTRIES", () => {
  test("has exactly 3 entries", () => {
    expect(SCHEDULE_ENTRIES).toHaveLength(3);
  });

  test("all entries have required fields", () => {
    for (const entry of SCHEDULE_ENTRIES) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.schedule).toBe("string");
      expect(entry.schedule.length).toBeGreaterThan(0);
      expect(typeof entry.command).toBe("string");
      expect(entry.command.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  test("contains sync, status, and orchestrate entries", () => {
    const names = SCHEDULE_ENTRIES.map((e) => e.name);
    expect(names).toContain("selftune-sync");
    expect(names).toContain("selftune-status");
    expect(names).toContain("selftune-orchestrate");
  });

  test("orchestrate entry runs the autonomous loop", () => {
    const orchestrate = SCHEDULE_ENTRIES.find((e) => e.name === "selftune-orchestrate");
    expect(orchestrate?.command).toContain("selftune orchestrate");
  });

  test("derives from DEFAULT_CRON_JOBS (shared source of truth)", () => {
    // Schedules should match cron expressions from DEFAULT_CRON_JOBS
    const sync = SCHEDULE_ENTRIES.find((e) => e.name === "selftune-sync");
    expect(sync?.schedule).toBe("*/30 * * * *");
    const status = SCHEDULE_ENTRIES.find((e) => e.name === "selftune-status");
    expect(status?.schedule).toBe("0 8 * * *");
    const orchestrate = SCHEDULE_ENTRIES.find((e) => e.name === "selftune-orchestrate");
    expect(orchestrate?.schedule).toBe("0 */6 * * *");
  });
});

// ---------------------------------------------------------------------------
// 2. Crontab generation
// ---------------------------------------------------------------------------
describe("generateCrontab", () => {
  test("includes crontab header comment", () => {
    const output = generateCrontab();
    expect(output).toContain("crontab -e");
  });

  test("includes all schedule entries", () => {
    const output = generateCrontab();
    for (const entry of SCHEDULE_ENTRIES) {
      expect(output).toContain(entry.schedule);
      expect(output).toContain(entry.command);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Launchd generation
// ---------------------------------------------------------------------------
describe("generateLaunchd", () => {
  test("outputs valid plist structure", () => {
    const output = generateLaunchd();
    expect(output).toContain("<?xml");
    expect(output).toContain("</plist>");
  });

  test("uses StartInterval for repeating schedules", () => {
    const output = generateLaunchd();
    // sync runs every 30 min — should use StartInterval
    expect(output).toContain("<key>StartInterval</key>");
  });

  test("uses StartCalendarInterval for fixed-time schedules", () => {
    const output = generateLaunchd();
    // status runs daily at 8am — should use StartCalendarInterval
    expect(output).toContain("<key>StartCalendarInterval</key>");
    expect(output).toContain("<key>Hour</key>");
  });

  test("uses /bin/sh -c for chained commands", () => {
    const output = generateLaunchd();
    // status command has && — should use shell wrapper
    expect(output).toContain("<string>/bin/sh</string>");
    expect(output).toContain("<string>-c</string>");
    expect(output).toContain("selftune sync && selftune status");
  });

  test("includes install instructions", () => {
    const output = generateLaunchd();
    expect(output).toContain("launchctl load");
  });

  test("generates plists for all schedule entries", () => {
    const output = generateLaunchd();
    expect(output).toContain("com.selftune.sync");
    expect(output).toContain("com.selftune.status");
    expect(output).toContain("com.selftune.orchestrate");
  });
});

// ---------------------------------------------------------------------------
// 4. Systemd generation
// ---------------------------------------------------------------------------
describe("generateSystemd", () => {
  test("outputs timer and service sections", () => {
    const output = generateSystemd();
    expect(output).toContain("[Timer]");
    expect(output).toContain("[Service]");
  });

  test("uses /bin/sh -c for chained commands", () => {
    const output = generateSystemd();
    // status has && — should wrap in shell
    expect(output).toContain('ExecStart=/bin/sh -c "selftune sync && selftune status"');
  });

  test("uses bare command for simple entries", () => {
    const output = generateSystemd();
    expect(output).toContain("ExecStart=selftune sync\n");
  });

  test("includes install instructions", () => {
    const output = generateSystemd();
    expect(output).toContain("systemctl --user");
  });

  test("generates units for all schedule entries", () => {
    const output = generateSystemd();
    expect(output).toContain("selftune-sync.timer");
    expect(output).toContain("selftune-status.timer");
    expect(output).toContain("selftune-orchestrate.timer");
  });
});

describe("install helpers", () => {
  test("selectInstallFormat rejects unknown format", () => {
    expect(selectInstallFormat("docker")).toEqual({
      ok: false,
      error: 'Unknown format "docker". Valid formats: cron, launchd, systemd',
    });
  });

  test("selectInstallFormat defaults by platform", () => {
    expect(selectInstallFormat(undefined, "darwin")).toEqual({ ok: true, format: "launchd" });
    expect(selectInstallFormat(undefined, "linux")).toEqual({ ok: true, format: "systemd" });
    expect(selectInstallFormat(undefined, "win32")).toEqual({ ok: true, format: "cron" });
  });

  test("buildInstallPlan rejects unknown format at runtime", () => {
    expect(() => buildInstallPlan("docker" as never, "/tmp/test-home")).toThrow(/Unknown format/);
  });

  test("buildInstallPlan returns launchd artifacts and activation commands", () => {
    const plan = buildInstallPlan("launchd", "/tmp/test-home");
    expect(plan.artifacts.some((artifact) => artifact.path.includes("LaunchAgents"))).toBe(true);
    expect(plan.activationCommands.some((command) => command.includes("launchctl load"))).toBe(
      true,
    );
  });

  test("installSchedule dry-run does not activate commands", () => {
    let commandsRun = 0;
    const result = installSchedule({
      format: "cron",
      dryRun: true,
      homeDir: "/tmp/test-home",
      runCommand: () => {
        commandsRun++;
        return 0;
      },
    });

    expect(result.dryRun).toBe(true);
    expect(result.activated).toBe(false);
    expect(commandsRun).toBe(0);
    expect(result.artifacts[0]?.path).toMatch(
      /[\\/]\.selftune[\\/]schedule[\\/]selftune\.crontab$/,
    );
  });

  test("installSchedule throws for unknown format", () => {
    expect(() => installSchedule({ format: "docker" })).toThrow(/Unknown format/);
  });

  test("mergeManagedCrontab preserves unrelated jobs and replaces the selftune block", () => {
    const existing = [
      "MAILTO=user@example.com",
      "0 1 * * * backup-job",
      wrapManagedCrontabBlock("old-selftune-job"),
      "15 3 * * * analytics-job",
    ].join("\n");

    const merged = mergeManagedCrontab(existing, "0 */6 * * * selftune orchestrate --max-skills 3");

    expect(merged).toContain("MAILTO=user@example.com");
    expect(merged).toContain("0 1 * * * backup-job");
    expect(merged).toContain("15 3 * * * analytics-job");
    expect(merged).toContain("# BEGIN SELFTUNE");
    expect(merged).toContain("0 */6 * * * selftune orchestrate --max-skills 3");
    expect(merged).not.toContain("old-selftune-job");
  });

  test("applyCronArtifact throws when the artifact is missing", () => {
    expect(() => applyCronArtifact("/tmp/does-not-exist/selftune.crontab")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. formatOutput (default and filtered)
// ---------------------------------------------------------------------------
describe("formatOutput", () => {
  test("default output includes all three sections", () => {
    const result = formatOutput();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("## System cron");
      expect(result.data).toContain("## macOS launchd");
      expect(result.data).toContain("## Linux systemd");
    }
  });

  test("--format cron outputs only cron section", () => {
    const result = formatOutput("cron");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("## System cron");
      expect(result.data).not.toContain("## macOS launchd");
      expect(result.data).not.toContain("## Linux systemd");
    }
  });

  test("--format launchd outputs only launchd section", () => {
    const result = formatOutput("launchd");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).not.toContain("## System cron");
      expect(result.data).toContain("## macOS launchd");
      expect(result.data).not.toContain("## Linux systemd");
    }
  });

  test("--format systemd outputs only systemd section", () => {
    const result = formatOutput("systemd");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).not.toContain("## System cron");
      expect(result.data).not.toContain("## macOS launchd");
      expect(result.data).toContain("## Linux systemd");
    }
  });

  test("unknown format returns error result", () => {
    const result = formatOutput("docker");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("docker");
    }
  });
});
