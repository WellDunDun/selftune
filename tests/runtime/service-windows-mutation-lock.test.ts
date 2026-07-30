import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import {
  isWindowsServiceMutationLockBusy,
  makeWindowsUserServiceMutationLock,
  WINDOWS_USER_SERVICE_NAMESPACE,
  WindowsUserServiceMutationLockScopeSchema,
  windowsUserServiceMutationLockPath,
  type WindowsUserServiceMutationLockDatabase,
  type WindowsUserServiceMutationLockScope,
} from "../../apps/local/src/service/windows/mutation-lock.js";
import type { WindowsServiceLockCompatibility } from "../../apps/local/src/service/windows/lock-compatibility.js";

const controlDir = "c:\\users\\test\\appdata\\local\\selftune\\service-control";
const userScope: WindowsUserServiceMutationLockScope = {
  controlDir,
  namespace: WINDOWS_USER_SERVICE_NAMESPACE,
  userSid: "S-1-5-21-1000-2000-3000-4000",
};

const readyCompatibility: WindowsServiceLockCompatibility = {
  diagnose: (scope) =>
    Effect.succeed({
      _tag: "FenceReady",
      fence: {
        ...scope,
        kind: "sqlite-ownership-fence",
        version: 3,
      },
      path: `${scope.controlDir}\\windows-service-mutation.lock`,
    }),
  ensureFence: () => Effect.void,
  repairStale: () => Effect.void,
};

function makeTestLock(
  openDatabase: (path: string) => WindowsUserServiceMutationLockDatabase,
  compatibility: WindowsServiceLockCompatibility = readyCompatibility,
) {
  return makeWindowsUserServiceMutationLock({ compatibility, openDatabase });
}

class FakeSqliteError extends Error {
  readonly code: string;
  readonly errno: number;

  constructor(code: string, errno: number, message = code) {
    super(message);
    this.code = code;
    this.errno = errno;
  }
}

interface FakeDatabaseState {
  readonly databases: Array<{ readonly closed: () => boolean }>;
  readonly owners: Map<string, WindowsUserServiceMutationLockDatabase>;
}

function fakeDatabases(
  options: {
    readonly failOn?: string;
    readonly failRollback?: boolean;
  } = {},
) {
  const state: FakeDatabaseState = { databases: [], owners: new Map() };
  const openDatabase = (path: string): WindowsUserServiceMutationLockDatabase => {
    let closed = false;
    let ownsTransaction = false;
    const database: WindowsUserServiceMutationLockDatabase = {
      close: () => {
        if (closed) return;
        closed = true;
        if (state.owners.get(path) === database) state.owners.delete(path);
      },
      run: (sql) => {
        if (closed) throw new Error("database is closed");
        if (sql === options.failOn) throw new Error(`failed: ${sql}`);
        if (sql === "BEGIN IMMEDIATE") {
          if (state.owners.has(path)) throw new FakeSqliteError("SQLITE_BUSY", 5);
          state.owners.set(path, database);
          ownsTransaction = true;
        }
        if (sql === "ROLLBACK") {
          if (options.failRollback) throw new Error("rollback failed");
          if (ownsTransaction && state.owners.get(path) === database) state.owners.delete(path);
          ownsTransaction = false;
        }
      },
    };
    state.databases.push({ closed: () => closed });
    return database;
  };
  return { openDatabase, state };
}

