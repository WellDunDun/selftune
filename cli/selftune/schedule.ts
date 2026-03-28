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
 *   selftune schedule [--format cron|launchd|systemd] [--install] [--dry-run]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_CRON_JOBS } from "./cron/setup.js";
import { CLIError } from "./utils/cli-error.js";

// ---------------------------------------------------------------------------
// Binary resolution — launchd runs with minimal PATH, so we need full paths
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the `selftune` binary.
 * 1. Bun.which (Bun-native, no spawn)
 * 2. Fallback: ~/.bun/bin/selftune (common bun global install location)
 */
export function resolveSelftuneBin(): string {
  try {
    const resolved = Bun.which("selftune");
    if (resolved) return resolved;
  } catch {
    // Bun.which may throw in edge cases — fall through
  }
  return join(homedir(), ".bun", "bin", "selftune");
}

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
    case "selftune-orchestrate":
      return "selftune orchestrate --max-skills 3";
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

export interface ScheduleInstallArtifact {
  path: string;
  content: string;
}

export interface ScheduleInstallResult {
  format: ScheduleFormat;
  artifacts: ScheduleInstallArtifact[];
  activationCommands: string[];
  activated: boolean;
  dryRun: boolean;
}

const CRON_BEGIN_MARKER = "# BEGIN SELFTUNE";
const CRON_END_MARKER = "# END SELFTUNE";

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
  const resolvedBin = resolveSelftuneBin();
  const home = homedir();
  const lines = [
    "# selftune automation — add to your crontab with: crontab -e",
    "#",
    "# The core loop: sync → orchestrate",
    "# status remains a reporting job; orchestrate handles sync, candidate",
    "# selection, low-risk description evolution, and watch/rollback follow-up.",
    "#",
    `PATH=${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    "",
  ];
  for (const entry of SCHEDULE_ENTRIES) {
    const resolvedCommand = entry.command.replace(/\bselftune\b/g, resolvedBin);
    lines.push(`# ${entry.description}`);
    lines.push(`${entry.schedule}  ${resolvedCommand}`);
    lines.push("");
  }
  return lines.join("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function wrapManagedCrontabBlock(content: string): string {
  return `${CRON_BEGIN_MARKER}\n${content.trim()}\n${CRON_END_MARKER}\n`;
}

export function mergeManagedCrontab(existing: string, managedContent: string): string {
  const managedBlock = wrapManagedCrontabBlock(managedContent);
  const normalizedExisting = existing.replace(/\r\n/g, "\n");
  const markerPattern = new RegExp(
    `${escapeRegex(CRON_BEGIN_MARKER)}[\\s\\S]*?${escapeRegex(CRON_END_MARKER)}\\n?`,
    "g",
  );
  const withoutExistingBlock = normalizedExisting.replace(markerPattern, "").trimEnd();

  if (!withoutExistingBlock) {
    return managedBlock;
  }

  return `${withoutExistingBlock}\n\n${managedBlock}`;
}

function buildLaunchdDefinition(
  entry: ScheduleEntry,
  binPath?: string,
): { label: string; content: string } {
  const label = `com.selftune.${entry.name.replace("selftune-", "")}`;
  const resolvedBin = binPath ?? resolveSelftuneBin();
  // Replace bare `selftune` with the resolved absolute path
  const resolvedCommand = entry.command.replace(/\bselftune\b/g, resolvedBin);
  const args = toLaunchdArgs(resolvedCommand);
  const schedule = cronToLaunchdSchedule(entry.schedule);
  const home = homedir();

  return {
    label,
    content: `<?xml version="1.0" encoding="UTF-8"?>
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>
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
</plist>`,
  };
}

export function generateLaunchd(): string {
  const plists: string[] = [];

  for (const entry of SCHEDULE_ENTRIES) {
    plists.push(buildLaunchdDefinition(entry).content);
  }

  return plists.join("\n\n");
}

