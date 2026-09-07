import { afterEach, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Result } from "effect";

import {
  RegistryStateStorage,
  keepRegistryState,
  makeRegistryStateStoreLayer,
} from "../../packages/runtime/registry/registry-state-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(raw: string) {
  const root = mkdtempSync(join(tmpdir(), "selftune-registry-layer-"));
  roots.push(root);
  const lockPath = join(root, "registry-state.json.lock");
  writeFileSync(lockPath, raw);
  return { root, lockPath };
}

test.each([
  "{",
  "null",
  "[]",
  "{}",
  '{"acquiredAt":1,"hostname":"test","nonce":"old","pid":"404"}',
])("recovers malformed stale lock data through the owning layer: %s", async (raw) => {
  const { root } = fixture(raw);
  let probes = 0;
  let nonce = 0;
  const value = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* RegistryStateStorage;
      return yield* store.withTransaction((latest) => Effect.succeed(keepRegistryState(latest)));
    }).pipe(
      Effect.provide(
        Layer.provide(
          makeRegistryStateStoreLayer({
            configDirectory: root,
            ownerHostname: "test",
            isProcessAlive: () => {
              probes += 1;
              return true;
            },
            now: () => Date.now() + 60_000,
            lockStaleMs: 10,
            lockRetryMs: 1,
            randomNonce: () => `nonce-${++nonce}`,
          }),
          BunServices.layer,
        ),
      ),
    ),
  );
  expect(value).toEqual([]);
  expect(probes).toBe(0);
  expect(readdirSync(root)).toEqual([]);
});

test.each([
  { label: "fresh malformed", raw: "{", lockStaleMs: 60_000 },
  {
    label: "live owner with extensions",
    raw: JSON.stringify({
      acquiredAt: 1,
      hostname: "test",
      nonce: "live",
      pid: 404,
      extension: { enabled: true },
    }),
    lockStaleMs: 0,
  },
])("does not steal a %s lock", async ({ raw, lockStaleMs }) => {
  const { root, lockPath } = fixture(raw);
  let clock = Date.now();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* RegistryStateStorage;
      return yield* store.withTransaction(() => Effect.succeed(keepRegistryState("unexpected")));
    }).pipe(
      Effect.result,
      Effect.provide(
        Layer.provide(
          makeRegistryStateStoreLayer({
            configDirectory: root,
            ownerHostname: "test",
            isProcessAlive: () => true,
            now: () => (clock += 5),
            lockStaleMs,
            lockTimeoutMs: 20,
            lockRetryMs: 1,
          }),
          BunServices.layer,
        ),
      ),
    ),
  );
  expect(Result.isFailure(result)).toBeTrue();
  if (Result.isFailure(result))
    expect(result.failure.message).toContain("Timed out waiting for registry state lock");
  expect(readFileSync(lockPath, "utf8")).toBe(raw);
});
