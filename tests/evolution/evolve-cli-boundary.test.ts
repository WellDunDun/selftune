import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { summarizeEvolution } from "../../packages/runtime/evolution/evolve/cli.js";
import type { EvolveResult } from "../../packages/runtime/evolution/evolve/contracts.js";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "selftune-evolve-cli-"));
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

function runCli(flags: string[]) {
  return Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../../packages/runtime/evolution/evolve.ts"),
      "--skill",
      "example",
      "--skill-path",
      join(tempDir, "missing", "SKILL.md"),
      "--agent",
      process.execPath,
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
  ["--gate-effort", "unsupported"],
  ["--gate-effort", ""],
])("rejects %s=%s before accessing skill or database state", (flag, value) => {
  const result = runCli([flag, value]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(`Invalid ${flag} value`);
  expect(result.stdout.toString()).toBe("");
  expect(readdirSync(tempDir)).toEqual([]);
});

test.each([
  ["--validation-mode", "auto"],
  ["--validation-mode", "replay"],
  ["--validation-mode", "judge"],
  ["--gate-effort", "low"],
  ["--gate-effort", "medium"],
  ["--gate-effort", "high"],
  ["--gate-effort", "max"],
])("accepts %s=%s and stops at a missing skill without invoking an agent", (flag, value) => {
  const result = runCli([flag, value]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("SKILL.md not found");
  expect(readdirSync(tempDir)).toEqual([]);
});

const deployedResult = {
  proposal: null,
  validation: null,
  deployed: true,
  auditEntries: [],
  reason: "Validated",
  llmCallCount: 2,
  elapsedMs: 1249,
} satisfies EvolveResult;

test("serializes the complete minimal evolution summary without absent optional fields", () => {
  expect(summarizeEvolution(deployedResult, "design skill")).toEqual({
    skill: "design skill",
    deployed: true,
    reason: "Validated",
    before: 0,
    after: 0,
    net_change: 0,
    improved: false,
    regressions: 0,
    new_passes: 0,
    confidence: 0,
    llm_calls: 2,
    elapsed_s: 1.2,
    proposal_id: "",
    rationale: "",
    dashboard_url: "http://localhost:3141/report/design%20skill",
  });
});

test("keeps zero quality scores and version while giving blocked runs their next steps", () => {
  const summary = summarizeEvolution(
    {
      ...deployedResult,
      deployed: false,
      reason: "SKILL.md not found at /missing",
      skillVersion: "1.2.3",
      descriptionQualityBefore: 0,
      descriptionQualityAfter: 0.7,
    },
    "design",
  );
  expect(summary.version).toBe("1.2.3");
  expect(summary.description_quality_before).toBe(0);
  expect(summary.description_quality_after).toBe(0.7);
  expect(summary.suggestions).toHaveLength(2);
  expect(summary.suggestions?.[0]).toContain("--skill-path");
});
