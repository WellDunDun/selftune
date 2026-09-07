import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "selftune-body-cli-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function runCli(flags: string[]) {
  return Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../../packages/runtime/evolution/evolve-body.ts"),
      "--skill",
      "example",
      "--skill-path",
      join(tempDir, "missing", "SKILL.md"),
      "--teacher-agent",
      "claude",
      ...flags,
    ],
    {
      env: {
        ...process.env,
        SELFTUNE_CONFIG_DIR: tempDir,
        SELFTUNE_NO_ANALYTICS: "1",
        SELFTUNE_SKIP_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

test.each([
  ["--validation-mode", "unsupported"],
  ["--validation-mode", ""],
  ["--teacher-effort", "unsupported"],
  ["--teacher-effort", ""],
  ["--target", "unsupported"],
])("rejects %s=%s before reading skill files", (flag, value) => {
  const result = runCli([flag, value]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(flag);
  expect(result.stdout.toString()).toBe("");
});

test.each(["auto", "replay", "judge"])(
  "accepts validation mode %s without invoking an agent for a missing skill",
  (mode) => {
    const result = runCli(["--validation-mode", mode]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("SKILL.md not found");
    expect(result.stderr.toString()).not.toContain("Invalid --validation-mode");
  },
);

test.each(["low", "medium", "high", "max"])(
  "accepts teacher effort %s without invoking an agent for a missing skill",
  (effort) => {
    const result = runCli(["--teacher-effort", effort]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("SKILL.md not found");
    expect(result.stderr.toString()).not.toContain("Invalid --teacher-effort");
  },
);