describe("Windows service mutation lock", () => {
  it("validates the fixed canonical per-user service scope", async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(WindowsUserServiceMutationLockScopeSchema)(userScope),
      ),
    ).resolves.toEqual(userScope);
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(WindowsUserServiceMutationLockScopeSchema)({
          ...userScope,
          controlDir: "relative\\service-control",
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(WindowsUserServiceMutationLockScopeSchema)({
          ...userScope,
          namespace: "config-scoped-lock",
        }),
      ),
    ).rejects.toBeDefined();
    expect(windowsUserServiceMutationLockPath(controlDir)).toEndWith(
      "\\windows-service-mutation.sqlite",
    );
  });

  it("classifies SQLite busy and locked errors through wrapped causes", () => {
    expect(isWindowsServiceMutationLockBusy(new FakeSqliteError("SQLITE_BUSY", 5))).toBe(true);
    expect(
      isWindowsServiceMutationLockBusy({
        cause: new FakeSqliteError("SQLITE_LOCKED_SHAREDCACHE", 6),
      }),
    ).toBe(true);
    expect(isWindowsServiceMutationLockBusy(new Error("database is unavailable"))).toBe(false);
  });

  it("establishes the old-binary fence before opening SQLite", async () => {
    const events: string[] = [];
    const fake = fakeDatabases();
    const lock = makeTestLock(
      (path) => {
        events.push("open-sqlite");
        return fake.openDatabase(path);
      },
      {
        diagnose: readyCompatibility.diagnose,
        ensureFence: () =>
          Effect.sync(() => {
            events.push("ensure-legacy-fence");
          }),
      },
    );

    const lease = await Effect.runPromise(lock.acquire(userScope));
    expect(events).toEqual(["ensure-legacy-fence", "open-sqlite"]);
    await Effect.runPromise(lock.release(lease));
  });

  it("serializes every target config through one per-user SQLite owner", async () => {
    const fake = fakeDatabases();
    const first = makeTestLock(fake.openDatabase);
    const second = makeTestLock(fake.openDatabase);
    const lease = await Effect.runPromise(first.acquire(userScope));

    await expect(Effect.runPromise(second.acquire(userScope))).rejects.toMatchObject({
      message: "Another Windows service mutation is already in progress.",
      operation: "acquire-user-service-mutation-lock",
    });
    expect(fake.state.databases[1]?.closed()).toBe(true);

    await Effect.runPromise(first.release(lease));
    const successor = await Effect.runPromise(second.acquire(userScope));
    await Effect.runPromise(second.release(successor));
  });

  it("keeps leases identity-bound and releases them idempotently", async () => {
    const fake = fakeDatabases();
    const owner = makeTestLock(fake.openDatabase);
    const contender = makeTestLock(fake.openDatabase);
    const lease = await Effect.runPromise(owner.acquire(userScope));
    const forged = { ...lease };

    await Effect.runPromise(owner.release(forged));
    await expect(Effect.runPromise(contender.acquire(userScope))).rejects.toMatchObject({
      operation: "acquire-user-service-mutation-lock",
    });

    await Effect.runPromise(owner.release(lease));
    await Effect.runPromise(owner.release(lease));
    expect(fake.state.databases[0]?.closed()).toBe(true);
    const successor = await Effect.runPromise(contender.acquire(userScope));
    await Effect.runPromise(contender.release(successor));
  });

  it("allows distinct per-user control roots to own distinct databases", async () => {
    const fake = fakeDatabases();
    const first = makeTestLock(fake.openDatabase);
    const second = makeTestLock(fake.openDatabase);
    const secondScope: WindowsUserServiceMutationLockScope = {
      ...userScope,
      controlDir: "d:\\users\\other\\appdata\\local\\selftune\\service-control",
      userSid: "S-1-5-21-9000-8000-7000-6000",
    };

    const firstLease = await Effect.runPromise(first.acquire(userScope));
    const secondLease = await Effect.runPromise(second.acquire(secondScope));
    expect(fake.state.owners.size).toBe(2);

    await Effect.runPromise(first.release(firstLease));
    await Effect.runPromise(second.release(secondLease));
    expect(fake.state.owners.size).toBe(0);
  });

  it("closes a database when initialization fails without treating it as contention", async () => {
    const fake = fakeDatabases({ failOn: "BEGIN IMMEDIATE" });
    const lock = makeTestLock(fake.openDatabase);

    await expect(Effect.runPromise(lock.acquire(userScope))).rejects.toMatchObject({
      message: "failed: BEGIN IMMEDIATE",
      operation: "initialize-user-service-mutation-lock",
    });
    expect(fake.state.databases[0]?.closed()).toBe(true);
    expect(fake.state.owners.size).toBe(0);
  });

  it("closes and unlocks even when rollback reports a failure", async () => {
    const fake = fakeDatabases({ failRollback: true });
    const lock = makeTestLock(fake.openDatabase);
    const lease = await Effect.runPromise(lock.acquire(userScope));

    await expect(Effect.runPromise(lock.release(lease))).rejects.toMatchObject({
      message: "rollback failed",
      operation: "release-user-service-mutation-lock",
    });
    expect(fake.state.databases[0]?.closed()).toBe(true);
    expect(fake.state.owners.size).toBe(0);
  });

  it("releases after the protected effect fails", async () => {
    const fake = fakeDatabases();
    const lock = makeTestLock(fake.openDatabase);
    class UseFailure extends Error {}

    await expect(
      Effect.runPromise(lock.withLock(userScope, Effect.fail(new UseFailure("failed")))),
    ).rejects.toBeInstanceOf(UseFailure);
    expect(fake.state.owners.size).toBe(0);
    expect(fake.state.databases[0]?.closed()).toBe(true);
  });

  it("releases after the protected effect is interrupted", async () => {
    const fake = fakeDatabases();
    const lock = makeTestLock(fake.openDatabase);
    const entered = await Effect.runPromise(Deferred.make<void>());
    const never = await Effect.runPromise(Deferred.make<void>());
    const fiber = Effect.runFork(
      lock.withLock(
        userScope,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(never))),
      ),
    );
    await Effect.runPromise(Deferred.await(entered));
    expect(fake.state.owners.size).toBe(1);

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(fake.state.owners.size).toBe(0);
    expect(fake.state.databases[0]?.closed()).toBe(true);
  });
});

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

