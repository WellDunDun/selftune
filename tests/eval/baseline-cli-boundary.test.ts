import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directories = new Set<string>();
afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function runBaseline(payload?: string) {
  const root = mkdtempSync(join(tmpdir(), "selftune-baseline-input-"));
  directories.add(root);
  const skillPath = join(root, "SKILL.md");
  const evalPath = join(root, "evals.json");
  writeFileSync(
    skillPath,
    "---\nname: fixture\ndescription: Test a baseline.\n---\nReview evidence.",
  );
  if (payload !== undefined) writeFileSync(evalPath, payload);
  const result = Bun.spawnSync(
    [
      process.execPath,
      fileURLToPath(new URL("../../packages/runtime/eval/baseline.ts", import.meta.url)),
      "--skill",
      "fixture",
      "--skill-path",
      skillPath,
      "--eval-set",
      evalPath,
      "--agent",
      "selftune-test-agent-does-not-exist-05f630b6",
    ],
    {
      env: { ...process.env, SELFTUNE_CONFIG_DIR: join(root, "config") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(existsSync(join(root, "config", "selftune.db"))).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stdout)).toBe("");
  return new TextDecoder().decode(result.stderr);
}

test.each([
  "{",
  "null",
  "{}",
  '[{"query":"test","should_trigger":"yes"}]',
  '[{"query":42,"should_trigger":true}]',
])("rejects invalid eval data before agent selection: %s", (payload) => {
  const error = runBaseline(payload);
  expect(error).toContain("Eval set at");
  expect(error).toContain("is invalid");
});

test("missing explicit eval file does not fall back to the local database", () => {
  expect(runBaseline()).toContain("Eval set not found");
});

test("a valid eval file reaches agent selection without running a real agent", () => {
  expect(
    runBaseline('[{"query":"test","should_trigger":true,"future_metadata":{"origin":"fixture"}}]'),
  ).toContain("not found in PATH");
});
