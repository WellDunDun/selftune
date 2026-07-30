import { afterEach, describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Deferred, Effect, Fiber, FileSystem, Result } from "effect";
import { systemError } from "effect/PlatformError";

import {
  commitRegistryState,
  keepRegistryState,
  makeRegistryStateStore,
  registryStateEntriesMatch,
  type RegistryStateStore,
  upsertRegistryStateEntry,
} from "../../packages/runtime/registry/registry-state-store.js";
import { RegistryStateValidationError } from "../../packages/runtime/registry/registry-state.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-registry-state-"));
  roots.push(root);
  return root;
}

function entry(root: string, name: string, versionHash = "hash-1") {
  return {
    entryId: `entry-${name}`,
    name,
    versionHash,
    installPath: join(root, "repo", ".claude", "skills", name),
  };
}

async function makeStore(
  configDirectory: string,
  options: Parameters<typeof makeRegistryStateStore>[0] = { configDirectory },
): Promise<RegistryStateStore> {
  return Effect.runPromise(
    makeRegistryStateStore({ ...options, configDirectory }).pipe(Effect.provide(BunServices.layer)),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RegistryStateStore", () => {
  test("writes atomically inside the configured directory and cleans lock artifacts", async () => {
    const root = makeRoot();
    const configDirectory = join(root, "custom-config");
    const store = await makeStore(configDirectory, { configDirectory, randomNonce: () => "one" });
    const expected = entry(root, "deploy");

    const value = await Effect.runPromise(
      store.withTransaction((latest) =>
        Effect.succeed(commitRegistryState(upsertRegistryStateEntry(latest, expected), "saved")),
      ),
    );

    expect(value).toBe("saved");
    expect(JSON.parse(readFileSync(join(configDirectory, "registry-state.json"), "utf8"))).toEqual([
      expected,
    ]);
    expect(statSync(join(configDirectory, "registry-state.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(configDirectory)).toEqual(["registry-state.json"]);
  });

  test("serializes concurrent transactions and merges changes from different entries", async () => {
    const root = makeRoot();
    const configDirectory = join(root, "config");
    const store = await makeStore(configDirectory, { configDirectory, lockRetryMs: 2 });
    const firstEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseFirst = await Effect.runPromise(Deferred.make<void>());
    const secondStarted = await Effect.runPromise(Deferred.make<void>());

    const firstFiber = Effect.runFork(
      store.withTransaction((latest) =>
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.as(
            commitRegistryState(upsertRegistryStateEntry(latest, entry(root, "deploy")), 1),
          ),
        ),
      ),
    );
    await Effect.runPromise(Deferred.await(firstEntered));

    const secondFiber = Effect.runFork(
      Deferred.succeed(secondStarted, undefined).pipe(
        Effect.andThen(
          store.withTransaction((latest) =>
            Effect.succeed(
              commitRegistryState(upsertRegistryStateEntry(latest, entry(root, "review")), 2),
            ),
          ),
        ),
      ),
    );
    await Effect.runPromise(Deferred.await(secondStarted));
    await Effect.runPromise(Effect.sleep("20 millis"));
    await Effect.runPromise(Deferred.succeed(releaseFirst, undefined));
    const results = await Effect.runPromise(
      Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)]),
    );

    expect(results).toEqual([1, 2]);
    expect((await Effect.runPromise(store.load())).map((item) => item.name).toSorted()).toEqual([
      "deploy",
      "review",
    ]);
  });

  test("shows a queued same-entry transaction the freshly committed hash", async () => {
    const root = makeRoot();
    const configDirectory = join(root, "config");
    const store = await makeStore(configDirectory, { configDirectory, lockRetryMs: 2 });
    const initial = entry(root, "deploy", "hash-1");
    await Effect.runPromise(
      store.withTransaction(() => Effect.succeed(commitRegistryState([initial], undefined))),
    );
    const firstEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseFirst = await Effect.runPromise(Deferred.make<void>());
    const secondStarted = await Effect.runPromise(Deferred.make<void>());
    let installs = 0;

    const firstFiber = Effect.runFork(
      store.withTransaction((latest) =>
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.map(() => {
            installs++;
            return commitRegistryState(
              upsertRegistryStateEntry(latest, entry(root, "deploy", "hash-2")),
              true,
            );
          }),
        ),
      ),
    );
    await Effect.runPromise(Deferred.await(firstEntered));
    const secondFiber = Effect.runFork(
      Deferred.succeed(secondStarted, undefined).pipe(
        Effect.andThen(
          store.withTransaction((latest) => {
            const current = latest.find((item) => item.entryId === initial.entryId);
            if (!registryStateEntriesMatch(current, initial)) {
              return Effect.succeed(keepRegistryState(false));
            }
            installs++;
            return Effect.succeed(
              commitRegistryState(
                upsertRegistryStateEntry(latest, entry(root, "deploy", "hash-3")),
                true,
              ),
            );
          }),
        ),
      ),
    );
    await Effect.runPromise(Deferred.await(secondStarted));
    await Effect.runPromise(Effect.sleep("20 millis"));
    await Effect.runPromise(Deferred.succeed(releaseFirst, undefined));

    expect(
      await Effect.runPromise(Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)])),
    ).toEqual([true, false]);
    expect(installs).toBe(1);
    expect((await Effect.runPromise(store.load()))[0]?.versionHash).toBe("hash-2");
  });

  test("releases the lock after callback failure and interruption without masking the failure", async () => {
    const root = makeRoot();
    const configDirectory = join(root, "config");
    const lockPath = join(configDirectory, "registry-state.json.lock");
    const store = await makeStore(configDirectory);
    class CallbackFailure extends Error {}

    const failed = await Effect.runPromise(
      store
        .withTransaction(() => Effect.fail(new CallbackFailure("callback failed")))
        .pipe(Effect.result),
    );
    expect(Result.isFailure(failed) && failed.failure).toBeInstanceOf(CallbackFailure);
    expect(existsSync(lockPath)).toBe(false);

    const entered = await Effect.runPromise(Deferred.make<void>());
    const never = await Effect.runPromise(Deferred.make<void>());
    const fiber = Effect.runFork(
      store.withTransaction(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(never)),
          Effect.as(commitRegistryState([], undefined)),
        ),
      ),
    );
    await Effect.runPromise(Deferred.await(entered));
    expect(existsSync(lockPath)).toBe(true);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(existsSync(lockPath)).toBe(false);
  });

  test("fails closed on malformed input and invalid outgoing state", async () => {
    const root = makeRoot();
    const configDirectory = join(root, "config");
    const statePath = join(configDirectory, "registry-state.json");
    const lockPath = `${statePath}.lock`;
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(statePath, "{not-json");
    const store = await makeStore(configDirectory);
    let callbackCalled = false;

    const malformed = await Effect.runPromise(
      store
        .withTransaction(() => {
          callbackCalled = true;
          return Effect.succeed(commitRegistryState([], undefined));
        })
        .pipe(Effect.result),
    );
    expect(callbackCalled).toBe(false);
    expect(Result.isFailure(malformed) && malformed.failure).toBeInstanceOf(
      RegistryStateValidationError,
    );
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(statePath, "[]");
    const invalidOutgoing = await Effect.runPromise(
      store
        .withTransaction(() =>
          Effect.succeed(
            commitRegistryState(
              [
                {
                  entryId: "entry-deploy",
                  name: "deploy",
                  versionHash: "hash-1",
                  installPath: join(root, "outside", "deploy"),
                },
              ],
              undefined,
            ),
          ),
        )
        .pipe(Effect.result),
    );
    expect(Result.isFailure(invalidOutgoing)).toBe(true);
    expect(readFileSync(statePath, "utf8")).toBe("[]");
    expect(readdirSync(configDirectory)).toEqual(["registry-state.json"]);
  });

  test("cleans the lock and same-directory temp file when the atomic rename fails", async () => {
    const root = makeRoot();
    const configDirectory = join(root, "config");
    const statePath = join(configDirectory, "registry-state.json");
    const initial = entry(root, "deploy", "hash-1");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(statePath, JSON.stringify([initial]));
    const fileSystem = await Effect.runPromise(
      FileSystem.FileSystem.pipe(Effect.provide(BunServices.layer)),
    );
    const failingFileSystem: FileSystem.FileSystem = {
      ...fileSystem,
      rename: (oldPath, newPath) =>
        newPath === statePath
          ? Effect.fail(
              systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: newPath,
                description: "forced rename failure",
              }),
            )
          : fileSystem.rename(oldPath, newPath),
    };
    const store = await Effect.runPromise(
      makeRegistryStateStore({ configDirectory }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      ),
    );

    const outcome = await Effect.runPromise(
      store
        .withTransaction(() =>
          Effect.succeed(commitRegistryState([entry(root, "deploy", "hash-2")], undefined)),
        )
        .pipe(Effect.result),
    );

    expect(Result.isFailure(outcome) && outcome.failure.message).toContain("forced rename failure");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual([initial]);
    expect(readdirSync(configDirectory)).toEqual(["registry-state.json"]);
  });

  test("recovers an old lock only when its owner is no longer alive", async () => {
    const root = makeRoot();
    const configDirectory = join(root, "config");
    const lockPath = join(configDirectory, "registry-state.json.lock");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ acquiredAt: 1, hostname: "test-host", nonce: "dead", pid: 404 }),
    );
    let nonce = 0;
    const store = await makeStore(configDirectory, {
      configDirectory,
      isProcessAlive: () => false,
      lockRetryMs: 1,
      lockStaleMs: 10,
      lockTimeoutMs: 100,
      now: () => Date.now() + 60_000,
      ownerHostname: "test-host",
      ownerPid: 505,
      randomNonce: () => `nonce-${(nonce += 1)}`,
    });

    await Effect.runPromise(
      store.withTransaction((latest) =>
        Effect.succeed(commitRegistryState([...latest, entry(root, "deploy")], undefined)),
      ),
    );

    expect(await Effect.runPromise(store.load())).toEqual([entry(root, "deploy")]);
    expect(readdirSync(configDirectory)).toEqual(["registry-state.json"]);
  });

  test("bounds lock contention without stealing from a live local owner", async () => {
    const root = makeRoot();
    const configDirectory = join(root, "config");
    const lockPath = join(configDirectory, "registry-state.json.lock");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ acquiredAt: 1, hostname: "test-host", nonce: "live", pid: 606 }),
    );
    let clock = Date.now() + 60_000;
    const store = await makeStore(configDirectory, {
      configDirectory,
      isProcessAlive: () => true,
      lockRetryMs: 1,
      lockStaleMs: 1,
      lockTimeoutMs: 20,
      now: () => (clock += 5),
      ownerHostname: "test-host",
    });

    const outcome = await Effect.runPromise(
      store
        .withTransaction(() => Effect.succeed(commitRegistryState([], undefined)))
        .pipe(Effect.result),
    );

    expect(Result.isFailure(outcome) && outcome.failure.message).toContain(
      "Timed out waiting for registry state lock",
    );
    expect(existsSync(lockPath)).toBe(true);
  });
});
