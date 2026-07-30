import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import {
  runContributeActionWithDependencies,
  type ContributeAction,
  type ContributeCommandInput,
} from "../../apps/cli/src/effect-cli/commands/contribute.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import type {
  ContributeResult,
  FormattedContributeResult,
} from "../../packages/runtime/contribute/program.js";
import type { ContributionBundle } from "../../packages/runtime/types.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const bundle: ContributionBundle = {
  schema_version: "1.2",
  skill_name: "demo",
  contributor_id: "anonymous",
  created_at: "2026-01-02T03:04:05.000Z",
  selftune_version: "test",
  agent_type: "codex",
  sanitization_level: "conservative",
  positive_queries: [],
  eval_entries: [],
  grading_summary: null,
  evolution_summary: null,
  session_metrics: {
    total_sessions: 0,
    avg_assistant_turns: 0,
    avg_tool_calls: 0,
    avg_errors: 0,
    top_tools: [],
  },
};

function makeResult(exitCode = 0): ContributeResult {
  return {
    bundle,
    skillName: "demo",
    sanitizationLevel: "conservative",
    preview: false,
    outputPath: "/tmp/demo.json",
    serviceSubmission: null,
    githubSubmission: null,
    fellBackToGitHub: false,
    exitCode,
  };
}

function run(args: ReadonlyArray<string>, contributeAction: ContributeAction) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { contributeAction }).pipe(Effect.provide(BunServices.layer)),
  );
}

