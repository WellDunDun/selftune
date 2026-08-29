import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetSelfTuneState } from "./state-backup";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local state recovery", () => {
  it("moves runtime-owned state into a timestamped backup without touching user config", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-desktop-reset-"));
    roots.push(root);
    writeFileSync(join(root, "selftune.db"), "database");
    writeFileSync(join(root, "selftune.db-wal"), "wal");
    writeFileSync(join(root, "observability.duckdb"), "analytical database");
    writeFileSync(join(root, "observability.duckdb.wal"), "analytical wal");
    writeFileSync(join(root, "remote-library.json"), "settings");
    mkdirSync(join(root, "server-control"));
    writeFileSync(join(root, "server-control", "auth.json"), "auth");

    const result = resetSelfTuneState(root);

    expect(result.moved).toEqual([
      "selftune.db",
      "selftune.db-wal",
      "observability.duckdb",
      "observability.duckdb.wal",
      "server-control",
    ]);
    expect(existsSync(join(result.backupDir, "selftune.db"))).toBe(true);
    expect(existsSync(join(result.backupDir, "observability.duckdb"))).toBe(true);
    expect(existsSync(join(result.backupDir, "observability.duckdb.wal"))).toBe(true);
    expect(existsSync(join(result.backupDir, "server-control", "auth.json"))).toBe(true);
    expect(existsSync(join(root, "selftune.db"))).toBe(false);
    expect(existsSync(join(root, "observability.duckdb"))).toBe(false);
    expect(existsSync(join(root, "observability.duckdb.wal"))).toBe(false);
    expect(existsSync(join(root, "remote-library.json"))).toBe(true);
  });
});
