import { Effect, Schema } from "effect";

/**
 * Harness-native source import boundary.
 *
 * Adapters live only in the local runtime. They normalize scanning and
 * checkpoint behavior without leaking source paths or implementations to
 * client-facing harness descriptors.
 */
export interface HarnessSourceSyncRequest {
  /** Harness-native directory or database root to scan. */
  readonly sourceRoot: string;
  /** Ignore source records older than this timestamp. */
  readonly since?: Date;
  /** Report work without persisting imported records or checkpoints. */
  readonly dryRun: boolean;
  /** Reprocess sources even when an adapter checkpoint already exists. */
  readonly force: boolean;
  /** Compatibility path for skill-usage output during the SQLite transition. */
  readonly skillLogPath: string;
}

export type HarnessSourceProgressCallback = (message: string) => void;

export interface HarnessSourceSyncResult {
  readonly available: boolean;
  readonly scanned: number;
  readonly synced: number;
  readonly skipped: number;
  /** Durable source files used for a successful import, when the source is file based. */
  readonly authoritativeFiles?: ReadonlyArray<string>;
}

export class HarnessSourceSyncFailure extends Schema.TaggedErrorClass<HarnessSourceSyncFailure>()(
  "HarnessSourceSyncFailure",
  {
    adapter_id: Schema.String,
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export function harnessSourceSyncFailure(
  adapterId: string,
  operation: string,
  cause: unknown,
): HarnessSourceSyncFailure {
  return HarnessSourceSyncFailure.make({
    adapter_id: adapterId,
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

export interface HarnessSourceAdapter<R = never> {
  /** Must match the owning harness runtime id. */
  readonly id: string;
  /** Named source phase, for example `claude`, `codex`, or `opencode`. */
  readonly phase: string;
  readonly sync: (
    request: HarnessSourceSyncRequest,
    onProgress?: HarnessSourceProgressCallback,
  ) => Effect.Effect<HarnessSourceSyncResult, HarnessSourceSyncFailure, R>;
}

export class HarnessSourceRegistryError extends Error {
  readonly code: "DUPLICATE_SOURCE_ADAPTER" | "INVALID_SOURCE_ADAPTER";

  constructor(code: HarnessSourceRegistryError["code"], message: string) {
    super(message);
    this.name = "HarnessSourceRegistryError";
    this.code = code;
  }
}

export interface HarnessSourceRegistry<R = never> {
  readonly adapters: ReadonlyArray<HarnessSourceAdapter<R>>;
  get(id: string): HarnessSourceAdapter<R> | undefined;
}

export function createHarnessSourceRegistry<R>(
  adapters: ReadonlyArray<HarnessSourceAdapter<R>>,
): HarnessSourceRegistry<R> {
  const byId = new Map<string, HarnessSourceAdapter<R>>();
  for (const adapter of adapters) {
    if (adapter.phase.trim().length === 0) {
      throw new HarnessSourceRegistryError(
        "INVALID_SOURCE_ADAPTER",
        `Source adapter ${adapter.id} must declare a non-empty phase.`,
      );
    }
    if (byId.has(adapter.id)) {
      throw new HarnessSourceRegistryError(
        "DUPLICATE_SOURCE_ADAPTER",
        `Source adapter ${adapter.id} is registered more than once.`,
      );
    }
    byId.set(adapter.id, adapter);
  }

  return {
    adapters: [...adapters],
    get: (id) => byId.get(id),
  };
}
