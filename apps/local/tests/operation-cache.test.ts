import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { makeMaterializedCache } from "../src/operation-cache.js";

const run = Effect.runPromise;

describe("makeMaterializedCache", () => {
  test("serves repeated reads from one computation", async () => {
    let computed = 0;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeMaterializedCache(
          Effect.sync(() => {
            computed += 1;
            return computed;
          }),
          { readVersion: () => "v1" },
        );
        const first = yield* cache.read;
        const second = yield* cache.read;
        return [first, second];
      }),
    );
    expect(await run(program)).toEqual([1, 1]);
    expect(computed).toBe(1);
  });

  test("concurrent readers join one in-flight computation", async () => {
    let computed = 0;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeMaterializedCache(
          Effect.gen(function* () {
            computed += 1;
            yield* Effect.sleep("50 millis");
            return computed;
          }),
          { readVersion: () => "v1" },
        );
        return yield* Effect.all([cache.read, cache.read, cache.read], {
          concurrency: "unbounded",
        });
      }),
    );
    expect(await run(program)).toEqual([1, 1, 1]);
    expect(computed).toBe(1);
  });

  test("invalidate forces the next read to recompute inline", async () => {
    let computed = 0;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeMaterializedCache(
          Effect.sync(() => {
            computed += 1;
            return computed;
          }),
          { readVersion: () => "v1" },
        );
        const first = yield* cache.read;
        yield* cache.invalidate;
        const second = yield* cache.read;
        return [first, second];
      }),
    );
    expect(await run(program)).toEqual([1, 2]);
    expect(computed).toBe(2);
  });

  test("a version change refreshes in the background while reads stay served", async () => {
    let computed = 0;
    let version = "v1";
    const program = Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeMaterializedCache(
          Effect.sync(() => {
            computed += 1;
            return computed;
          }),
          { readVersion: () => version, refreshIntervalMs: 10 },
        );
        const first = yield* cache.read;
        version = "v2";
        let refreshed = yield* cache.read;
        for (let i = 0; i < 100 && refreshed === first; i += 1) {
          yield* Effect.sleep("10 millis");
          refreshed = yield* cache.read;
        }
        return [first, refreshed];
      }),
    );
    expect(await run(program)).toEqual([1, 2]);
    expect(computed).toBe(2);
  });

  test("settles on the version observed after computation", async () => {
    let computed = 0;
    let snapshotWrites = 0;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeMaterializedCache(
          Effect.sync(() => {
            computed += 1;
            snapshotWrites += 1;
            return computed;
          }),
          // Snapshot bookkeeping is intentionally outside this report's dependency token.
          { readVersion: () => "tracked-input-v1", refreshIntervalMs: 10, refreshTtlMs: 60_000 },
        );
        const first = yield* cache.read;
        yield* Effect.sleep("40 millis");
        const afterSeveralTicks = yield* cache.read;
        return [first, afterSeveralTicks];
      }),
    );
    expect(await run(program)).toEqual([1, 1]);
    expect(computed).toBe(1);
    expect(snapshotWrites).toBe(1);
  });

  test("preserves every dependency race until a follow-up refresh observes a stable version", async () => {
    let computed = 0;
    let version = "v1";
    const program = Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const secondRelease = yield* Deferred.make<void>();
        const cache = yield* makeMaterializedCache(
          Effect.gen(function* () {
            computed += 1;
            if (computed === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(firstRelease);
            }
            if (computed === 2) {
              yield* Deferred.succeed(secondStarted, undefined);
              yield* Deferred.await(secondRelease);
            }
            return computed;
          }),
          { readVersion: () => version, refreshIntervalMs: 10, refreshTtlMs: 60_000 },
        );
        const firstRead = yield* cache.read.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(firstStarted);
        version = "v2";
        yield* Deferred.succeed(firstRelease, undefined);
        const first = yield* Fiber.join(firstRead);
        yield* Deferred.await(secondStarted);
        version = "v3";
        yield* Deferred.succeed(secondRelease, undefined);
        let refreshed = yield* cache.read;
        for (let i = 0; i < 100 && refreshed < 3; i += 1) {
          yield* Effect.sleep("10 millis");
          refreshed = yield* cache.read;
        }
        yield* Effect.sleep("30 millis");
        return [first, refreshed, yield* cache.read];
      }),
    );
    expect(await run(program)).toEqual([1, 3, 3]);
    expect(computed).toBe(3);
  });

  test("uses the supplied dependency version instead of unrelated changes", async () => {
    let computed = 0;
    let relevantVersion = "skills:1";
    let unrelatedDatabaseVersion = "uploads:1";
    const program = Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeMaterializedCache(
          Effect.sync(() => {
            computed += 1;
            return computed;
          }),
          { readVersion: () => relevantVersion, refreshIntervalMs: 10, refreshTtlMs: 60_000 },
        );
        const first = yield* cache.read;
        unrelatedDatabaseVersion = "uploads:2";
        yield* Effect.sleep("40 millis");
        const afterUnrelatedWrite = yield* cache.read;
        relevantVersion = `${unrelatedDatabaseVersion}:skills:2`;
        let afterRelevantWrite = yield* cache.read;
        for (let i = 0; i < 100 && afterRelevantWrite === first; i += 1) {
          yield* Effect.sleep("10 millis");
          afterRelevantWrite = yield* cache.read;
        }
        return [first, afterUnrelatedWrite, afterRelevantWrite];
      }),
    );
    expect(await run(program)).toEqual([1, 1, 2]);
    expect(computed).toBe(2);
  });

  test("persists an artifact and boots the next cache from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selftune-report-cache-"));
    const artifactPath = join(dir, "report.json");
    try {
      let computed = 0;
      const makeCache = makeMaterializedCache(
        Effect.sync(() => {
          computed += 1;
          return computed;
        }),
        { readVersion: () => "v1", artifactPath, schema: Schema.Number, refreshIntervalMs: 10 },
      );
      const first = await run(Effect.scoped(Effect.flatMap(makeCache, (cache) => cache.read)));
      expect(first).toBe(1);
      expect(
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ data: Schema.Number })))(
          readFileSync(artifactPath, "utf8"),
        ).data,
      ).toBe(1);

      // A fresh cache serves the persisted value immediately, then the refresh loop
      // recomputes in the background because the artifact counts as stale at boot.
      const [booted, eventually] = await run(
        Effect.scoped(
          Effect.gen(function* () {
            const cache = yield* makeCache;
            const bootValue = yield* cache.read;
            let refreshed = yield* cache.read;
            for (let i = 0; i < 100 && refreshed === bootValue; i += 1) {
              yield* Effect.sleep("10 millis");
              refreshed = yield* cache.read;
            }
            return [bootValue, refreshed];
          }),
        ),
      );
      expect(booted).toBe(1);
      expect(eventually).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("failures are not cached", async () => {
    let attempts = 0;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeMaterializedCache(
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1 ? Effect.fail(new Error("transient")) : Effect.succeed(attempts);
          }),
          { readVersion: () => "v1" },
        );
        const first = yield* Effect.result(cache.read);
        const second = yield* cache.read;
        return { failedFirst: first._tag === "Failure", second };
      }),
    );
    expect(await run(program)).toEqual({ failedFirst: true, second: 2 });
  });

  test("retains a persisted artifact when a background refresh fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selftune-report-cache-"));
    const artifactPath = join(dir, "report.json");
    try {
      writeFileSync(
        artifactPath,
        JSON.stringify({ schema_version: 1, generated_at: "2026-07-23T00:00:00.000Z", data: 7 }),
      );
      let version = "v1";
      let attempts = 0;
      const program = Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* makeMaterializedCache(
            Effect.suspend(() => {
              attempts += 1;
              return Effect.fail(new Error("worker unavailable"));
            }),
            {
              artifactPath,
              schema: Schema.Number,
              readVersion: () => version,
              refreshIntervalMs: 10,
              refreshTtlMs: 60_000,
            },
          );
          const booted = yield* cache.read;
          version = "v2";
          yield* Effect.sleep("120 millis");
          const afterFailure = yield* cache.read;
          return [booted, afterFailure, attempts];
        }),
      );
      const [booted, afterFailure, attemptsAfter] = await run(program);
      expect([booted, afterFailure]).toEqual([7, 7]);
      expect(attemptsAfter).toBeGreaterThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
