import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("analytics contracts run with isolated configuration and injected HTTP", () => {
  const configDir = mkdtempSync(join(tmpdir(), "selftune-analytics-"));
  try {
    const child = Bun.spawnSync([process.execPath, "test", "./fixtures/analytics-cases.ts"], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        SELFTUNE_CONFIG_DIR: configDir,
        SELFTUNE_ANALYTICS_TEST_DIR: configDir,
        SELFTUNE_SKIP_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    process.stderr.write(child.stderr);
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
