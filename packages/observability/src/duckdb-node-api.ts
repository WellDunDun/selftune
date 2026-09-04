import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  makeDuckDbAnalyticalStoreLive,
  type DuckDbAppendValue,
  type DuckDbConnection,
  type DuckDbInstanceFactory,
} from "./duckdb-store.js";
import { resolvePackagedDuckDbModule } from "./duckdb-module-resolution.js";

const packagedDuckDbModule = resolvePackagedDuckDbModule({
  desktopResourceDirectory: process.env.SELFTUNE_DESKTOP_RESOURCE_DIR,
  executablePath: process.execPath,
});
if (packagedDuckDbModule && !process.env.SELFTUNE_DESKTOP_RESOURCE_DIR) {
  process.env.SELFTUNE_DESKTOP_RESOURCE_DIR = packagedDuckDbModule.resourceDirectory;
}
const duckDbModule = packagedDuckDbModule
  ? await import(pathToFileURL(packagedDuckDbModule.modulePath).href)
  : await import(["@duckdb", "node-api"].join("/"));
const { DuckDBInstance, DuckDBTimestampValue } = duckDbModule as typeof import("@duckdb/node-api");

/** Bounded desktop analytical-store memory; DuckDB never receives an unlimited process budget. */
export const DUCKDB_LOCAL_MEMORY_LIMIT = "512MB";

interface DuckDbWalRecoveryFileStat {
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

export interface DuckDbWalRecoveryDependencies<A> {
  readonly copyFile: (source: string, destination: string, mode?: number) => Promise<void>;
  readonly lstat: (path: string) => Promise<DuckDbWalRecoveryFileStat>;
  readonly mkdir: (
    path: string,
    options: { readonly mode: number; readonly recursive: boolean },
  ) => Promise<unknown>;
  readonly now: () => Date;
  readonly open: (databasePath: string) => Promise<A>;
  readonly randomUuid: () => string;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly warn: (message: string) => void;
}

const WAL_REPLAY_FAILURE_PREFIX = "Failure while replaying WAL file";
const UNBOUND_INDEX_REPLAY_FAILURE =
  "Failed to commit: Unbound index found in DataTable::RemoveFromIndexes";
const CORRUPTED_UNIQUE_ART_REPLAY_FAILURE = "Corrupted unique ART index";
const EXISTING_GATED_LEAF_REPLAY_FAILURE = "encountered an existing gated leaf";

function isKnownWalReplayIndexFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    message.includes(WAL_REPLAY_FAILURE_PREFIX) &&
    (message.includes(UNBOUND_INDEX_REPLAY_FAILURE) ||
      (message.includes(CORRUPTED_UNIQUE_ART_REPLAY_FAILURE) &&
        message.includes(EXISTING_GATED_LEAF_REPLAY_FAILURE)))
  );
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

function assertRegularNonSymlinkFile(path: string, stat: DuckDbWalRecoveryFileStat): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `Refusing automatic DuckDB WAL recovery because "${path}" is not a regular non-symlink file.`,
    );
  }
}

function backupStamp(now: Date): string {
  return now.toISOString().replaceAll("-", "").replaceAll(":", "").replaceAll(".", "");
}

/**
 * Recovers only DuckDB's known WAL-replay/index failure. The checkpoint remains
 * live, while an exclusive backup retains both the checkpoint snapshot and the
 * unreplayable WAL for future repair. Every other open or filesystem failure is
 * returned unchanged instead of widening recovery into a destructive reset.
 */
