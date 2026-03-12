#!/usr/bin/env bun
/**
 * selftune schedule — Generate scheduling examples for automated selftune runs.
 *
 * Outputs ready-to-use snippets for system cron, macOS launchd, and Linux systemd.
 * This is the generic, agent-agnostic way to automate selftune.
 *
 * For OpenClaw-specific scheduling, see `selftune cron`.
 *
 * Usage:
 *   selftune schedule [--format cron|launchd|systemd]
 */

import { parseArgs } from "node:util";

import { DEFAULT_CRON_JOBS } from "./cron/setup.js";

// ---------------------------------------------------------------------------
// Schedule definitions — derived from the shared DEFAULT_CRON_JOBS
// ---------------------------------------------------------------------------

export interface ScheduleEntry {
  name: string;
  schedule: string;
  command: string;
  description: string;
}

/** Map cron job metadata to schedule entries with CLI commands. */
function commandForJob(jobName: string): string {
  switch (jobName) {
    case "selftune-sync":
      return "selftune sync";
    case "selftune-status":
      return "selftune sync && selftune status";
    case "selftune-evolve":
      return "selftune evolve --sync-first --skill <name> --skill-path <path>";
    case "selftune-watch":
      return "selftune watch --sync-first --skill <name> --skill-path <path>";
    default:
      return `selftune ${jobName.replace("selftune-", "")}`;
  }
}

export const SCHEDULE_ENTRIES: ScheduleEntry[] = DEFAULT_CRON_JOBS.map((job) => ({
  name: job.name,
  schedule: job.cron,
  command: commandForJob(job.name),
  description: job.description,
}));

// ---------------------------------------------------------------------------
// Helpers for launchd/systemd generation
// ---------------------------------------------------------------------------

/**
 * Convert a cron schedule to launchd scheduling XML.
 * Uses StartInterval for repeating intervals (e.g. every N minutes/hours),
 * and StartCalendarInterval for fixed calendar times (e.g. daily at 8am).
 */
function cronToLaunchdSchedule(cron: string): string {
  // Repeating intervals: */N minutes
  if (cron.startsWith("*/")) {
    const minutes = Number.parseInt(cron.split(" ")[0].replace("*/", ""), 10);
    return `  <key>StartInterval</key>\n  <integer>${minutes * 60}</integer>`;
  }
  // Repeating intervals: every N hours
  if (cron.startsWith("0 */")) {
    const hours = Number.parseInt(cron.split(" ")[1].replace("*/", ""), 10);
    return `  <key>StartInterval</key>\n  <integer>${hours * 3600}</integer>`;
  }

  // Fixed calendar times use StartCalendarInterval
  const parts = cron.split(" ");
  const [minute, hour, , , weekday] = parts;
  let dict = "  <key>StartCalendarInterval</key>\n  <dict>";
  if (weekday !== "*") {
    dict += `\n    <key>Weekday</key>\n    <integer>${weekday}</integer>`;
  }
  if (hour !== "*") {
    dict += `\n    <key>Hour</key>\n    <integer>${Number.parseInt(hour, 10)}</integer>`;
  }
  if (minute !== "*") {
    dict += `\n    <key>Minute</key>\n    <integer>${Number.parseInt(minute, 10)}</integer>`;
  }
  dict += "\n  </dict>";
  return dict;
}

/** Convert a cron schedule to a systemd OnCalendar value. */
function cronToOnCalendar(cron: string): string {
  if (cron === "*/30 * * * *") return "*:0/30";
  if (cron === "0 8 * * *") return "*-*-* 08:00:00";
  if (cron === "0 3 * * 0") return "Sun *-*-* 03:00:00";
  if (cron === "0 */6 * * *") return "*-*-* 0/6:00:00";
  return cron;
}

/** Build launchd ProgramArguments, using /bin/sh -c for chained commands. */
function toLaunchdArgs(command: string): string {
  if (command.includes(" && ")) {
    return ["/bin/sh", "-c", command].map((a) => `    <string>${a}</string>`).join("\n");
  }
  return command
    .split(" ")
    .map((a) => `    <string>${a}</string>`)
    .join("\n");
}

