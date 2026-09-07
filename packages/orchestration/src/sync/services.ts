import { Context, Effect, Schema } from "effect";

import type {
  SyncAuditError,
  SyncAuditSuccess,
  SyncDefaults,
  SyncImportSources,
  SyncOptions,
  SyncProgressCallback,
  SyncResult,
} from "./model.js";

export class SyncInternalFailure extends Schema.TaggedErrorClass<SyncInternalFailure>()(
  "SyncInternalFailure",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export function syncInternalFailure(operation: string, cause: unknown): SyncInternalFailure {
  return SyncInternalFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

export function isSyncInternalFailure(cause: unknown): cause is SyncInternalFailure {
  return cause instanceof SyncInternalFailure;
}

export interface LoadedSyncPreferences {
  readonly importSources: SyncImportSources;
  readonly defaults: SyncDefaults;
}

export interface SyncPreferencesService {
  readonly load: () => Effect.Effect<LoadedSyncPreferences, SyncInternalFailure>;
}

export class SyncPreferences extends Context.Service<SyncPreferences, SyncPreferencesService>()(
  "@selftune/orchestration/SyncPreferences",
) {}

export interface SyncCoreService {
  readonly run: (
    options: SyncOptions,
    onProgress?: SyncProgressCallback,
  ) => Effect.Effect<SyncResult, SyncInternalFailure>;
}

export class SyncCore extends Context.Service<SyncCore, SyncCoreService>()(
  "@selftune/orchestration/SyncCore",
) {}

export interface SyncAuditService {
  readonly recordSuccess: (audit: SyncAuditSuccess) => Effect.Effect<void, SyncInternalFailure>;
  readonly recordError: (audit: SyncAuditError) => Effect.Effect<void, SyncInternalFailure>;
}

export class SyncAudit extends Context.Service<SyncAudit, SyncAuditService>()(
  "@selftune/orchestration/SyncAudit",
) {}

export interface SyncProgressService {
  readonly report: (message: string) => void;
}

export class SyncProgress extends Context.Service<SyncProgress, SyncProgressService>()(
  "@selftune/orchestration/SyncProgress",
) {}

export type SyncRuntime = SyncPreferences | SyncCore | SyncAudit;
export type SyncProgramRuntime = SyncRuntime | SyncProgress;