export async function openDuckDbWithWalRecovery<A>(
  databasePath: string,
  dependencies: DuckDbWalRecoveryDependencies<A>,
): Promise<A> {
  try {
    return await dependencies.open(databasePath);
  } catch (cause) {
    if (!isKnownWalReplayIndexFailure(cause)) throw cause;
  }

  const walPath = `${databasePath}.wal`;
  const databaseStat = await dependencies.lstat(databasePath);
  assertRegularNonSymlinkFile(databasePath, databaseStat);

  let walStat: DuckDbWalRecoveryFileStat;
  try {
    walStat = await dependencies.lstat(walPath);
  } catch (cause) {
    if (hasErrorCode(cause, "ENOENT")) return dependencies.open(databasePath);
    throw cause;
  }
  assertRegularNonSymlinkFile(walPath, walStat);

  const backupRoot = join(dirname(databasePath), "backups");
  await dependencies.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupDirectory = join(
    backupRoot,
    `duckdb-wal-recovery-${backupStamp(dependencies.now())}-${dependencies.randomUuid()}`,
  );
  await dependencies.mkdir(backupDirectory, { recursive: false, mode: 0o700 });
  await dependencies.copyFile(
    databasePath,
    join(backupDirectory, basename(databasePath)),
    constants.COPYFILE_EXCL,
  );

  try {
    await dependencies.rename(walPath, join(backupDirectory, basename(walPath)));
  } catch (cause) {
    if (hasErrorCode(cause, "ENOENT")) return dependencies.open(databasePath);
    throw cause;
  }

  dependencies.warn(
    `[selftune] DuckDB quarantined an unreplayable observability WAL. Recovery backup: ${backupDirectory}`,
  );
  return dependencies.open(databasePath);
}

const liveWalRecoveryDependencies = <A>(
  open: (databasePath: string) => Promise<A>,
): DuckDbWalRecoveryDependencies<A> => ({
  copyFile,
  lstat,
  mkdir,
  now: () => new Date(),
  open,
  randomUuid: randomUUID,
  rename,
  warn: (message) => process.stderr.write(`${message}\n`),
});

function appendScalar(
  appender: import("@duckdb/node-api").DuckDBAppender,
  value: DuckDbAppendValue,
) {
  if (value === null) {
    appender.appendNull();
  } else if (typeof value === "number") {
    if (Number.isInteger(value)) {
      appender.appendBigInt(BigInt(value));
    } else {
      appender.appendDouble(value);
    }
  } else if (typeof value === "string") {
    appender.appendVarchar(value);
  } else {
    appender.appendTimestamp(new DuckDBTimestampValue(value.micros));
  }
}

/**
 * The only production bridge to DuckDB's Node API. It is intentionally kept
 * behind the analytical-store contract so callers cannot acquire arbitrary
 * DuckDB connections or couple operational code to the driver.
 */
const duckDbNodeApiFactory: DuckDbInstanceFactory = {
  open: async (databasePath) => {
    const instance = await openDuckDbWithWalRecovery(
      databasePath,
      liveWalRecoveryDependencies((path) =>
        DuckDBInstance.create(path, {
          memory_limit: DUCKDB_LOCAL_MEMORY_LIMIT,
          preserve_insertion_order: "false",
          threads: "2",
        }),
      ),
    );
    return {
      closeSync: () => instance.closeSync(),
      connect: async () => {
        const nativeConnection = await instance.connect();
        const connection: DuckDbConnection = {
          appendRows: async (table, rows) => {
            if (rows.length === 0) return;
            const appender = await nativeConnection.createAppender(table);
            try {
              for (const row of rows) {
                for (const value of row) appendScalar(appender, value);
                appender.endRow();
              }
              appender.flushSync();
            } finally {
              appender.closeSync();
            }
          },
          closeSync: () => nativeConnection.closeSync(),
          run: (sql, parameters) => nativeConnection.run(sql, parameters),
        };
        return connection;
      },
    };
  },
};

export const makeDuckDbNodeApiAnalyticalStoreLive = (databasePath?: string) =>
  makeDuckDbAnalyticalStoreLive(duckDbNodeApiFactory, databasePath);

export const DuckDbAnalyticalStoreLive = makeDuckDbNodeApiAnalyticalStoreLive();
