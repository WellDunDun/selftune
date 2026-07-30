import { Context, Effect, Schema } from "effect";

import type {
  WatchDiagnostic,
  WatchEvaluationOptions,
  WatchEvaluationResult,
} from "@selftune/runtime/monitoring/watch";
import type { SyncResult } from "@selftune/source-management/sync";

import type { WatchMemoryUpdate, WatchRollbackRequest, WatchRollbackResult } from "./model.js";

export class WatchInternalFailure extends Schema.TaggedErrorClass<WatchInternalFailure>()(
  "WatchInternalFailure",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export function watchInternalFailure(operation: string, cause: unknown): WatchInternalFailure {
  return WatchInternalFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

export function isWatchInternalFailure(cause: unknown): cause is WatchInternalFailure {
  return cause instanceof WatchInternalFailure;
}

export interface WatchSourceSyncService {
  readonly run: (force: boolean) => Effect.Effect<SyncResult, WatchInternalFailure>;
}

export class WatchSourceSync extends Context.Service<WatchSourceSync, WatchSourceSyncService>()(
  "@selftune/orchestration/WatchSourceSync",
) {}

export interface WatchEvaluationService {
  readonly run: (
    options: WatchEvaluationOptions,
    onDiagnostic: (diagnostic: WatchDiagnostic) => void,
  ) => Effect.Effect<WatchEvaluationResult, WatchInternalFailure>;
}

export class WatchEvaluation extends Context.Service<WatchEvaluation, WatchEvaluationService>()(
  "@selftune/orchestration/WatchEvaluation",
) {}

export interface WatchRollbackService {
  readonly run: (
    request: WatchRollbackRequest,
  ) => Effect.Effect<WatchRollbackResult, WatchInternalFailure>;
}

export class WatchRollback extends Context.Service<WatchRollback, WatchRollbackService>()(
  "@selftune/orchestration/WatchRollback",
) {}

export interface WatchMemoryService {
  readonly update: (input: WatchMemoryUpdate) => Effect.Effect<void, WatchInternalFailure>;
}

export class WatchMemory extends Context.Service<WatchMemory, WatchMemoryService>()(
  "@selftune/orchestration/WatchMemory",
) {}

export interface WatchDiagnosticsService {
  readonly report: (message: string) => void;
}

export class WatchDiagnostics extends Context.Service<WatchDiagnostics, WatchDiagnosticsService>()(
  "@selftune/orchestration/WatchDiagnostics",
) {}

export type WatchRuntime = WatchSourceSync | WatchEvaluation | WatchRollback | WatchMemory;

export type WatchProgramRuntime = WatchRuntime | WatchDiagnostics;
