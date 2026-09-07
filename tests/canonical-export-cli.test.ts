import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test.each([
  { flag: "--platform", value: "not-a-platform", message: "Unknown platform" },
  { flag: "--record-kind", value: "not-a-record", message: "Unknown record kind" },
])("canonical export rejects $flag before reading records", ({ flag, value, message }) => {
  const root = mkdtempSync(join(tmpdir(), "selftune-export-filter-"));
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        fileURLToPath(
          new URL("../packages/orchestration/src/canonical-export.ts", import.meta.url),
        ),
        flag,
        value,
        "--log",
        join(root, "absent.jsonl"),
        "--projects-dir",
        join(root, "absent-projects"),
      ],
      { env: { ...process.env, SELFTUNE_CONFIG_DIR: root }, stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode).toBe(1);
    expect(new TextDecoder().decode(child.stderr)).toContain(message);
    expect(new TextDecoder().decode(child.stdout)).toBe("");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
