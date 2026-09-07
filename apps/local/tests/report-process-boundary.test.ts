import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@selftune/local-store";
import { decodeReportOutput } from "../src/report-contract";

import {
  reportWorkerArguments,
  reportWorkerCommand,
  resolveReportComputeOptions,
} from "../src/report-compute";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (path: string) => readFileSync(join(appRoot, "src", path), "utf8");

describe("report process boundary", () => {
  test("keeps the DuckDB-backed skill report out of the long-lived dashboard daemon", () => {
    const dashboardOperations = source("dashboard-operations.ts");
    const reportCompute = source("report-compute.ts");
    const reportWorker = source("report-worker.ts");

    expect(dashboardOperations).not.toContain("skill-intelligence/catalog-expansions");
    expect(dashboardOperations).not.toContain("duckdb-node-api");
    expect(dashboardOperations).not.toContain("DuckDbAnalyticalStoreLive");
    expect(reportCompute).not.toContain("@selftune/runtime/synthesis");
    expect(reportCompute).toContain('new URL("./report-worker.ts", import.meta.url)');
    expect(reportWorker).toContain(
      'import("@selftune/runtime/skill-intelligence/catalog-expansions")',
    );
    expect(reportWorker).toContain('import("./report-builders.js")');
  });

  test("runs the compiled report worker directly in the packaged Desktop runtime", () => {
    const resourceRoot = "/tmp/selftune-desktop-resource";
    const worker =
      process.platform === "win32" ? "selftune-report-worker.exe" : "selftune-report-worker";

    expect(reportWorkerCommand(resourceRoot)).toEqual([join(resourceRoot, worker)]);
  });

  test("serializes host-owned SQLite and DuckDB paths instead of inheriting worker defaults", () => {
    const storagePaths = {
      configRoot: "/workspace/config",
      localDatabasePath: "/workspace/config/selftune.db",
      localAnalyticsPath: "/workspace/config/observability.duckdb",
    };
    const options = resolveReportComputeOptions({ storagePaths });
    const [, encodedOptions] = reportWorkerArguments(
      "skill-intelligence",
      options,
      "/workspace/cache/report.json",
    );

    expect(options.configRoot).toBe(storagePaths.configRoot);
    expect(JSON.parse(encodedOptions ?? "{}")).toMatchObject({
      configRoot: storagePaths.configRoot,
      storagePaths,
    });
  });

  test.each(["skill-intelligence", "portfolio-audit", "library", "insights"])(
    "%s uses serialized storage instead of the subprocess ambient database",
    (report) => {
      const root = mkdtempSync(join(tmpdir(), "selftune-report-worker-paths-"));
      const storagePaths = {
        configRoot: join(root, "host-config"),
        localDatabasePath: join(root, "host-config", "selftune.db"),
        localAnalyticsPath: join(root, "host-config", "observability.duckdb"),
      };
      const ambientConfigRoot = join(root, "ambient-config");
      const outputPath = join(root, "report.json");
      const workerPath = join(appRoot, "src", "report-worker.ts");
      try {
        const result = Bun.spawnSync(
          [
            process.execPath,
            workerPath,
            report,
            JSON.stringify(resolveReportComputeOptions({ storagePaths, searchDirs: [] })),
            outputPath,
          ],
          {
            env: { ...process.env, SELFTUNE_CONFIG_DIR: ambientConfigRoot },
            stderr: "pipe",
            stdout: "ignore",
          },
        );

        expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
        expect(existsSync(storagePaths.localDatabasePath)).toBe(true);
        expect(existsSync(storagePaths.localAnalyticsPath)).toBe(report === "skill-intelligence");
        expect(existsSync(join(ambientConfigRoot, "selftune.db"))).toBe(false);
        expect(existsSync(join(ambientConfigRoot, "observability.duckdb"))).toBe(false);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  test("portfolio reads the host's sessions and library honors the selected skill directories", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-report-host-evidence-"));
    const configRoot = join(root, "host");
    const localDatabasePath = join(configRoot, "host.sqlite");
    const storagePaths = {
      configRoot,
      localDatabasePath,
      localAnalyticsPath: join(configRoot, "host.duckdb"),
    };
    const registry = join(root, "project", ".agents", "skills");
    const skillRoot = join(registry, "report-owner");
    const db = openDb(localDatabasePath);
    try {
      db.run("INSERT INTO session_telemetry (session_id, timestamp, cwd) VALUES (?, ?, ?)", [
        "host-session",
        "2026-09-06T00:00:00.000Z",
        join(root, "project"),
      ]);
    } finally {
      db.close();
    }
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: report-owner\ndescription: Review a report using host-owned evidence.\n---\n# Report\nReview the evidence.\n",
    );
    const options = resolveReportComputeOptions({ storagePaths, searchDirs: [registry] });
    const runWorker = (report: "portfolio-audit" | "library") => {
      const output = join(root, `${report}.json`);
      const child = Bun.spawnSync(
        [
          process.execPath,
          join(appRoot, "src", "report-worker.ts"),
          report,
          JSON.stringify(options),
          output,
        ],
        {
          env: { ...process.env, SELFTUNE_CONFIG_DIR: join(root, "ambient") },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
      return readFileSync(output, "utf8");
    };
    try {
      const portfolio = decodeReportOutput("portfolio-audit", runWorker("portfolio-audit"));
      expect(portfolio.session_count).toBe(1);
      expect(portfolio.installed_count).toBe(1);
      const library = decodeReportOutput("library", runWorker("library"));
      expect(library.skills.map((skill) => skill.name)).toEqual(["report-owner"]);
      expect(existsSync(join(root, "ambient", "selftune.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
