import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import { resolveSelftunePaths } from "@selftune/config";

import {
  decodeReportOutput,
  ReportComputeError,
  type DashboardReportName,
  type DashboardReportPayloads,
  type ReportComputeOptions,
  type ReportComputeStoragePaths,
} from "./report-contract.js";
export type {
  DashboardReportName,
  ReportComputeOptions,
  ReportComputeStoragePaths,
} from "./report-contract.js";

const WORKER_TIMEOUT_MS = 180_000;

export interface ReportWorkerProcessOptions {
  readonly command?: readonly string[];
  readonly timeoutMs?: number;
}

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
export function computeReportInWorker<Name extends DashboardReportName>(
  report: Name,
  options: ReportComputeOptions,
  reportsDir: string,
  processOptions: ReportWorkerProcessOptions = {},
): Effect.Effect<DashboardReportPayloads[Name], ReportComputeError> {
  const outPath = join(reportsDir, `${report}.compute-${process.pid}-${randomUUID()}.json`);
  return computeReportInSubprocess(report, options, outPath, processOptions).pipe(
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

export function computeReportInSubprocess<Name extends DashboardReportName>(
  report: Name,
  options: ReportComputeOptions,
  outPath: string,
  processOptions: ReportWorkerProcessOptions = {},
): Effect.Effect<DashboardReportPayloads[Name], ReportComputeError> {
  return Effect.tryPromise({
    try: async () => {
      const workerCommand = processOptions.command ?? reportWorkerCommand();
      const child = Bun.spawn(
        [...workerCommand, ...reportWorkerArguments(report, options, outPath)],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const killTimer = setTimeout(
        () => child.kill(),
        processOptions.timeoutMs ?? WORKER_TIMEOUT_MS,
      );
      try {
        const [stderrText, exitCode] = await Promise.all([
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exitCode !== 0) {
          throw new ReportComputeError({
            report,
            exitCode,
            message: `SelfTune report worker for ${report} exited with ${exitCode}: ${stderrText.slice(-500)}`,
          });
        }
        return decodeReportOutput(report, await Bun.file(outPath).text());
      } finally {
        clearTimeout(killTimer);
      }
    },
    catch: (cause) => ReportComputeError.fromCause(report, cause),
  });
}
