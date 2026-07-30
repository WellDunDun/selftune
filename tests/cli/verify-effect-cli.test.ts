import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";

import { LEGACY_COMMANDS } from "../../apps/cli/src/commands/router.js";
import {
  runVerifyActionWithDependencies,
  VERIFY_HELP,
  type VerifyAction,
  type VerifyActionDependencies,
  type VerifyCommandInput,
} from "../../apps/cli/src/effect-cli/commands/verify.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import { formatVerifyResult, type VerifyResult } from "../../packages/runtime/verify.js";
import type { CreateCheckResult } from "../../packages/runtime/types.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const selftuneRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-verify-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function makeReadiness(state: CreateCheckResult["state"]): CreateCheckResult {
  const ok = state === "ready_to_publish";
  return {
    skill: "research-assistant",
    skill_dir: "/tmp/research-assistant",
    skill_path: "/tmp/research-assistant/SKILL.md",
    ok,
    state,
    next_command: null,
    spec_validation: {
      ok: true,
      issues: [],
      raw_stdout: "",
      raw_stderr: "",
      exit_code: 0,
      validator: "skills-ref",
      command: "uvx skills-ref validate /tmp/research-assistant",
    },
    readiness: {
      ok,
      state,
      summary: state,
      next_command: null,
      checks: {
        skill_md: true,
        frontmatter_present: true,
        skill_name_matches_dir: true,
        description_present: true,
        description_within_budget: true,
        skill_md_within_line_budget: true,
        manifest_present: true,
        workflow_entry: true,
        references_present: true,
        scripts_present: false,
        assets_present: false,
        evals_present: true,
        unit_tests_present: true,
        routing_replay_ready: true,
        routing_replay_recorded: true,
        package_replay_ready: true,
        baseline_present: true,
      },
      skill_name: "research-assistant",
      skill_dir: "/tmp/research-assistant",
      skill_path: "/tmp/research-assistant/SKILL.md",
      entry_workflow: "workflows/default.md",
      manifest_present: true,
      description_quality: {
        composite: 1,
        criteria: {
          length: 1,
          trigger_context: 1,
          vagueness: 1,
          specificity: 1,
          not_just_name: 1,
        },
      },
    },
  };
}

function makeVerifyResult(verified: boolean): VerifyResult {
  const readiness = makeReadiness(verified ? "ready_to_publish" : "needs_evals");
  return {
    skill: readiness.skill,
    skill_path: readiness.skill_path,
    readiness_state: readiness.state,
    verified,
    next_command: readiness.next_command,
    readiness,
    report: null,
  };
}

function runVerifyCommand(args: ReadonlyArray<string>, action: VerifyAction) {
  return makeEffectCliTestProgram(["verify", ...args], { verifyAction: action }).pipe(
    Effect.provide(BunServices.layer),
  );
}

function runVerifyCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "verify", ...args], {
    cwd: selftuneRoot,
    env: {
      ...process.env,
      HOME: home,
      SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
      SELFTUNE_NO_ANALYTICS: "1",
      SELFTUNE_SKIP_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
  };
}

