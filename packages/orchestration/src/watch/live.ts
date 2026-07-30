import type { Database } from "bun:sqlite";

import { Effect, Layer } from "effect";

import { acquireSingletonDatabaseLease, LocalDatabaseService } from "@selftune/local-store";
import {
  evaluateWatch,
  makeWatchEvaluationDependencies,
  type WatchDiagnostic,
  type WatchEvaluationOptions,
  type WatchEvaluationResult,
} from "@selftune/runtime/monitoring/watch";
import { updateContextAfterWatch } from "@selftune/runtime/memory/writer";
import type { SyncResult } from "@selftune/source-management/sync";

import { createDefaultSyncOptions } from "../sync.js";
import { syncSourcesLive } from "../sync/live-source.js";
import type { WatchMemoryUpdate, WatchRollbackRequest, WatchRollbackResult } from "./model.js";
import {
  WatchEvaluation,
  WatchMemory,
  WatchRollback,
  WatchSourceSync,
  watchInternalFailure,
  type WatchInternalFailure,
  type WatchRuntime,
} from "./services.js";

type WatchOperation<A> = Effect.Effect<A, WatchInternalFailure>;

export interface WatchLiveOverrides {
  readonly databaseLayer?: Layer.Layer<LocalDatabaseService, WatchInternalFailure>;
  readonly sync?: (force: boolean, database: Database) => WatchOperation<SyncResult>;
  readonly evaluate?: (
    options: WatchEvaluationOptions,
    database: Database,
    onDiagnostic: (diagnostic: WatchDiagnostic) => void,
  ) => WatchOperation<WatchEvaluationResult>;
  readonly rollback?: (request: WatchRollbackRequest) => WatchOperation<WatchRollbackResult>;
  readonly updateMemory?: (input: WatchMemoryUpdate) => WatchOperation<void>;
}

const databaseLayer = Layer.effect(
  LocalDatabaseService,
  Effect.acquireRelease(
    Effect.try({
      try: acquireSingletonDatabaseLease,
      catch: (cause) => watchInternalFailure("database", cause),
    }),
    ({ release }) => Effect.sync(release),
  ),
);

function defaultSourceSync(force: boolean, database: Database): WatchOperation<SyncResult> {
  return syncSourcesLive(
    createDefaultSyncOptions({ force, dryRun: false }),
    {},
    undefined,
    database,
  ).pipe(Effect.mapError((cause) => watchInternalFailure("source-sync", cause)));
}

function defaultEvaluation(
  options: WatchEvaluationOptions,
  database: Database,
  onDiagnostic: (diagnostic: WatchDiagnostic) => void,
): WatchOperation<WatchEvaluationResult> {
  return Effect.try({
    try: () => evaluateWatch(options, makeWatchEvaluationDependencies(database, onDiagnostic)),
    catch: (cause) => watchInternalFailure("evaluation", cause),
  });
}

function isModuleResolutionFailure(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ERR_MODULE_NOT_FOUND" || cause.code === "MODULE_NOT_FOUND")
  );
}

async function runDefaultRollback(request: WatchRollbackRequest): Promise<WatchRollbackResult> {
  let rollback: (request: WatchRollbackRequest) => Promise<WatchRollbackResult>;
  try {
    const rollbackModule = await import("@selftune/runtime/evolution/rollback");
    rollback = rollbackModule.rollback;
  } catch (cause) {
    if (isModuleResolutionFailure(cause)) {
      return {
        rolledBack: false,
        restoredDescription: "",
        reason: "Rollback module not available",
      };
    }
    throw cause;
  }
  return await rollback(request);
}

function defaultRollback(request: WatchRollbackRequest): WatchOperation<WatchRollbackResult> {
  return Effect.tryPromise({
    try: () => runDefaultRollback(request),
    catch: (cause) => watchInternalFailure("rollback", cause),
  });
}

function defaultMemory(input: WatchMemoryUpdate): WatchOperation<void> {
  return Effect.try({
    try: () => updateContextAfterWatch(input.skillName, input.snapshot),
    catch: (cause) => watchInternalFailure("memory", cause),
  });
}

function makeSourceSyncLayer(overrides: WatchLiveOverrides) {
  return Layer.effect(
    WatchSourceSync,
    Effect.gen(function* () {
      const database = yield* LocalDatabaseService;
      const sync = overrides.sync ?? defaultSourceSync;
      return {
        run: Effect.fn("selftune.orchestration.watch.sourceSync")(function* (force) {
          return yield* sync(force, database.sqlite);
        }),
      };
    }),
  );
}

function makeEvaluationLayer(overrides: WatchLiveOverrides) {
  return Layer.effect(
    WatchEvaluation,
    Effect.gen(function* () {
      const database = yield* LocalDatabaseService;
      const evaluate = overrides.evaluate ?? defaultEvaluation;
      return {
        run: Effect.fn("selftune.orchestration.watch.evaluate")(function* (options, onDiagnostic) {
          return yield* evaluate(options, database.sqlite, onDiagnostic);
        }),
      };
    }),
  );
}

function makeRollbackLayer(overrides: WatchLiveOverrides) {
  const rollback = overrides.rollback ?? defaultRollback;
  return Layer.succeed(WatchRollback, {
    run: Effect.fn("selftune.orchestration.watch.rollback")(function* (request) {
      return yield* rollback(request);
    }),
  });
}

function makeMemoryLayer(overrides: WatchLiveOverrides) {
  const updateMemory = overrides.updateMemory ?? defaultMemory;
  return Layer.succeed(WatchMemory, {
    update: Effect.fn("selftune.orchestration.watch.memory")(function* (input) {
      return yield* updateMemory(input);
    }),
  });
}

export function makeWatchLiveLayer(
  overrides: WatchLiveOverrides = {},
): Layer.Layer<WatchRuntime, WatchInternalFailure> {
  const databaseServices = Layer.merge(
    makeSourceSyncLayer(overrides),
    makeEvaluationLayer(overrides),
  ).pipe(Layer.provide(overrides.databaseLayer ?? databaseLayer));
  return Layer.mergeAll(databaseServices, makeRollbackLayer(overrides), makeMemoryLayer(overrides));
}

export const watchLiveLayer = makeWatchLiveLayer();
