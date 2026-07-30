/**
 * Subprocess entry that computes one dashboard report and writes it as JSON to the
 * given output path. Spawned by the daemon (see report-compute.ts) so the computation
 * never blocks the daemon's event loop. Exits non-zero with the failure on stderr.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { openDb } from "@selftune/local-store";

import type { DashboardReportName, ReportComputeOptions } from "./report-compute.js";

function requireStoragePaths(
  options: ReportComputeOptions,
): NonNullable<ReportComputeOptions["storagePaths"]> {
  if (options.storagePaths === undefined) {
    throw new Error("Report worker requires host-resolved storage paths.");
  }
  return options.storagePaths;
}

async function computeReport(
  report: DashboardReportName,
  options: ReportComputeOptions,
): Promise<unknown> {
  const storagePaths = requireStoragePaths(options);
  const workerOptions: ReportComputeOptions = {
    ...options,
    configRoot: storagePaths.configRoot,
    storagePaths,
  };
  if (report === "portfolio-audit") {
    const { loadPortfolioAudit } = await import("@selftune/runtime/skill-portfolio");
    return loadPortfolioAudit(workerOptions.searchDirs);
  }
  if (report === "skill-intelligence") {
    const { loadSkillIntelligenceWithCatalog } =
      await import("@selftune/runtime/skill-intelligence/catalog-expansions");
    const db = openDb(storagePaths.localDatabasePath);
    try {
      return await loadSkillIntelligenceWithCatalog({
        db,
        configRoot: storagePaths.configRoot,
        traceAnalyticsPath: storagePaths.localAnalyticsPath,
        searchDirs: workerOptions.searchDirs,
        quarantineRoot: workerOptions.quarantineRoot,
      });
    } finally {
      db.close();
    }
  }
  if (report === "library") {
    const [{ createControlPlaneRuntime }, { loadLibraryReport }] = await Promise.all([
      import("@selftune/runtime/control-plane-runtime"),
      import("./library-report.js"),
    ]);
    const controlPlane = createControlPlaneRuntime();
    try {
      return await loadLibraryReport(workerOptions.configRoot, controlPlane);
    } finally {
      await controlPlane.dispose();
    }
  }
  const [{ loadPortfolioAudit }, { buildInsightsResponse }] = await Promise.all([
    import("@selftune/runtime/skill-portfolio"),
    import("./report-builders.js"),
  ]);
  return buildInsightsResponse(loadPortfolioAudit(workerOptions.searchDirs), workerOptions);
}

async function main(): Promise<void> {
  const [, , report, optionsJson, outPath] = process.argv;
  if (!report || !outPath) {
    throw new Error("Usage: report-worker.ts <report> <options-json> <out-path>");
  }
  const options = JSON.parse(optionsJson || "{}") as ReportComputeOptions;
  const result = await computeReport(report as DashboardReportName, options);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result));
}

main().catch((cause) => {
  process.stderr.write(
    `${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
  );
  process.exit(1);
});
