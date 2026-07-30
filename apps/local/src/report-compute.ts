import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import { resolveSelftunePaths } from "@selftune/config";

export type DashboardReportName = "portfolio-audit" | "skill-intelligence" | "insights" | "library";

export interface ReportComputeStoragePaths {
  readonly configRoot: string;
  readonly localDatabasePath: string;
  readonly localAnalyticsPath: string;
}

export interface ReportComputeOptions {
  readonly configRoot?: string | undefined;
  readonly searchDirs?: string[] | undefined;
  readonly quarantineRoot?: string | undefined;
  /**
   * Resolved by the host before spawning. The worker must never infer storage
   * ownership from its own ambient environment.
   */
  readonly storagePaths?: ReportComputeStoragePaths | undefined;
}

const WORKER_TIMEOUT_MS = 180_000;

export function resolveReportComputeOptions(
  options: ReportComputeOptions,
): ReportComputeOptions & { readonly storagePaths: ReportComputeStoragePaths } {
  const suppliedStoragePaths = options.storagePaths;
  if (suppliedStoragePaths !== undefined) {
    return {
      ...options,
      configRoot: suppliedStoragePaths.configRoot,
      storagePaths: suppliedStoragePaths,
    };
  }
  const paths = resolveSelftunePaths({
    environment: { SELFTUNE_CONFIG_DIR: options.configRoot },
    homeDirectory: homedir(),
  });
  return {
    ...options,
    configRoot: paths.configDir,
    storagePaths: {
      configRoot: paths.configDir,
      localDatabasePath: paths.localDatabasePath,
      localAnalyticsPath: paths.localAnalyticsPath,
    },
  };
}

export function reportWorkerArguments(
  report: DashboardReportName,
  options: ReportComputeOptions,
  outPath: string,
): readonly string[] {
  return [report, JSON.stringify(resolveReportComputeOptions(options)), outPath];
}

export function reportWorkerCommand(
  desktopResourceDirectory = process.env.SELFTUNE_DESKTOP_RESOURCE_DIR,
): readonly string[] {
  if (desktopResourceDirectory) {
    return [
      join(
        desktopResourceDirectory,
        process.platform === "win32" ? "selftune-report-worker.exe" : "selftune-report-worker",
      ),
    ];
  }
  return [process.execPath, fileURLToPath(new URL("./report-worker.ts", import.meta.url))];
}

/**
 * Compute a dashboard report in a short-lived bun subprocess so the multi-second
 * synchronous computation never occupies the daemon's event loop. The worker writes its
 * JSON result to `outPath` (stdout stays free for stray library logging). npm/dev runs
 * the sibling TypeScript entry through Bun; Desktop runs the separately compiled worker
 * staged in its resource directory. A failed worker deliberately remains a failure: the
 * materialized cache retains its last successful artifact instead of recreating this
 * heavyweight work in the long-lived dashboard daemon.
 */
export function computeReportInWorker<A>(
  report: DashboardReportName,
  options: ReportComputeOptions,
  reportsDir: string,
): Effect.Effect<A, Error> {
  const outPath = join(reportsDir, `${report}.compute-${process.pid}-${randomUUID()}.json`);
  return computeReportInSubprocess<A>(report, options, outPath).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        try {
          unlinkSync(outPath);
        } catch {
          // The worker may fail before writing an output file.
        }
      }),
    ),
  );
}

export function computeReportInSubprocess<A>(
  report: DashboardReportName,
  options: ReportComputeOptions,
  outPath: string,
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: async () => {
      const workerCommand = reportWorkerCommand();
      const child = Bun.spawn(
        [...workerCommand, ...reportWorkerArguments(report, options, outPath)],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const killTimer = setTimeout(() => child.kill(), WORKER_TIMEOUT_MS);
      try {
        const [stderrText, exitCode] = await Promise.all([
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exitCode !== 0) {
          throw new Error(
            `SelfTune report worker for ${report} exited with ${exitCode}: ${stderrText.slice(-500)}`,
          );
        }
        return JSON.parse(await Bun.file(outPath).text()) as A;
      } finally {
        clearTimeout(killTimer);
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}
