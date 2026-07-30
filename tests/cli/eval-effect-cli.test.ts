import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";

import {
  runEvalActionWithDependencies,
  type EvalActionDependencies,
} from "../../apps/cli/src/effect-cli/commands/eval.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import { QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../../packages/runtime/constants.js";
import type { EvalCommandRequest } from "../../packages/runtime/eval/cli-contract.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const SELF_TUNE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const temporaryHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-eval-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "eval", ...args], {
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

async function parseEval(...args: string[]): Promise<EvalCommandRequest> {
  const requests: EvalCommandRequest[] = [];
  await Effect.runPromise(
    makeEffectCliTestProgram(["eval", ...args], {
      evalAction: (request) => Effect.sync(() => requests.push(request)),
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) throw new Error("expected one eval request");
  return request;
}

afterEach(() => {
  process.exitCode = 0;
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("full eval Effect command family", () => {
  test("owns every parent and leaf argument shape", () => {
    for (const args of [
      [],
      ["--help"],
      ["generate"],
      ["unit-test"],
      ["import"],
      ["composability"],
      ["family-overlap"],
      ["unknown"],
    ]) {
      expect(isEffectCliInvocation("eval", args)).toBe(true);
    }
  });

  test("the shared test root fails closed instead of running live eval work", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["eval", "generate", "--list-skills"]).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live eval is disabled in the Effect CLI test program.",
    });
  });

  test("owns its lazy live adapter without a global eval handler", () => {
    const commandSource = readFileSync(
      join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/commands/eval.ts"),
      "utf8",
    );
    expect(commandSource).toContain('import("@selftune/runtime/eval/programs")');
    expect(existsSync(join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/commands/contracts.ts"))).toBe(
      false,
    );
    expect(existsSync(join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/handlers/live.ts"))).toBe(
      false,
    );
  });

  test("loads eval support only when the action effect executes", async () => {
    let loads = 0;
    const requests: EvalCommandRequest[] = [];
    const request: EvalCommandRequest = {
      action: "composability",
      input: { skill: "research", window: undefined, telemetryLog: undefined },
    };
    const dependencies: EvalActionDependencies = {
      loadModule: async () => {
        loads += 1;
        return {
          runEvalProgram: (input) => Effect.sync(() => requests.push(input)),
        };
      },
    };

    const program = runEvalActionWithDependencies(request, dependencies);
    expect(loads).toBe(0);
    expect(requests).toEqual([]);

    await Effect.runPromise(program);

    expect(loads).toBe(1);
    expect(requests).toEqual([request]);
  });

  test("maps lazy import failures to an actionable internal error", async () => {
    const request: EvalCommandRequest = {
      action: "import",
      input: { dir: "/tmp/corpus", skill: "research", matchStrategy: "exact" },
    };
    const error = await Effect.runPromise(
      runEvalActionWithDependencies(request, {
        loadModule: async () => Promise.reject(new Error("module missing")),
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unable to load eval support: module missing",
      suggestion: "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
    });
  });

  test("maps construction and typed execution errors without catching causes", async () => {
    const request: EvalCommandRequest = {
      action: "family-overlap",
      input: {},
    };
    const constructionError = await Effect.runPromise(
      runEvalActionWithDependencies(request, {
        loadModule: async () => ({
          runEvalProgram: () => {
            throw new Error("construction exploded");
          },
        }),
      }).pipe(Effect.flip),
    );
    const executionError = await Effect.runPromise(
      runEvalActionWithDependencies(request, {
        loadModule: async () => ({
          runEvalProgram: () => Effect.fail(new Error("execution exploded")),
        }),
      }).pipe(Effect.flip),
    );

    expect(constructionError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "construction exploded",
      suggestion: "selftune eval family-overlap --help",
    });
    expect(executionError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "execution exploded",
      suggestion: "selftune eval family-overlap --help",
    });
  });

  test("preserves typed eval failures without losing identity", async () => {
    const typed = new CLIError("Corpus missing.", "FILE_NOT_FOUND", "restore corpus", 4);
    const request: EvalCommandRequest = {
      action: "import",
      input: { dir: "/tmp/corpus", skill: "research", matchStrategy: "exact" },
    };
    const error = await Effect.runPromise(
      runEvalActionWithDependencies(request, {
        loadModule: async () => ({
          runEvalProgram: () => Effect.fail(typed),
        }),
      }).pipe(Effect.flip),
    );

    expect(error).toBe(typed);
    expect(error).toMatchObject({ suggestion: "restore corpus", exitCode: 4 });
  });

  test("maps every generate flag and the legacy --out alias", async () => {
    expect(
      await parseEval(
        "generate",
        "--skill",
        "research",
        "--out",
        "/tmp/evals.json",
        "--agent",
        "codex",
        "--max",
        "25",
        "--seed=-7",
        "--list-skills",
        "--stats",
        "--no-negatives",
        "--no-taxonomy",
        "--skill-log",
        "/tmp/skills.jsonl",
        "--query-log=/tmp/queries.jsonl",
        "--telemetry-log",
        "/tmp/sessions.jsonl",
        "--synthetic",
        "--auto-synthetic",
        "--blend",
        "--skill-path",
        "/tmp/SKILL.md",
        "--model",
        "model-1",
      ),
    ).toEqual({
      action: "generate",
      input: {
        skill: "research",
        output: "/tmp/evals.json",
        agent: "codex",
        max: "25",
        seed: "-7",
        listSkills: true,
        stats: true,
        noNegatives: true,
        noTaxonomy: true,
        skillLog: "/tmp/skills.jsonl",
        queryLog: "/tmp/queries.jsonl",
        telemetryLog: "/tmp/sessions.jsonl",
        synthetic: true,
        autoSynthetic: true,
        blend: true,
        skillPath: "/tmp/SKILL.md",
        model: "model-1",
      },
    });

    expect(await parseEval("generate", "--skill", "research")).toMatchObject({
      action: "generate",
      input: {
        max: "50",
        seed: "42",
        skillLog: SKILL_LOG,
        queryLog: QUERY_LOG,
        telemetryLog: TELEMETRY_LOG,
      },
    });
  });

  test("maps unit-test, import, composability, and family-overlap flags", async () => {
    expect(
      await parseEval(
        "unit-test",
        "--skill",
        "research",
        "--tests",
        "/tmp/tests.json",
        "--run-agent",
        "--generate",
        "--skill-path",
        "/tmp/SKILL.md",
        "--eval-set",
        "/tmp/evals.json",
        "--model",
        "model-1",
      ),
    ).toEqual({
      action: "unit-test",
      input: {
        skill: "research",
        tests: "/tmp/tests.json",
        runAgent: true,
        generate: true,
        skillPath: "/tmp/SKILL.md",
        evalSet: "/tmp/evals.json",
        model: "model-1",
      },
    });
    expect(
      await parseEval(
        "import",
        "--dir",
        "/tmp/corpus",
        "--skill",
        "research",
        "--output",
        "/tmp/import.json",
        "--match-strategy",
        "fuzzy",
      ),
    ).toEqual({
      action: "import",
      input: {
        dir: "/tmp/corpus",
        skill: "research",
        output: "/tmp/import.json",
        matchStrategy: "fuzzy",
      },
    });
    expect(await parseEval("composability", "--skill", "research", "--window", "30")).toEqual({
      action: "composability",
      input: { skill: "research", window: "30", telemetryLog: undefined },
    });
    expect(
      await parseEval(
        "family-overlap",
        "--skills",
        "a,b,c",
        "--parent-skill",
        "parent",
        "--min-overlap",
        "0.4",
        "--min-shared",
        "3",
      ),
    ).toEqual({
      action: "family-overlap",
      input: {
        prefix: undefined,
        skills: "a,b,c",
        parentSkill: "parent",
        minOverlap: "0.4",
        minShared: "3",
      },
    });
  });

  test("renders rich parent and leaf help without fake operands", () => {
    const home = makeHome();
    const parent = runCli(home, "--help");
    expect(parent.exitCode, parent.stderr).toBe(0);
    expect(parent.stdout).toContain("Recommended creator loop");
    expect(parent.stdout).toContain("selftune eval unit-test --skill <name>");
    for (const action of ["generate", "unit-test", "import", "composability", "family-overlap"]) {
      expect(parent.stdout).toContain(action);
      const leaf = runCli(home, action, "--help");
      expect(leaf.exitCode, `${action}: ${leaf.stderr}`).toBe(0);
      expect(leaf.stdout).toContain(`selftune eval ${action}`);
      expect(leaf.stdout).not.toContain("__none__");
    }
  });

  test("accepts valid global values and rejects missing or invalid values", () => {
    const home = makeHome();
    for (const args of [
      ["--help", "--log-level=info", "--completions", "zsh"],
      ["generate", "--help", "--log-level", "debug", "--completions=fish"],
    ]) {
      const result = runCli(home, ...args);
      expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("selftune eval");
    }
    for (const args of [
      ["--help", "--log-level"],
      ["--help", "--completions=powershell"],
      ["generate", "--help", "--log-level=verbose"],
      ["unit-test", "--help", "--completions"],
    ]) {
      const result = runCli(home, ...args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Invalid arguments");
    }
  });

  test("rejects unknown actions, options, missing values, operands, and junk after help", () => {
    const home = makeHome();
    const malformed = [
      ["unknown"],
      ["--help", "junk"],
      ["generate", "--help", "junk"],
      ["unit-test", "--unknown"],
      ["import", "--dir"],
      ["composability", "extra", "--skill", "research"],
      ["family-overlap", "--", "extra"],
      ["family-overlap", "--skills", "-h"],
    ];
    for (const args of malformed) {
      const result = runCli(home, ...args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[ERROR]");
      expect(result.stderr).not.toContain("timestamp=");
    }
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("rejects Effect boolean assignments and automatic negations", () => {
    const home = makeHome();
    for (const args of [
      ["generate", "--list-skills=false"],
      ["generate", "--list-skills", "false"],
      ["generate", "--no-list-skills"],
      ["generate", "--no-no-negatives"],
      ["unit-test", "--generate=false"],
      ["unit-test", "--generate", "false"],
      ["unit-test", "--no-generate"],
    ]) {
      const result = runCli(home, ...args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("selftune eval");
    }
  });

  test("rejects malformed numeric and choice values before handlers run", () => {
    const home = makeHome();
    for (const args of [
      ["generate", "--max", "0"],
      ["generate", "--max", "1.5"],
      ["generate", "--seed", "1x"],
      ["generate", "--help", "--agent", "not-a-real-agent"],
      ["import", "--match-strategy", "typo"],
      ["composability", "--help", "--window", "0"],
      ["composability", "--help", "--window", "1.5"],
      ["composability", "--help", "--window", "9007199254740992"],
      ["family-overlap", "--min-overlap", "0.3x"],
      ["family-overlap", "--min-overlap", "0"],
      ["family-overlap", "--min-shared", "1.5"],
      ["family-overlap", "--min-shared", "9007199254740992"],
    ]) {
      const result = runCli(home, ...args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Invalid");
    }
  });

  test("preserves a failing unit-test suite as exit code one without direct process exit", () => {
    const home = makeHome();
    const testsPath = join(home, "tests.json");
    writeFileSync(
      testsPath,
      JSON.stringify([
        {
          id: "fails",
          skill_name: "research",
          query: "original query",
          assertions: [{ type: "contains", value: "missing" }],
        },
      ]),
    );

    const result = runCli(home, "unit-test", "--skill", "research", "--tests", testsPath);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stdout).toContain('"failed": 1');
    expect(existsSync(join(home, ".selftune", "unit-tests", "research.last-run.json"))).toBe(true);
  });

  test("keeps runtime eval modules free of argv parsing", () => {
    for (const relativePath of [
      "packages/runtime/eval/hooks-to-evals.ts",
      "packages/runtime/eval/unit-test-cli.ts",
      "packages/runtime/eval/import-skillsbench.ts",
      "packages/runtime/eval/family-overlap.ts",
    ]) {
      const source = readFileSync(join(SELF_TUNE_ROOT, relativePath), "utf8");
      expect(source).not.toContain("parseArgs");
      expect(source).not.toContain("process.argv");
    }
    const lifecycle = readFileSync(
      join(SELF_TUNE_ROOT, "apps/cli/src/commands/lifecycle.ts"),
      "utf8",
    );
    expect(lifecycle).not.toContain('case "eval"');
  });
});