/** Build systemd ExecStart, using /bin/sh -c for chained commands. */
function toSystemdExecStart(command: string): string {
  if (command.includes(" && ")) {
    return `/bin/sh -c "${command}"`;
  }
  return command;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export function generateCrontab(): string {
  const lines = [
    "# selftune automation — add to your crontab with: crontab -e",
    "#",
    "# The core loop: sync → status → evolve → watch",
    "# Adjust paths and skill names for your setup.",
    "#",
  ];
  for (const entry of SCHEDULE_ENTRIES) {
    lines.push(`# ${entry.description}`);
    lines.push(`${entry.schedule}  ${entry.command}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function generateLaunchd(): string {
  const plists: string[] = [];

  for (const entry of SCHEDULE_ENTRIES) {
    const label = `com.selftune.${entry.name.replace("selftune-", "")}`;
    const args = toLaunchdArgs(entry.command);
    const schedule = cronToLaunchdSchedule(entry.schedule);

    plists.push(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  ${entry.description}

  Install:
    cp ${label}.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/${label}.plist
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${schedule}
  <key>StandardOutPath</key>
  <string>/tmp/${entry.name}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${entry.name}.err</string>
</dict>
</plist>`);
  }

  return plists.join("\n\n");
}

export function generateSystemd(): string {
  const units: string[] = [];

  for (const entry of SCHEDULE_ENTRIES) {
    const unitName = entry.name;
    const calendar = cronToOnCalendar(entry.schedule);
    const execStart = toSystemdExecStart(entry.command);

    units.push(`# --- ${unitName}.timer ---
# ${entry.description}
#
# Install:
#   cp ${unitName}.service ${unitName}.timer ~/.config/systemd/user/
#   systemctl --user daemon-reload
#   systemctl --user enable --now ${unitName}.timer

[Unit]
Description=${entry.description}

[Timer]
OnCalendar=${calendar}
Persistent=true

[Install]
WantedBy=timers.target

# --- ${unitName}.service ---
[Unit]
Description=${entry.description}

[Service]
Type=oneshot
ExecStart=${execStart}`);
  }

  return units.join("\n\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALID_FORMATS = ["cron", "launchd", "systemd"] as const;
export type ScheduleFormat = (typeof VALID_FORMATS)[number];

function isValidFormat(value: string): value is ScheduleFormat {
  return (VALID_FORMATS as readonly string[]).includes(value);
}

export function formatOutput(
  format?: string,
): { ok: true; data: string } | { ok: false; error: string } {
  if (format && !isValidFormat(format)) {
    return {
      ok: false,
      error: `Unknown format "${format}". Valid formats: ${VALID_FORMATS.join(", ")}`,
    };
  }

  const sections: string[] = [];

  if (!format || format === "cron") {
    sections.push("## System cron\n");
    sections.push(generateCrontab());
  }

  if (!format || format === "launchd") {
    sections.push("## macOS launchd\n");
    sections.push(generateLaunchd());
  }

  if (!format || format === "systemd") {
    sections.push("## Linux systemd\n");
    sections.push(generateSystemd());
  }

  return { ok: true, data: sections.join("\n\n") };
}

export function cliMain(): void {
  const { values } = parseArgs({
    options: {
      format: { type: "string", short: "f" },
      help: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`selftune schedule — Generate scheduling examples for automation

Usage:
  selftune schedule [--format cron|launchd|systemd]

Flags:
  --format, -f    Output only one format (cron, launchd, or systemd)
  --help          Show this help message

The selftune automation loop is:
  sync → status → evolve --sync-first → watch --sync-first

This command generates ready-to-use snippets for running that loop
with standard system scheduling tools. No agent runtime required.

For OpenClaw-specific scheduling, see: selftune cron`);
    process.exit(0);
  }

  const result = formatOutput(values.format);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(result.data);
}

if (import.meta.main) {
  cliMain();
}
