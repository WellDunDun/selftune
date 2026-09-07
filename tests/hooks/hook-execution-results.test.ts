import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookExecutionResult } from "@selftune/harness-claude-code/hooks/execution-result";
import * as Schema from "effect/Schema";

const HookResults = Schema.Struct({
  autoAllow: HookExecutionResult,
  autoAllowCli: HookExecutionResult,
  autoSuggestion: HookExecutionResult,
  autoSuggestionCli: HookExecutionResult,
  evolutionAllow: HookExecutionResult,
  evolutionAllowCli: HookExecutionResult,
  evolutionBlock: HookExecutionResult,
  evolutionBlockCli: HookExecutionResult,
});

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "selftune-hook-results-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("result-returning Claude hooks", () => {
  test("auto-activate and evolution-guard preserve CLI output and exit behavior", async () => {
    const processResult = Bun.spawnSync(
      ["bun", "run", "tests/hooks/fixtures/hook-execution-results.ts"],
      {
        cwd: join(import.meta.dir, "../.."),
        env: { ...process.env, SELFTUNE_CONFIG_DIR: configDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(processResult.exitCode).toBe(0);
    expect(processResult.stderr.toString()).toBe("");
    const results = Schema.decodeUnknownSync(Schema.fromJsonString(HookResults))(
      processResult.stdout.toString(),
    );

    expect(results.autoAllow).toEqual({ exit_code: 0, stdout: "", stderr: "" });
    expect(results.autoAllow).toEqual(results.autoAllowCli);
    expect(results.autoSuggestion).toEqual(results.autoSuggestionCli);
    expect(results.autoSuggestion?.exit_code).toBe(0);
    expect(results.autoSuggestion?.stderr).toBe("");
    expect(results.autoSuggestion?.stdout).toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext:
            "[selftune] Suggestion: Run `selftune last` — 3 unmatched queries detected in this session.",
        },
      }),
    );

    expect(results.evolutionAllow).toEqual({ exit_code: 0, stdout: "", stderr: "" });
    expect(results.evolutionAllow).toEqual(results.evolutionAllowCli);
    expect(results.evolutionBlock).toEqual(results.evolutionBlockCli);
    expect(results.evolutionBlock?.exit_code).toBe(2);
    expect(results.evolutionBlock?.stdout).toBe("");
    expect(results.evolutionBlock?.stderr).toBe(
      '[selftune] Skill "pdf" has a deployed evolution and is under active monitoring. Run `selftune watch --skill pdf` before modifying SKILL.md to check current health.\n',
    );
  });
});