describe("Effect CLI contribute command", () => {
  test("dispatches defaults and every option as typed input", async () => {
    const inputs: ContributeCommandInput[] = [];
    const action: ContributeAction = (input) => Effect.sync(() => inputs.push(input));

    await run(["contribute"], action);
    await run(
      [
        "contribute",
        "--skill",
        "demo",
        "--output=/tmp/demo.json",
        "--preview",
        "--sanitize",
        "aggressive",
        "--since",
        "2026-01-01",
        "--submit",
        "--endpoint=https://example.test/api?x=1",
        "--github",
      ],
      action,
    );

    expect(inputs).toEqual([
      {
        skillName: "selftune",
        outputPath: undefined,
        preview: false,
        sanitizationLevel: "conservative",
        since: undefined,
        submit: false,
        endpoint: undefined,
        github: false,
      },
      {
        skillName: "demo",
        outputPath: "/tmp/demo.json",
        preview: true,
        sanitizationLevel: "aggressive",
        since: "2026-01-01",
        submit: true,
        endpoint: "https://example.test/api?x=1",
        github: true,
      },
    ]);
  });

  test("preserves repeated, empty, leading-dash, embedded-equals, and clustered-help parsing", async () => {
    const inputs: ContributeCommandInput[] = [];
    const action: ContributeAction = (input) => Effect.sync(() => inputs.push(input));
    await run(["contribute", "--skill", "first", "--skill="], action);
    await run(["contribute", "--output=-draft"], action);
    await run(["contribute", "--endpoint=https://example.test?a=b=c"], action);
    await run(["contribute", "-hh"], action);

    expect(inputs).toHaveLength(3);
    expect(inputs[0]?.skillName).toBe("");
    expect(inputs[1]?.outputPath).toBe("-draft");
    expect(inputs[2]?.endpoint).toBe("https://example.test?a=b=c");
  });

  test("keeps help strict and rejects malformed grammar before the action", async () => {
    const action: ContributeAction = () =>
      Effect.fail(new CLIError("action should not run", "INTERNAL_ERROR"));
    const errors = await Promise.all(
      [
        ["contribute", "--help", "--bogus"],
        ["contribute", "positional"],
        ["contribute", "--preview=true"],
        ["contribute", "--since"],
        ["contribute", "--unknown"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { contributeAction: action }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    errors.forEach((error) => {
      expect(error).toBeInstanceOf(CLIError);
      expect(error.message).not.toBe("action should not run");
    });
  });

  test("test programs fail closed when no action is injected", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["contribute"]).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );
    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live contribute is disabled in the Effect CLI test program.",
    });
  });

  test("lazy-loads the runtime and owns stdout, stderr, and exit status", async () => {
    const loads: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCodes: number[] = [];
    const formatted: FormattedContributeResult = {
      stdout: ["bundle written", "submitted"],
      stderr: ["service warning"],
    };
    await Effect.runPromise(
      runContributeActionWithDependencies(
        { skillName: "demo" },
        {
          loadModule: async () => {
            loads.push("contribute");
            return {
              runContribute: async () => makeResult(1),
              formatContributeResult: () => formatted,
            };
          },
          print: (message) => stdout.push(message),
          printError: (message) => stderr.push(message),
          setExitCode: (exitCode) => exitCodes.push(exitCode),
        },
      ),
    );

    expect(loads).toEqual(["contribute"]);
    expect(stdout).toEqual(["bundle written", "submitted"]);
    expect(stderr).toEqual(["service warning"]);
    expect(exitCodes).toEqual([1]);
  });

  test("maps boundary failures and preserves CLIError identity", async () => {
    const output = { print: () => {}, printError: () => {}, setExitCode: () => {} };
    const importError = await Effect.runPromise(
      runContributeActionWithDependencies(
        {},
        {
          ...output,
          loadModule: async () => {
            throw new Error("missing module");
          },
        },
      ).pipe(Effect.flip),
    );
    expect(importError).toMatchObject({ code: "INTERNAL_ERROR" });

    const sentinel = new CLIError("sentinel", "MISSING_DATA");
    const identity = await Effect.runPromise(
      runContributeActionWithDependencies(
        {},
        {
          ...output,
          loadModule: async () => ({
            runContribute: async () => {
              throw sentinel;
            },
            formatContributeResult: () => ({ stdout: [], stderr: [] }),
          }),
        },
      ).pipe(Effect.flip),
    );
    expect(identity).toBe(sentinel);

    const failures = await Promise.all(
      [
        {
          runContribute: async () => {
            throw new Error("run failed");
          },
          formatContributeResult: () => ({ stdout: [], stderr: [] }),
          print: () => {},
          printError: () => {},
          setExitCode: () => {},
        },
        {
          runContribute: async () => makeResult(),
          formatContributeResult: () => {
            throw new Error("format failed");
          },
          print: () => {},
          printError: () => {},
          setExitCode: () => {},
        },
        {
          runContribute: async () => makeResult(),
          formatContributeResult: () => ({ stdout: ["value"], stderr: [] }),
          print: () => {
            throw new Error("print failed");
          },
          printError: () => {},
          setExitCode: () => {},
        },
        {
          runContribute: async () => makeResult(),
          formatContributeResult: () => ({ stdout: [], stderr: [] }),
          print: () => {},
          printError: () => {},
          setExitCode: () => {
            throw new Error("exit failed");
          },
        },
      ].map((boundary) =>
        Effect.runPromise(
          runContributeActionWithDependencies(
            {},
            {
              loadModule: async () => boundary,
              print: boundary.print,
              printError: boundary.printError,
              setExitCode: boundary.setExitCode,
            },
          ).pipe(Effect.flip),
        ),
      ),
    );
    failures.forEach((error) =>
      expect(error).toMatchObject({
        code: "OPERATION_FAILED",
        message: expect.stringContaining("Contribute failed:"),
      }),
    );
  });

  test("is Effect-owned, absent from legacy routing, and owns its lazy module", () => {
    expect(isEffectCliInvocation("contribute", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("contribute");
    const source = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/effect-cli/commands/contribute.ts"),
      "utf8",
    );
    expect(source).toContain('import("@selftune/runtime/contribute/contribute")');
    expect(source).not.toMatch(/\bcliMain\b|process\.argv|process\.exit\s*\(/);
    expect(source).not.toMatch(/Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/);
  });
});