function buildSystemdDefinition(
  entry: ScheduleEntry,
  binPath?: string,
): {
  baseName: string;
  timerContent: string;
  serviceContent: string;
} {
  const unitName = entry.name;
  const calendar = cronToOnCalendar(entry.schedule);
  const resolvedBin = binPath ?? resolveSelftuneBin();
  const resolvedCommand = entry.command.replace(/\bselftune\b/g, resolvedBin);
  const execStart = toSystemdExecStart(resolvedCommand);
  const home = homedir();

  return {
    baseName: unitName,
    timerContent: `[Unit]
Description=${entry.description}

[Timer]
OnCalendar=${calendar}
Persistent=true

[Install]
WantedBy=timers.target`,
    serviceContent: `[Unit]
Description=${entry.description}

[Service]
Type=oneshot
Environment="PATH=${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin"
Environment="HOME=${home}"
ExecStart=${execStart}`,
  };
}

export function generateSystemd(): string {
  const units: string[] = [];

  for (const entry of SCHEDULE_ENTRIES) {
    const definition = buildSystemdDefinition(entry);

    units.push(`# --- ${definition.baseName}.timer ---
# ${entry.description}
#
# Install:
#   cp ${definition.baseName}.service ${definition.baseName}.timer ~/.config/systemd/user/
#   systemctl --user daemon-reload
#   systemctl --user enable --now ${definition.baseName}.timer

${definition.timerContent}

# --- ${definition.baseName}.service ---
${definition.serviceContent}`);
  }

  return units.join("\n\n");
}

export function selectInstallFormat(
  requested?: string,
  platform: NodeJS.Platform = process.platform,
): { ok: true; format: ScheduleFormat } | { ok: false; error: string } {
  if (requested) {
    if (!isValidFormat(requested)) {
      return {
        ok: false,
        error: `Unknown format "${requested}". Valid formats: ${VALID_FORMATS.join(", ")}`,
      };
    }
    return { ok: true, format: requested };
  }

  if (platform === "darwin") return { ok: true, format: "launchd" };
  if (platform === "linux") return { ok: true, format: "systemd" };
  return { ok: true, format: "cron" };
}

export function buildInstallPlan(
  format: ScheduleFormat,
  homeDir = homedir(),
): { artifacts: ScheduleInstallArtifact[]; activationCommands: string[] } {
  if (format === "cron") {
    const path = join(homeDir, ".selftune", "schedule", "selftune.crontab");
    return {
      artifacts: [{ path, content: generateCrontab() }],
      activationCommands: [`selftune schedule --apply-cron-artifact ${path}`],
    };
  }

  if (format === "launchd") {
    const launchAgentsDir = join(homeDir, "Library", "LaunchAgents");
    const artifacts = SCHEDULE_ENTRIES.map((entry) => {
      const definition = buildLaunchdDefinition(entry);
      return {
        path: join(launchAgentsDir, `${definition.label}.plist`),
        content: definition.content,
      };
    });

    return {
      artifacts,
      activationCommands: artifacts.flatMap((artifact) => [
        `launchctl unload ${artifact.path} >/dev/null 2>&1 || true`,
        `launchctl load ${artifact.path}`,
      ]),
    };
  }

  if (format !== "systemd") {
    throw new Error(`Unknown format "${format}". Valid formats: ${VALID_FORMATS.join(", ")}`);
  }

  const systemdDir = join(homeDir, ".config", "systemd", "user");
  const definitions = SCHEDULE_ENTRIES.map(buildSystemdDefinition);
  return {
    artifacts: definitions.flatMap((definition) => [
      { path: join(systemdDir, `${definition.baseName}.timer`), content: definition.timerContent },
      {
        path: join(systemdDir, `${definition.baseName}.service`),
        content: definition.serviceContent,
      },
    ]),
    activationCommands: [
      "systemctl --user daemon-reload",
      ...definitions.map(
        (definition) => `systemctl --user enable --now ${definition.baseName}.timer`,
      ),
    ],
  };
}

function runShellCommand(command: string): number {
  const result = spawnSync("/bin/sh", ["-c", command], { stdio: "inherit" });
  return result.status ?? 1;
}

function readCurrentCrontab(): string {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });

  if (result.status === 0) {
    return result.stdout;
  }

  const stderr = (result.stderr ?? "").trim();
  if (stderr.includes("no crontab for")) {
    return "";
  }

  throw new Error(stderr || `crontab -l failed with exit code ${result.status ?? 1}`);
}

