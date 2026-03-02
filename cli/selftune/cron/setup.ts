#!/usr/bin/env bun
/**
 * selftune cron — Manage OpenClaw cron jobs for selftune automation.
 *
 * Subcommands:
 *   setup    Register default selftune cron jobs with OpenClaw
 *   list     Show registered selftune cron jobs
 *   remove   Remove all selftune cron jobs
 *
 * Usage:
 *   selftune cron setup [--dry-run] [--tz <timezone>]
 *   selftune cron list
 *   selftune cron remove [--dry-run]
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export interface CronJobConfig {
  name: string;
  cron: string;
  message: string;
  description: string;
}

export const DEFAULT_CRON_JOBS: CronJobConfig[] = [
  {
    name: "selftune-ingest",
    cron: "*/30 * * * *",
    message: "Run selftune ingest-openclaw to capture any new sessions.",
    description: "Ingest new sessions every 30 minutes",
  },
  {
    name: "selftune-status",
    cron: "0 8 * * *",
    message: "Run selftune status --json and report any skills with pass rate below 80%.",
    description: "Daily health check at 8am",
  },
  {
    name: "selftune-evolve",
    cron: "0 3 * * 0",
    message:
      "Run the full selftune evolution pipeline: ingest new sessions, check status, evolve any undertriggering skills, and report results.",
    description: "Weekly evolution at 3am Sunday",
  },
  {
    name: "selftune-watch",
    cron: "0 */6 * * *",
    message: "Run selftune watch on all recently evolved skills to detect regressions.",
    description: "Monitor regressions every 6 hours",
  },
];

// ---------------------------------------------------------------------------
// Helpers (exported for testability)
// ---------------------------------------------------------------------------

/** Build the argument array for `openclaw cron add`. */
export function buildCronAddArgs(job: CronJobConfig, tz: string): string[] {
  return [
    "cron",
    "add",
    "--name",
    job.name,
    "--cron",
    job.cron,
    "--tz",
    tz,
    "--session",
    "isolated",
    "--message",
    job.message,
  ];
}

/** Return the default path to OpenClaw's cron jobs file. */
export function getOpenClawJobsPath(): string {
  return join(homedir(), ".openclaw", "cron", "jobs.json");
}

/** Type guard that validates all required CronJobConfig fields. */
function isCronJobConfig(value: unknown): value is CronJobConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    typeof obj.cron === "string" &&
    typeof obj.message === "string" &&
    typeof obj.description === "string"
  );
}

/** Load cron jobs from a JSON file, filtering for selftune entries. */
export function loadCronJobs(jobsPath: string): CronJobConfig[] {
  if (!existsSync(jobsPath)) {
    return [];
  }
  try {
    const raw = readFileSync(jobsPath, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return [];
    }
    return data.filter((j: unknown) => isCronJobConfig(j) && j.name.startsWith("selftune-"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** Register default cron jobs with OpenClaw. */
export async function setupCronJobs(tz: string, dryRun: boolean): Promise<void> {
  const openclawPath = Bun.which("openclaw");
  if (!openclawPath) {
    console.error("Error: openclaw is not installed or not in PATH.");
    console.error("");
    console.error("Install OpenClaw:");
    console.error("  https://openclaw.dev/install");
    console.error("");
    console.error("Or ensure the openclaw binary is in your PATH.");
    process.exit(1);
  }

  console.log(`Registering ${DEFAULT_CRON_JOBS.length} cron jobs (tz=${tz})...\n`);

  for (const job of DEFAULT_CRON_JOBS) {
    const args = buildCronAddArgs(job, tz);

    if (dryRun) {
      console.log(`[DRY RUN] openclaw ${args.join(" ")}`);
    } else {
      const proc = Bun.spawn(["openclaw", ...args], {
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        console.error(
          `Error: openclaw cron add failed for "${job.name}" with exit code ${exitCode}`,
        );
        process.exit(1);
      }
      console.log(`  Registered: ${job.name} — ${job.description}`);
    }
  }

  console.log("\nDone.");
}

/** Show registered selftune cron jobs. */
export function listCronJobs(): void {
  const jobsPath = getOpenClawJobsPath();
  const jobs = loadCronJobs(jobsPath);

  if (jobs.length === 0) {
    if (!existsSync(jobsPath)) {
      console.log("No cron jobs file found at:", jobsPath);
    } else {
      console.log("No selftune cron jobs registered.");
    }
    return;
  }

  // Print as formatted table
  const nameWidth = Math.max(20, ...jobs.map((j) => j.name.length));
  const cronWidth = Math.max(16, ...jobs.map((j) => j.cron.length));

  console.log(`${"NAME".padEnd(nameWidth)}  ${"SCHEDULE".padEnd(cronWidth)}  DESCRIPTION`);
  console.log(`${"─".repeat(nameWidth)}  ${"─".repeat(cronWidth)}  ${"─".repeat(40)}`);

  for (const job of jobs) {
    console.log(`${job.name.padEnd(nameWidth)}  ${job.cron.padEnd(cronWidth)}  ${job.description}`);
  }
}

/** Remove all selftune cron jobs from OpenClaw. */
export async function removeCronJobs(dryRun: boolean): Promise<void> {
  const jobsPath = getOpenClawJobsPath();
  const jobs = loadCronJobs(jobsPath);

  if (jobs.length === 0) {
    console.log("No selftune cron jobs to remove.");
    return;
  }

  console.log(`Removing ${jobs.length} selftune cron jobs...\n`);

  for (const job of jobs) {
    if (dryRun) {
      console.log(`[DRY RUN] openclaw cron remove --name ${job.name}`);
    } else {
      const proc = Bun.spawn(["openclaw", "cron", "remove", "--name", job.name], {
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        console.error(
          `Error: openclaw cron remove failed for "${job.name}" with exit code ${exitCode}`,
        );
        process.exit(1);
      }
      console.log(`  Removed: ${job.name}`);
    }
  }

  console.log("\nDone.");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const subcommand = process.argv[2];

  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      tz: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  // Get timezone: flag > env > system default
  const tz = values.tz ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  switch (subcommand) {
    case "setup":
      await setupCronJobs(tz, values["dry-run"] ?? false);
      break;
    case "list":
      listCronJobs();
      break;
    case "remove":
      await removeCronJobs(values["dry-run"] ?? false);
      break;
    default:
      console.log(`selftune cron — Manage OpenClaw cron jobs

Usage:
  selftune cron setup [--dry-run] [--tz <timezone>]
  selftune cron list
  selftune cron remove [--dry-run]

Subcommands:
  setup    Register default selftune cron jobs with OpenClaw
  list     Show registered selftune cron jobs
  remove   Remove all selftune cron jobs`);
      break;
  }
}

if (import.meta.main) {
  await cliMain();
}
