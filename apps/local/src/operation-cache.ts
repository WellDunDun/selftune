import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { getDb } from "@selftune/local-store";

// Cheap change detector for the local database: `PRAGMA data_version` moves when another
// connection commits (hooks, CLI runs), `total_changes()` when this connection writes.
// Both counters are connection-relative, so the key is only comparable within one boot.
function localDatabaseVersion(): string {
  try {
    const db = getDb();
    const dataVersion = db
      .query<{ data_version: number }, []>("PRAGMA data_version")
      .get()?.data_version;
    const totalChanges = db
      .query<{ total_changes: number }, []>("SELECT total_changes() AS total_changes")
      .get()?.total_changes;
    return `${dataVersion ?? 0}:${totalChanges ?? 0}`;
  } catch {
    return `unversioned:${Date.now()}`;
  }
}

export interface CachedOperation<A, E, R> {
  readonly read: Effect.Effect<A, E, R>;
  readonly invalidate: Effect.Effect<void>;
}

export function makeMaterializedCacheLayer<I, A, E, R>(
  key: Context.Service<I, CachedOperation<A, E, R>>,
  compute: Effect.Effect<A, E, R>,
  options: MaterializedCacheOptions<A> = {},
) {
  return Layer.effect(key)(makeMaterializedCache(compute, options));
}

interface CacheRefreshOptions {
  readonly readVersion?: () => string;
  /** Cadence of the background refresh loop (also the version-check cadence). */
  readonly refreshIntervalMs?: number;
  /** Recompute even without a version change, to pick up changes that bypass the database. */
  readonly refreshTtlMs?: number;
}

export type MaterializedCacheOptions<A> = CacheRefreshOptions &
  (
    | { readonly artifactPath?: undefined }
    | { readonly artifactPath: string; readonly schema: Schema.Codec<A> }
  );

interface Artifact<A> {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly data: A;
}

function readArtifact<A>(options: MaterializedCacheOptions<A>): { readonly value: A } | null {
  if (options.artifactPath === undefined) return null;
  try {
    const schema = Schema.fromJsonString(
      Schema.Struct({
        schema_version: Schema.Literal(1),
        generated_at: Schema.String,
        data: options.schema,
      }),
    );
    const envelope = Schema.decodeUnknownSync(schema)(readFileSync(options.artifactPath, "utf8"), {
      onExcessProperty: "preserve",
    });
    return { value: envelope.data };
  } catch {
    // Missing or corrupt artifact — recomputed by the refresh loop.
  }
  return null;
}

function writeArtifact<A>(path: string | undefined, data: A): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const artifact: Artifact<A> = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      data,
    };
    const staging = `${path}.tmp-${process.pid}`;
    writeFileSync(staging, JSON.stringify(artifact));
    renameSync(staging, path);
  } catch {
    // Persistence is best-effort; the in-memory value still serves.
  }
}

// The portfolio audit and skill-intelligence report take seconds to compute, so requests
// must never wait on recomputation. Reads always return the current value: at boot that
// is the artifact persisted by the previous run, and afterwards whatever the refresh
// loop last produced. The loop — parked on a latch until the first read, so building the
// operations layer in tests never computes — recomputes when the database version moves
// or the TTL lapses, and persists each result. Only two situations compute inline, with
// concurrent readers joining one in-flight run: the very first read ever (no artifact)
// and the first read after an explicit invalidation, which mutating operations use so
// their next read observes their own write. Failures are never cached, and a failed
// background refresh keeps the previous value.
export function makeMaterializedCache<A, E, R>(
  compute: Effect.Effect<A, E, R>,
  options: MaterializedCacheOptions<A> = {},
): Effect.Effect<CachedOperation<A, E, R>, never, Scope.Scope | R> {
  const readVersion = options.readVersion ?? localDatabaseVersion;
  const refreshIntervalMs = options.refreshIntervalMs ?? 60_000;
  const refreshTtlMs = options.refreshTtlMs ?? 5 * 60 * 1_000;
  return Effect.gen(function* () {
    let latest = readArtifact(options);
    let version: string | null = null;
    let refreshedAt = 0;
    let pendingRefreshGeneration = 0;

    const record = (value: A, versionBeforeCompute: string) =>
      Effect.sync(() => {
        latest = { value };
        refreshedAt = Date.now();
        // A report may write one of its own dependent tables as part of its work. Record
        // the version after that write commits, otherwise the next polling interval sees
        // the report's own change as external work and starts another refresh.
        const versionAfterCompute = readVersion();
        version = versionAfterCompute;
        // Do not discard a concurrent write that landed while this report was running.
        // The result is still useful, but one follow-up refresh is required to include it.
        if (versionAfterCompute !== versionBeforeCompute) pendingRefreshGeneration += 1;
        writeArtifact(options.artifactPath, value);
      });

    const [sharedCompute, invalidateShared] = yield* Effect.cachedInvalidateWithTTL(
      Effect.suspend(() => {
        const versionBeforeCompute = readVersion();
        return Effect.tap(compute, (value) => record(value, versionBeforeCompute));
      }),
      "1 hour",
    );

    const stale = (): boolean => {
      if (pendingRefreshGeneration > 0) return true;
      if (Date.now() - refreshedAt >= refreshTtlMs) return true;
      const current = readVersion();
      if (current === version) return false;
      return true;
    };

    const refreshTick = Effect.suspend(() => {
      // No value yet means an initial read is (or should be) computing — join it rather
      // than invalidating the in-flight run.
      if (latest === null) return Effect.ignore(sharedCompute);
      if (!stale()) return Effect.void;
      const pendingGenerationAtStart = pendingRefreshGeneration;
      return Effect.flatMap(invalidateShared, () =>
        sharedCompute.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              // Keep any newer race that was observed while this follow-up was running.
              if (pendingRefreshGeneration === pendingGenerationAtStart) {
                pendingRefreshGeneration = 0;
              }
            }),
          ),
          Effect.onError(() => invalidateShared),
        ),
      ).pipe(Effect.ignore);
    });

    const started = yield* Latch.make(false);
    yield* Effect.forkScoped(
      Effect.flatMap(started.await, () =>
        Effect.repeat(refreshTick, Schedule.spaced(refreshIntervalMs)),
      ).pipe(Effect.ignore),
    );

    const read: Effect.Effect<A, E, R> = Effect.suspend(() => {
      started.openUnsafe();
      if (latest !== null) return Effect.succeed(latest.value);
      return sharedCompute.pipe(Effect.onError(() => invalidateShared));
    });

    return {
      read,
      invalidate: Effect.flatMap(
        Effect.sync(() => {
          latest = null;
          version = null;
          pendingRefreshGeneration = 0;
        }),
        () => invalidateShared,
      ),
    };
  });
}
