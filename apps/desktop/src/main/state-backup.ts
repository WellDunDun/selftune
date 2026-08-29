import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const STATE_ENTRIES = [
  "selftune.db",
  "selftune.db-wal",
  "selftune.db-shm",
  "observability.duckdb",
  "observability.duckdb.wal",
  "server-control",
];

export interface ResetStateResult {
  readonly backupDir: string;
  readonly moved: ReadonlyArray<string>;
}

function backupStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export function resetSelfTuneState(configDir: string): ResetStateResult {
  const backupDir = join(configDir, "backups", backupStamp());
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  for (const entry of STATE_ENTRIES) {
    const source = join(configDir, entry);
    if (!existsSync(source)) continue;
    renameSync(source, join(backupDir, entry));
    moved.push(entry);
  }
  return { backupDir, moved };
}
