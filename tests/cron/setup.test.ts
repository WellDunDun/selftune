import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCronAddArgs,
  type CronJobConfig,
  DEFAULT_CRON_JOBS,
  getOpenClawJobsPath,
  loadCronJobs,
} from "../../cli/selftune/cron/setup.js";

// ---------------------------------------------------------------------------
// 1. buildCronAddArgs generates correct arguments
// ---------------------------------------------------------------------------
describe("buildCronAddArgs", () => {
  test("generates correct openclaw cron add arguments", () => {
    const job: CronJobConfig = {
      name: "selftune-ingest",
      cron: "*/30 * * * *",
      message: "Run selftune ingest-openclaw to capture any new sessions.",
      description: "Ingest new sessions every 30 minutes",
    };
    const tz = "America/New_York";
    const args = buildCronAddArgs(job, tz);

    expect(args).toContain("--name");
    expect(args).toContain("selftune-ingest");
    expect(args).toContain("--cron");
    expect(args).toContain("*/30 * * * *");
    expect(args).toContain("--tz");
    expect(args).toContain("America/New_York");
    expect(args).toContain("--session");
    expect(args).toContain("isolated");
    expect(args).toContain("--message");
    expect(args).toContain("Run selftune ingest-openclaw to capture any new sessions.");
  });

  test("uses provided timezone in args", () => {
    const job: CronJobConfig = {
      name: "selftune-status",
      cron: "0 8 * * *",
      message: "Run selftune status.",
      description: "Daily check",
    };
    const args = buildCronAddArgs(job, "Europe/Helsinki");
    const tzIndex = args.indexOf("--tz");
    expect(tzIndex).toBeGreaterThanOrEqual(0);
    expect(args[tzIndex + 1]).toBe("Europe/Helsinki");
  });
});

// ---------------------------------------------------------------------------
// 2. DEFAULT_CRON_JOBS has expected structure
// ---------------------------------------------------------------------------
describe("DEFAULT_CRON_JOBS", () => {
  test("has exactly 4 jobs", () => {
    expect(DEFAULT_CRON_JOBS).toHaveLength(4);
  });

  test("all jobs have required fields", () => {
    for (const job of DEFAULT_CRON_JOBS) {
      expect(typeof job.name).toBe("string");
      expect(job.name.length).toBeGreaterThan(0);
      expect(typeof job.cron).toBe("string");
      expect(job.cron.length).toBeGreaterThan(0);
      expect(typeof job.message).toBe("string");
      expect(job.message.length).toBeGreaterThan(0);
      expect(typeof job.description).toBe("string");
      expect(job.description.length).toBeGreaterThan(0);
    }
  });

  test("all job names start with selftune-", () => {
    for (const job of DEFAULT_CRON_JOBS) {
      expect(job.name.startsWith("selftune-")).toBe(true);
    }
  });

  test("contains expected job names", () => {
    const names = DEFAULT_CRON_JOBS.map((j) => j.name);
    expect(names).toContain("selftune-ingest");
    expect(names).toContain("selftune-status");
    expect(names).toContain("selftune-evolve");
    expect(names).toContain("selftune-watch");
  });
});

// ---------------------------------------------------------------------------
// 3. Timezone handling
// ---------------------------------------------------------------------------
describe("timezone handling", () => {
  test("timezone is correctly passed through to args", () => {
    const job = DEFAULT_CRON_JOBS[0];
    const args = buildCronAddArgs(job, "UTC");
    const tzIndex = args.indexOf("--tz");
    expect(args[tzIndex + 1]).toBe("UTC");
  });

  test("handles complex timezone strings", () => {
    const job = DEFAULT_CRON_JOBS[0];
    const args = buildCronAddArgs(job, "America/Argentina/Buenos_Aires");
    const tzIndex = args.indexOf("--tz");
    expect(args[tzIndex + 1]).toBe("America/Argentina/Buenos_Aires");
  });
});

// ---------------------------------------------------------------------------
// 4. loadCronJobs from jobs.json
// ---------------------------------------------------------------------------
describe("loadCronJobs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "selftune-cron-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads and filters selftune jobs from jobs.json", () => {
    const jobsData = [
      { name: "selftune-ingest", cron: "*/30 * * * *", message: "ingest", description: "Ingest" },
      { name: "selftune-status", cron: "0 8 * * *", message: "status", description: "Status" },
      { name: "other-job", cron: "0 0 * * *", message: "other", description: "Other" },
    ];
    const jobsPath = join(tmpDir, "jobs.json");
    writeFileSync(jobsPath, JSON.stringify(jobsData));

    const jobs = loadCronJobs(jobsPath);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.name.startsWith("selftune-"))).toBe(true);
  });

  test("returns empty array when file does not exist", () => {
    const jobs = loadCronJobs(join(tmpDir, "nonexistent.json"));
    expect(jobs).toEqual([]);
  });

  test("returns empty array when file contains invalid JSON", () => {
    const jobsPath = join(tmpDir, "bad.json");
    writeFileSync(jobsPath, "not valid json{{{");

    const jobs = loadCronJobs(jobsPath);
    expect(jobs).toEqual([]);
  });

  test("returns empty array when file contains non-array JSON", () => {
    const jobsPath = join(tmpDir, "obj.json");
    writeFileSync(jobsPath, JSON.stringify({ name: "test" }));

    const jobs = loadCronJobs(jobsPath);
    expect(jobs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. getOpenClawJobsPath
// ---------------------------------------------------------------------------
describe("getOpenClawJobsPath", () => {
  test("returns expected path under home directory", () => {
    const path = getOpenClawJobsPath();
    expect(path).toContain(".openclaw");
    expect(path).toContain("cron");
    expect(path).toContain("jobs.json");
  });
});
