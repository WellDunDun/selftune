import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { openDb } from "@selftune/local-store";
import * as Effect from "effect/Effect";

import { makeSqliteInstallerExclusiveCommitLock } from "./sqlite-commit-lock.js";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("SQLite installer exclusive commit lock", () => {
  test("an independent heartbeat keeps a long filesystem await exclusive", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "selftune-commit-heartbeat-")));
    const path = join(root, "selftune.db");
    const firstDb = openDb(path);
    const secondDb = openDb(path);
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const entered = new Promise<void>((resolve) => (firstEntered = resolve));
    const events: string[] = [];
    const generations: number[] = [];
    try {
      const options = { leaseMs: 120, heartbeatMs: 25, pollMs: 5 };
      const firstLock = makeSqliteInstallerExclusiveCommitLock(firstDb, options);
      const secondLock = makeSqliteInstallerExclusiveCommitLock(secondDb, options);
      const first = Effect.runPromise(
        firstLock.withExclusiveCommit((fence) =>
          Effect.tryPromise(async () => {
            generations.push(fence.generation!);
            events.push("first-enter");
            firstEntered();
            await firstGate;
            events.push("first-exit");
          }),
        ),
      );
      await entered;
      const second = Effect.runPromise(
        secondLock.withExclusiveCommit((fence) =>
          Effect.sync(() => {
            generations.push(fence.generation!);
            events.push("second-enter");
          }),
        ),
      );
      await delay(275);
      expect(events).toEqual(["first-enter"]);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
      await Effect.runPromise(
        firstLock.withExclusiveCommit((fence) =>
          Effect.sync(() => {
            generations.push(fence.generation!);
          }),
        ),
      );
      expect(generations).toEqual([1, 2, 3]);
      expect(
        firstDb
          .query("SELECT owner_token, generation, lease_expires_at FROM skill_install_commit_locks")
          .get(),
      ).toEqual({ owner_token: null, generation: 3, lease_expires_at: 0 });
    } finally {
      firstDb.close();
      secondDb.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an expired claimant is fenced before its next mutation after a new generation enters", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "selftune-commit-steal-")));
    const path = join(root, "selftune.db");
    const firstDb = openDb(path);
    const secondDb = openDb(path);
    let timestamp = 0;
    let firstEntered!: () => void;
    let allowOldCheckpoint!: () => void;
    let secondEntered!: () => void;
    let releaseSecond!: () => void;
    const enteredFirst = new Promise<void>((resolve) => (firstEntered = resolve));
    const oldCheckpointGate = new Promise<void>((resolve) => (allowOldCheckpoint = resolve));
    const enteredSecond = new Promise<void>((resolve) => (secondEntered = resolve));
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
    let oldMutationRan = false;
    const generations: number[] = [];
    try {
      const options = {
        leaseMs: 100,
        heartbeatMs: 80,
        pollMs: 2,
        now: () => timestamp,
      };
      const firstLock = makeSqliteInstallerExclusiveCommitLock(firstDb, options);
      const secondLock = makeSqliteInstallerExclusiveCommitLock(secondDb, options);
      const first = Effect.runPromise(
        firstLock.withExclusiveCommit((fence) =>
          Effect.gen(function* () {
            generations.push(fence.generation!);
            firstEntered();
            yield* Effect.promise(() => oldCheckpointGate);
            yield* fence.checkpoint!;
            oldMutationRan = true;
          }),
        ),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      await enteredFirst;
      timestamp = 200;
      const second = Effect.runPromise(
        secondLock.withExclusiveCommit((fence) =>
          Effect.promise(async () => {
            generations.push(fence.generation!);
            secondEntered();
            await secondGate;
          }),
        ),
      );
      await enteredSecond;
      allowOldCheckpoint();
      const oldError = await first;
      expect(oldError).not.toBeNull();
      expect((oldError as { code?: string }).code).toBe("INSTALL_COMMIT_FENCE_LOST");
      expect(oldMutationRan).toBe(false);
      expect(generations).toEqual([1, 2]);
      releaseSecond();
      await second;
    } finally {
      firstDb.close();
      secondDb.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
