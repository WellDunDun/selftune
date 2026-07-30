import type { WatchResult } from "@selftune/runtime/monitoring/watch";

import type { WatchProgramDiagnostic, WatchProgramResult } from "./model.js";

export function formatWatchDiagnostic(diagnostic: WatchProgramDiagnostic): string {
  return JSON.stringify({
    level: "debug",
    code: diagnostic.code,
    message: diagnostic.message,
  });
}

export function buildWatchProgramResult(watch: WatchResult): WatchProgramResult {
  return {
    watch,
    stdout: [JSON.stringify(watch, null, 2)],
    stderr: [],
    exitCode: watch.alert ? 1 : 0,
  };
}