export function applyCronArtifact(artifactPath: string): void {
  const artifactContent = readFileSync(artifactPath, "utf-8");
  const mergedPath = artifactPath.replace(/\.crontab$/, ".merged.crontab");
  const mergedContent = mergeManagedCrontab(readCurrentCrontab(), artifactContent);

  mkdirSync(dirname(mergedPath), { recursive: true });
  writeFileSync(mergedPath, mergedContent, "utf-8");

  const result = spawnSync("crontab", [mergedPath], { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Failed to install merged crontab from ${mergedPath}`);
  }
}

export function installSchedule(
  options: {
    format?: string;
    dryRun?: boolean;
    homeDir?: string;
    platform?: NodeJS.Platform;
    runCommand?: (command: string) => number;
  } = {},
): ScheduleInstallResult {
  const formatResult = selectInstallFormat(options.format, options.platform);
  if (!formatResult.ok) {
    throw new Error(formatResult.error);
  }

  const plan = buildInstallPlan(formatResult.format, options.homeDir);
  const dryRun = options.dryRun ?? false;

  for (const artifact of plan.artifacts) {
    if (dryRun) continue;
    mkdirSync(dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.content, "utf-8");
  }

  let activated = false;
  if (!dryRun) {
    if (formatResult.format === "cron") {
      const cronArtifact = plan.artifacts[0];
      if (!cronArtifact) {
        throw new Error("Cron install plan is missing the selftune crontab artifact.");
      }
      applyCronArtifact(cronArtifact.path);
      activated = true;
    } else {
      const runCommand = options.runCommand ?? runShellCommand;
      activated = plan.activationCommands.every((command) => runCommand(command) === 0);
    }
  }

  return {
    format: formatResult.format,
    artifacts: plan.artifacts,
    activationCommands: plan.activationCommands,
    activated,
    dryRun,
  };
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
      install: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "apply-cron-artifact": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values["apply-cron-artifact"]) {
    try {
      applyCronArtifact(values["apply-cron-artifact"]);
      return;
    } catch (err) {
      throw new CLIError(
        `Failed to apply selftune cron artifact: ${err instanceof Error ? err.message : String(err)}`,
        "OPERATION_FAILED",
        "Check crontab permissions and try again.",
      );
    }
  }

  if (values.help) {
    console.log(`selftune schedule — Generate scheduling examples for automation

Usage:
  selftune schedule [--format cron|launchd|systemd] [--install] [--dry-run]

Flags:
  --format, -f    Output only one format (cron, launchd, or systemd)
  --install       Write and activate schedule artifacts for the selected platform
  --dry-run       Preview installed files and activation commands without writing
  --help          Show this help message

The selftune automation loop is:
  sync → orchestrate

This command generates ready-to-use snippets for running that loop
with standard system scheduling tools. No agent runtime required.

For OpenClaw-specific scheduling, see: selftune cron`);
    process.exit(0);
  }

  if (values.install) {
    try {
      const result = installSchedule({
        format: values.format,
        dryRun: values["dry-run"] ?? false,
      });
      if (!result.dryRun && !result.activated) {
        throw new CLIError(
          "Failed to activate installed schedule artifacts.",
          "OPERATION_FAILED",
          "Re-run with --dry-run to inspect the generated artifacts first.",
        );
      }
      console.log(
        JSON.stringify(
          {
            format: result.format,
            installed: !result.dryRun,
            activated: result.activated,
            files: result.artifacts.map((artifact) => artifact.path),
            activationCommands: result.activationCommands,
          },
          null,
          2,
        ),
      );
      return;
    } catch (err) {
      throw new CLIError(
        `Failed to install schedule artifacts: ${err instanceof Error ? err.message : String(err)}`,
        "OPERATION_FAILED",
        "Re-run with --dry-run to preview, or check file permissions.",
      );
    }
  }

  const result = formatOutput(values.format);
  if (!result.ok) {
    throw new CLIError(result.error, "INVALID_FLAG", "Valid formats: cron, launchd, systemd.");
  }
  console.log(result.data);
}

if (import.meta.main) {
  cliMain();
}