afterEach(() => {
  process.exitCode = 0;
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("verify Effect CLI ownership", () => {
  test("owns verify in the Effect tree and removes it from the legacy router", () => {
    expect(isEffectCliInvocation("verify", [])).toBe(true);
    expect(isEffectCliInvocation("verify", ["--unknown"])).toBe(true);
    expect(LEGACY_COMMANDS).not.toContain("verify");
  });

  test("preserves defaults and the complete documented flag contract", async () => {
    const inputs: VerifyCommandInput[] = [];
    const action: VerifyAction = (input) => Effect.sync(() => inputs.push(input));

    await Effect.runPromise(
      Effect.all(
        [
          [],
          [
            "--skill-path",
            "first",
            "--skill-path=second=last",
            "--agent=",
            "--eval-set=-fixture",
            "--no-auto-fix",
            "--json",
          ],
        ].map((args) => runVerifyCommand(args, action)),
        { concurrency: 1, discard: true },
      ),
    );

    expect(inputs).toEqual([
      {
        skillPath: "",
        agent: undefined,
        evalSetPath: undefined,
        autoFix: true,
        json: false,
      },
      {
        skillPath: "second=last",
        agent: "",
        evalSetPath: "-fixture",
        autoFix: false,
        json: true,
      },
    ]);
  });

  test("preserves attached leading-dash, equals, and empty string values", async () => {
    const inputs: VerifyCommandInput[] = [];

    await Effect.runPromise(
      runVerifyCommand(["--skill-path=-draft=skill", "--agent=a=b", "--eval-set="], (input) =>
        Effect.sync(() => inputs.push(input)),
      ),
    );

    expect(inputs).toEqual([
      {
        skillPath: "-draft=skill",
        agent: "a=b",
        evalSetPath: "",
        autoFix: true,
        json: false,
      },
    ]);
  });

  test("valid legacy help forms render canonical help without invoking verify", async () => {
    let invoked = false;
    await Effect.runPromise(
      Effect.all(
        [["--help"], ["-h"], ["-hh"], ["--help", "--skill-path", "ignored"]].map((args) =>
          runVerifyCommand(args, () =>
            Effect.sync(() => {
              invoked = true;
            }),
          ),
        ),
        { concurrency: 1, discard: true },
      ),
    );
    expect(invoked).toBe(false);
  });

  test("rejects the complete legacy-invalid grammar before invoking verify", async () => {
    let invoked = false;
    const malformed: ReadonlyArray<ReadonlyArray<string>> = [
      ["positional"],
      ["--", "positional"],
      ["--unknown"],
      ["--skill-path"],
      ["--agent"],
      ["--eval-set"],
      ["--skill-path", "-value"],
      ["--no-auto-fix=true"],
      ["--json=false"],
      ["--help", "--unknown"],
      ["--version"],
      ["--log-level", "info"],
      ["--completions", "bash"],
    ];

    const errors = await Effect.runPromise(
      Effect.all(
        malformed.map((args) =>
          runVerifyCommand(args, () =>
            Effect.sync(() => {
              invoked = true;
            }),
          ).pipe(Effect.flip),
        ),
        { concurrency: 1 },
      ),
    );

    for (const error of errors) {
      expect(error).toMatchObject({
        code: "INVALID_FLAG",
        suggestion: "selftune verify --help",
      });
    }
    expect(invoked).toBe(false);
  });

  test("the shared test root fails closed instead of verifying live skills", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["verify"]).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live verify is disabled in the Effect CLI test program.",
    });
  });

  test("loads runtime support only when the live action effect executes", async () => {
    let loads = 0;
    let runs = 0;
    const dependencies: VerifyActionDependencies = {
      loadModule: async () => {
        loads++;
        return {
          runVerify: async () => {
            runs++;
            return makeVerifyResult(true);
          },
          formatVerifyResult: () => "verified",
        };
      },
      isStdoutTTY: () => true,
      print: () => {},
      setExitCode: () => {},
    };

    const program = runVerifyActionWithDependencies(
      { skillPath: "/tmp/skill", autoFix: true, json: false },
      dependencies,
    );
    expect(loads).toBe(0);
    expect(runs).toBe(0);

    await Effect.runPromise(program);

    expect(loads).toBe(1);
    expect(runs).toBe(1);
  });

  test("preserves TTY text, explicit JSON, non-TTY JSON, and verification exit semantics", async () => {
    const formattedAsJson: boolean[] = [];
    const printed: string[] = [];
    const exitCodes: number[] = [];
    let stdoutTTY = true;
    let result = makeVerifyResult(true);
    const dependencies: VerifyActionDependencies = {
      loadModule: async () => ({
        runVerify: async () => result,
        formatVerifyResult: (_verifyResult, jsonOutput) => {
          formattedAsJson.push(jsonOutput);
          return jsonOutput ? "json" : "text";
        },
      }),
      isStdoutTTY: () => stdoutTTY,
      print: (message) => printed.push(message),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    };

    await Effect.runPromise(
      runVerifyActionWithDependencies(
        { skillPath: "/tmp/skill", autoFix: true, json: false },
        dependencies,
      ),
    );
    await Effect.runPromise(
      runVerifyActionWithDependencies(
        { skillPath: "/tmp/skill", autoFix: false, json: true },
        dependencies,
      ),
    );
    stdoutTTY = false;
    result = makeVerifyResult(false);
    await Effect.runPromise(
      runVerifyActionWithDependencies(
        { skillPath: "/tmp/skill", autoFix: true, json: false },
        dependencies,
      ),
    );

    expect(formattedAsJson).toEqual([false, true, true]);
    expect(printed).toEqual(["text", "json", "json"]);
    expect(exitCodes).toEqual([0, 0, 1]);
  });

  test("the shared formatter preserves two-space JSON and readiness text", () => {
    const result = makeVerifyResult(false);

    const json = formatVerifyResult(result, true);
    expect(json).toContain('\n  "skill": "research-assistant"');
    expect(JSON.parse(json)).toEqual(result);

    const text = formatVerifyResult(result, false);
    expect(text).toContain("Skill: research-assistant");
    expect(text).toContain("State: needs_evals");
    expect(text).toContain("Checks:");
  });

  test("maps lazy imports and unexpected operations while preserving typed failures", async () => {
    const baseDependencies = {
      isStdoutTTY: () => true,
      print: () => {},
      setExitCode: () => {},
    };
    const input: VerifyCommandInput = {
      skillPath: "/tmp/skill",
      autoFix: true,
      json: false,
    };

    const importError = await Effect.runPromise(
      runVerifyActionWithDependencies(input, {
        ...baseDependencies,
        loadModule: async () => Promise.reject(new Error("module missing")),
      }).pipe(Effect.flip),
    );
    expect(importError).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unable to load verify support: module missing",
      suggestion: "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
    });

    const operationError = await Effect.runPromise(
      runVerifyActionWithDependencies(input, {
        ...baseDependencies,
        loadModule: async () => ({
          runVerify: async () => Promise.reject(new Error("readiness unavailable")),
          formatVerifyResult: () => "unused",
        }),
      }).pipe(Effect.flip),
    );
    expect(operationError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Verify failed: readiness unavailable",
      suggestion: "selftune verify --help",
    });

    const typed = new CLIError(
      "Eval set is missing.",
      "MISSING_DATA",
      "selftune eval generate",
      4,
      true,
    );
    const typedError = await Effect.runPromise(
      runVerifyActionWithDependencies(input, {
        ...baseDependencies,
        loadModule: async () => ({
          runVerify: async () => Promise.reject(typed),
          formatVerifyResult: () => "unused",
        }),
      }).pipe(Effect.flip),
    );
    expect(typedError).toBe(typed);
    expect(typedError).toMatchObject({ exitCode: 4, retryable: true });
  });

  test("maps formatter, printer, and exit-status failures into the typed error channel", async () => {
    const input: VerifyCommandInput = {
      skillPath: "/tmp/skill",
      autoFix: true,
      json: false,
    };
    const result = makeVerifyResult(true);
    const baseDependencies = {
      isStdoutTTY: () => true,
      print: () => {},
      setExitCode: () => {},
    };
    const failures: VerifyActionDependencies[] = [
      {
        ...baseDependencies,
        loadModule: async () => ({
          runVerify: async () => result,
          formatVerifyResult: () => {
            throw new Error("format unavailable");
          },
        }),
      },
      {
        ...baseDependencies,
        loadModule: async () => ({
          runVerify: async () => result,
          formatVerifyResult: () => "verified",
        }),
        print: () => {
          throw new Error("stdout closed");
        },
      },
      {
        ...baseDependencies,
        loadModule: async () => ({
          runVerify: async () => result,
          formatVerifyResult: () => "verified",
        }),
        setExitCode: () => {
          throw new Error("exit status unavailable");
        },
      },
    ];

    const errors = await Effect.runPromise(
      Effect.all(
        failures.map((dependencies) =>
          runVerifyActionWithDependencies(input, dependencies).pipe(Effect.flip),
        ),
        { concurrency: 1 },
      ),
    );

    expect(errors.map((error) => error.code)).toEqual([
      "OPERATION_FAILED",
      "OPERATION_FAILED",
      "OPERATION_FAILED",
    ]);
    expect(errors.map((error) => error.message)).toEqual([
      "Verify failed: format unavailable",
      "Verify failed: stdout closed",
      "Verify failed: exit status unavailable",
    ]);
  });

  test("help stays lazy, exact, and free of local runtime state", () => {
    const home = makeHome();
    const result = runVerifyCli(home, "--help");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${VERIFY_HELP}\n`);
    expect(result.stderr).toBe("");
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("owns a lazy runtime adapter without delegating to cliMain", () => {
    const source = readFileSync(
      join(selftuneRoot, "apps/cli/src/effect-cli/commands/verify.ts"),
      "utf8",
    );
    expect(source).toContain('import("@selftune/runtime/verify")');
    expect(source).not.toContain("cliMain");
    expect(source).not.toContain("process.exit(");
    expect(source).not.toContain("catchCause");
    expect(source).not.toContain("runPromise");
  });
});
