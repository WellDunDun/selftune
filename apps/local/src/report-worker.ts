/**
 * Subprocess entry that computes one dashboard report and writes it as JSON to the
 * given output path. Spawned by the daemon (see report-compute.ts) so the computation
 * never blocks the daemon's event loop. Exits non-zero with the failure on stderr.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";

import { openDb } from "@selftune/local-store";
import * as Schema from "effect/Schema";

import {
  ReportWorkerArgumentsSchema,
  ResolvedReportComputeOptionsSchema,
  type DashboardReportName,
  type ResolvedReportComputeOptions,
} from "./report-contract.js";

async function computeReport(
  report: DashboardReportName,
  options: ResolvedReportComputeOptions,
  db: Database,
) {
  const storagePaths = options.storagePaths;
  const workerOptions = {
    ...options,
    configRoot: storagePaths.configRoot,
    storagePaths,
  };
  if (report === "portfolio-audit") {
    const { loadPortfolioAudit } = await import("@selftune/runtime/skill-portfolio");
    return loadPortfolioAudit(workerOptions.searchDirs, db);
  }
  if (report === "skill-intelligence") {
    const { loadSkillIntelligenceWithCatalog } =
      await import("@selftune/runtime/skill-intelligence/catalog-expansions");
    return loadSkillIntelligenceWithCatalog({
      db,
      configRoot: storagePaths.configRoot,
      traceAnalyticsPath: storagePaths.localAnalyticsPath,
      searchDirs: workerOptions.searchDirs,
      quarantineRoot: workerOptions.quarantineRoot ?? join(storagePaths.configRoot, "quarantine"),
    });
  }
  if (report === "library") {
    const [
      { createControlPlaneRuntime },
      { loadLibraryReport },
      { queryKnownWorkspacePaths, queryTrustedSkillObservationRows },
    ] = await Promise.all([
      import("@selftune/runtime/control-plane-runtime"),
      import("./library-report.js"),
      import("@selftune/runtime/localdb/queries"),
    ]);
    const controlPlane = createControlPlaneRuntime();
    try {
      return await loadLibraryReport(workerOptions.configRoot, controlPlane, {
        searchDirs: workerOptions.searchDirs,
        quarantineRoot: workerOptions.quarantineRoot ?? join(storagePaths.configRoot, "quarantine"),
        usageRows: queryTrustedSkillObservationRows(db),
        workspacePaths: queryKnownWorkspacePaths(db),
      });
    } finally {
      await controlPlane.dispose();
    }
  }
  const [{ loadPortfolioAudit }, { buildInsightsResponse }] = await Promise.all([
    import("@selftune/runtime/skill-portfolio"),
    import("./report-builders.js"),
  ]);
  return buildInsightsResponse(loadPortfolioAudit(workerOptions.searchDirs, db), workerOptions, db);
}

async function main(): Promise<void> {
  const [report, optionsJson, outPath] = Schema.decodeUnknownSync(ReportWorkerArgumentsSchema)(
    process.argv.slice(2),
  );
  const options = Schema.decodeUnknownSync(
    Schema.fromJsonString(ResolvedReportComputeOptionsSchema),
  )(optionsJson);
  const db = openDb(options.storagePaths.localDatabasePath);
  try {
    const result = await computeReport(report, options, db);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result));
  } finally {
    db.close();
  }
}

main().catch((cause) => {
  process.stderr.write(
    `${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
  );
  process.exit(1);
});