const repositoryRoot = resolve(import.meta.dir, "../..");
const lockModuleUrl = pathToFileURL(
  join(repositoryRoot, "apps/local/src/service/windows/mutation-lock.ts"),
).href;

function spawnLockProcess(script: string, environment: Record<string, string>) {
  const child = spawn(process.execPath, ["-e", script], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { child, stderr: () => stderr, stdout: () => stdout };
}

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<ChildResult> {
  return new Promise((resolveClose) => {
    child.once("close", (code, signal) => {
      resolveClose({ code, signal, stderr: "", stdout: "" });
    });
  });
}

async function waitForFile(path: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 10_000;
  const poll = async (): Promise<void> => {
    if (existsSync(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("SQLite lock holder exited before it acquired ownership.");
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the SQLite lock holder.");
    }
    await Bun.sleep(20);
    return poll();
  };
  return poll();
}

const childPrelude = `
  import { Database } from "bun:sqlite";
  import { writeFileSync } from "node:fs";
  import * as Effect from "effect/Effect";
  import { makeWindowsUserServiceMutationLock } from ${JSON.stringify(lockModuleUrl)};
  const scope = ${JSON.stringify(userScope)};
  const lock = makeWindowsUserServiceMutationLock({
    compatibility: {
      diagnose: () => Effect.die("unused"),
      ensureFence: () => Effect.void,
      repairStale: () => Effect.void,
    },
    openDatabase: () => new Database(process.env.SELFTUNE_TEST_LOCK_DB, { create: true }),
  });
`;

async function runAcquireAttempt(databasePath: string, holdMilliseconds = 0): Promise<ChildResult> {
  const processOutput = spawnLockProcess(
    `${childPrelude}
      try {
        const lease = await Effect.runPromise(lock.acquire(scope));
        console.log("ACQUIRED");
        await Bun.sleep(Number(process.env.SELFTUNE_TEST_HOLD_MS));
        await Effect.runPromise(lock.release(lease));
      } catch (cause) {
        if (cause?._tag === "WindowsServiceMutationLockError") {
          console.log("HELD " + cause.operation);
        } else {
          console.error(cause);
          process.exitCode = 1;
        }
      }
    `,
    {
      SELFTUNE_TEST_HOLD_MS: String(holdMilliseconds),
      SELFTUNE_TEST_LOCK_DB: databasePath,
    },
  );
  const closed = await waitForClose(processOutput.child);
  return {
    ...closed,
    stderr: processOutput.stderr().trim(),
    stdout: processOutput.stdout().trim(),
  };
}

describe("Windows service mutation lock subprocess ownership", () => {
  it("uses real SQLite contention and reacquires after the holder is SIGKILLed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "selftune-windows-service-lock-"));
    const databasePath = join(directory, "mutation.sqlite");
    const readyPath = join(directory, "ready");
    const holder = spawnLockProcess(
      `${childPrelude}
          const lease = await Effect.runPromise(lock.acquire(scope));
          writeFileSync(process.env.SELFTUNE_TEST_READY, "ready");
          await Bun.sleep(60_000);
          await Effect.runPromise(lock.release(lease));
        `,
      {
        SELFTUNE_TEST_LOCK_DB: databasePath,
        SELFTUNE_TEST_READY: readyPath,
      },
    );

    try {
      await waitForFile(readyPath, holder.child);
      await expect(runAcquireAttempt(databasePath)).resolves.toMatchObject({
        code: 0,
        signal: null,
        stderr: "",
        stdout: "HELD acquire-user-service-mutation-lock",
      });

      holder.child.kill("SIGKILL");
      await expect(waitForClose(holder.child)).resolves.toMatchObject({
        code: null,
        signal: "SIGKILL",
      });
      const successors = await Promise.all([
        runAcquireAttempt(databasePath, 750),
        runAcquireAttempt(databasePath, 750),
      ]);
      expect(successors.map((result) => result.stdout).toSorted()).toEqual([
        "ACQUIRED",
        "HELD acquire-user-service-mutation-lock",
      ]);
      for (const successor of successors) {
        expect(successor).toMatchObject({ code: 0, signal: null, stderr: "" });
      }
      await expect(runAcquireAttempt(databasePath)).resolves.toMatchObject({
        code: 0,
        signal: null,
        stderr: "",
        stdout: "ACQUIRED",
      });
      expect(existsSync(databasePath)).toBe(true);
    } finally {
      if (holder.child.exitCode === null && holder.child.signalCode === null) {
        holder.child.kill("SIGKILL");
        await waitForClose(holder.child);
      }
      holder.child.stdout.destroy();
      holder.child.stderr.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
