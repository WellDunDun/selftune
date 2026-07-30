import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import {
  makeLiveSkillSetsAction,
  runSkillSetsActionWithDependencies,
  type SkillSetsAction,
  type SkillSetsActionDependencies,
} from "../../apps/cli/src/effect-cli/commands/sets.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import {
  formatSkillSetsResult,
  runSkillSetsProgram,
  type SkillSetsProgramInput,
  type SkillSetsProgramResult,
} from "../../packages/runtime/skill-sets/programs.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

function run(args: ReadonlyArray<string>, skillSetsAction: SkillSetsAction) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { skillSetsAction }).pipe(Effect.provide(BunServices.layer)),
  );
}

function recordingAction(calls: unknown[]): SkillSetsAction {
  return (input, json) => Effect.sync(() => calls.push([input, json]));
}

type SkillSetsModule = Awaited<ReturnType<SkillSetsActionDependencies["loadModule"]>>;

function makeRuntimeModule(overrides: Partial<SkillSetsModule> = {}): SkillSetsModule {
  return {
    runSkillSetsProgram: (input) =>
      Effect.succeed({
        operation: input.operation,
        value: { operation: input.operation },
        text: input.operation,
      }),
    formatSkillSetsResult,
    ...overrides,
  };
}

describe("Effect CLI sets command", () => {
  test("dispatches all fourteen leaves with typed defaults and complete options", async () => {
    const calls: unknown[] = [];
    const action = recordingAction(calls);

    await run(["sets", "list"], action);
    await run(["sets", "receipts", "--json"], action);
    await run(["sets", "outcomes"], action);
    await run(["sets", "suggest"], action);
    await run(
      [
        "sets",
        "suggest",
        "--min-occurrences=4",
        "--min-affinity",
        "0.4",
        "--holdout-ratio=0.3",
        "--min-validation-occurrences",
        "5",
        "--min-evidence-score=.6",
        "--max",
        "8",
        "--json",
      ],
      action,
    );
    await run(["sets", "capture"], action);
    await run(
      [
        "sets",
        "create",
        "--name",
        "Web",
        "--description=Frontend",
        "--harness",
        "codex",
        "--harness=pi",
        "--skill-path",
        "one",
        "--skill-path=two",
        "--json",
      ],
      action,
    );
    await run(
      [
        "sets",
        "update",
        "--set",
        "web",
        "--parent-revision=abc",
        "--name=Web 2",
        "--description=Updated",
        "--harness=codex",
        "--skill-path=one",
        "--json",
      ],
      action,
    );
    await run(
      [
        "sets",
        "derive",
        "--name=Mobile",
        "--description=Apps",
        "--project=/tmp/app",
        "--harness=codex",
        "--harness=pi",
        "--json",
      ],
      action,
    );
    await run(["sets", "history", "--set=web", "--json"], action);
    await run(
      ["sets", "export", "--set=web", "--project=/tmp/app", "--output=/tmp/set.json"],
      action,
    );
    await run(["sets", "import", "--manifest=/tmp/set.json", "--json"], action);
    await run(["sets", "plan", "--set=web", "--project=/tmp/app", "--json"], action);
    await run(["sets", "apply", "--set=web", "--project=/tmp/app"], action);
    await run(["sets", "rollback", "--receipt=r-1", "--json"], action);

    expect(calls).toEqual([
      [{ operation: "list" }, false],
      [{ operation: "receipts" }, true],
      [{ operation: "outcomes" }, false],
      [
        {
          operation: "suggest",
          minOccurrences: 3,
          minAffinity: 0.35,
          holdoutRatio: 0.25,
          minValidationOccurrences: 2,
          minEvidenceScore: undefined,
          maxSuggestions: 6,
        },
        false,
      ],
      [
        {
          operation: "suggest",
          minOccurrences: 4,
          minAffinity: 0.4,
          holdoutRatio: 0.3,
          minValidationOccurrences: 5,
          minEvidenceScore: 0.6,
          maxSuggestions: 8,
        },
        true,
      ],
      [
        {
          operation: "capture",
          name: undefined,
          description: undefined,
          project: undefined,
          harnesses: [],
        },
        false,
      ],
      [
        {
          operation: "create",
          name: "Web",
          description: "Frontend",
          harnesses: ["codex", "pi"],
          skillPaths: ["one", "two"],
        },
        true,
      ],
      [
        {
          operation: "update",
          setId: "web",
          parentRevision: "abc",
          name: "Web 2",
          description: "Updated",
          harnesses: ["codex"],
          skillPaths: ["one"],
        },
        true,
      ],
      [
        {
          operation: "derive",
          name: "Mobile",
          description: "Apps",
          project: "/tmp/app",
          harnesses: ["codex", "pi"],
        },
        true,
      ],
      [{ operation: "history", setId: "web" }, true],
      [{ operation: "export", setId: "web", project: "/tmp/app", output: "/tmp/set.json" }, false],
      [{ operation: "import", manifest: "/tmp/set.json" }, true],
      [{ operation: "plan", setId: "web", project: "/tmp/app" }, true],
      [{ operation: "apply", setId: "web", project: "/tmp/app" }, false],
      [{ operation: "rollback", receiptId: "r-1" }, true],
    ]);
  });

  test("preserves Number coercion plus repeated, empty, dash, and equals values", async () => {
    const calls: unknown[] = [];
    const action = recordingAction(calls);
    await run(
      [
        "sets",
        "suggest",
        "--min-occurrences=1e2",
        "--min-affinity=",
        "--holdout-ratio=.1",
        "--max=01",
      ],
      action,
    );
    await run(
      [
        "sets",
        "create",
        "--name",
        "first",
        "--name=",
        "--description=a=b=c",
        "--harness=-custom",
        "--skill-path=",
        "--skill-path=-draft",
      ],
      action,
    );
    expect(calls).toEqual([
      [
        {
          operation: "suggest",
          minOccurrences: 100,
          minAffinity: 0,
          holdoutRatio: 0.1,
          minValidationOccurrences: 2,
          minEvidenceScore: undefined,
          maxSuggestions: 1,
        },
        false,
      ],
      [
        {
          operation: "create",
          name: "",
          description: "a=b=c",
          harnesses: ["-custom"],
          skillPaths: ["", "-draft"],
        },
        false,
      ],
    ]);
  });

  test("preserves parent fail-open help and the exact leaf help asymmetry", async () => {
    const action: SkillSetsAction = () =>
      Effect.fail(new CLIError("action should not run", "INTERNAL_ERROR"));
    await run(["sets"], action);
    await run(["sets", "--help", "--bad"], action);
    await Promise.all(
      [
        "list",
        "receipts",
        "suggest",
        "outcomes",
        "create",
        "capture",
        "plan",
        "apply",
        "rollback",
      ].map((leaf) => run(["sets", leaf, "-hh"], action)),
    );
    await run(["sets", "suggest", "--help", "--min-affinity=2"], action);
    await run(["sets", "create", "--help"], action);

    const unsupportedHelpErrors = await Promise.all(
      ["update", "derive", "history", "export", "import"].map((leaf) =>
        Effect.runPromise(
          makeEffectCliTestProgram(["sets", leaf, "--help"], { skillSetsAction: action }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    unsupportedHelpErrors.forEach((error) => expect(error).toMatchObject({ code: "INVALID_FLAG" }));

    const strictHelpError = await Effect.runPromise(
      makeEffectCliTestProgram(["sets", "list", "--help", "--bad"], {
        skillSetsAction: action,
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );
    expect(strictHelpError).toMatchObject({ code: "INVALID_FLAG" });
  });

  test("rejects numeric bounds and strict grammar before the action", async () => {
    const action: SkillSetsAction = () =>
      Effect.fail(new CLIError("action should not run", "INTERNAL_ERROR"));
    const errors = await Promise.all(
      [
        ["sets", "suggest", "--min-occurrences=0"],
        ["sets", "suggest", "--max=1.5"],
        ["sets", "suggest", "--min-affinity=Infinity"],
        ["sets", "suggest", "--holdout-ratio=.09"],
        ["sets", "suggest", "--holdout-ratio=.51"],
        ["sets", "list", "positional"],
        ["sets", "list", "--json=true"],
        ["sets", "create", "--no-json"],
        ["sets", "export", "--output"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { skillSetsAction: action }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    errors.forEach((error) => {
      expect(error).toMatchObject({ code: "INVALID_FLAG" });
      expect(error.message).not.toBe("action should not run");
    });
  });

  test("preserves unknown-subcommand identity and test programs fail closed", async () => {
    const unknown = await Effect.runPromise(
      makeEffectCliTestProgram(["sets", "unknown", "ignored"], {
        skillSetsAction: recordingAction([]),
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );
    expect(unknown).toMatchObject({
      code: "UNKNOWN_COMMAND",
      message: "Unknown sets subcommand: unknown",
      suggestion: "selftune sets --help",
    });

    const errors = await Promise.all(
      ["list", "receipts", "outcomes", "suggest", "create", "plan", "apply", "rollback"].map(
        (leaf) =>
          Effect.runPromise(
            makeEffectCliTestProgram(["sets", leaf]).pipe(
              Effect.provide(BunServices.layer),
              Effect.flip,
            ),
          ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "INTERNAL_ERROR" }));
  });

  test("live action lazy-loads and preserves TTY, non-TTY, explicit JSON, and export path output", async () => {
    const loads: string[] = [];
    const output: string[] = [];
    const exitCodes: number[] = [];
    let tty = true;
    const action = makeLiveSkillSetsAction({
      loadModule: async () => {
        loads.push("sets");
        return makeRuntimeModule({
          runSkillSetsProgram: (input) =>
            Effect.succeed({
              operation: input.operation,
              value: { operation: input.operation },
              text: input.operation === "export" ? "/tmp/set.json" : "plain",
              pathOnly: input.operation === "export",
            }),
        });
      },
      print: (message) => output.push(message),
      isTTY: () => tty,
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });

    await Effect.runPromise(action({ operation: "list" }, false));
    tty = false;
    await Effect.runPromise(action({ operation: "list" }, false));
    tty = true;
    await Effect.runPromise(action({ operation: "list" }, true));
    tty = false;
    await Effect.runPromise(action({ operation: "export" }, true));

    expect(loads).toEqual(["sets", "sets", "sets", "sets"]);
    expect(output).toEqual([
      "plain",
      '{\n  "operation": "list"\n}',
      '{\n  "operation": "list"\n}',
      "/tmp/set.json",
    ]);
    expect(exitCodes).toEqual([0, 0, 0, 0]);
  });

  test("maps import, runtime, formatter, TTY, printer, and exit failures and preserves CLIError", async () => {
    const input: SkillSetsProgramInput = { operation: "list" };
    const quiet = { print: () => {}, isTTY: () => true, setExitCode: () => {} };
    const importError = await Effect.runPromise(
      runSkillSetsActionWithDependencies(input, false, {
        ...quiet,
        loadModule: async () => {
          throw new Error("missing module");
        },
      }).pipe(Effect.flip),
    );
    expect(importError).toMatchObject({ code: "INTERNAL_ERROR" });

    const sentinel = new CLIError("sentinel", "GUARD_BLOCKED", undefined, 2);
    const identity = await Effect.runPromise(
      runSkillSetsActionWithDependencies(input, false, {
        ...quiet,
        loadModule: async () =>
          makeRuntimeModule({
            runSkillSetsProgram: () => Effect.fail(sentinel),
          }),
      }).pipe(Effect.flip),
    );
    expect(identity).toBe(sentinel);

    const result: SkillSetsProgramResult = { operation: "list", value: [], text: "plain" };
    const errors = await Promise.all(
      [
        {
          module: makeRuntimeModule({
            runSkillSetsProgram: () => Effect.succeed(result),
            formatSkillSetsResult: () => {
              throw new Error("format failed");
            },
          }),
          print: () => {},
          isTTY: () => true,
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({ runSkillSetsProgram: () => Effect.succeed(result) }),
          print: () => {},
          isTTY: () => {
            throw new Error("tty failed");
          },
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({ runSkillSetsProgram: () => Effect.succeed(result) }),
          print: () => {
            throw new Error("print failed");
          },
          isTTY: () => true,
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({ runSkillSetsProgram: () => Effect.succeed(result) }),
          print: () => {},
          isTTY: () => true,
          setExitCode: () => {
            throw new Error("exit failed");
          },
        },
      ].map((boundary) =>
        Effect.runPromise(
          runSkillSetsActionWithDependencies(input, false, {
            loadModule: async () => boundary.module,
            print: boundary.print,
            isTTY: boundary.isTTY,
            setExitCode: boundary.setExitCode,
          }).pipe(Effect.flip),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "OPERATION_FAILED" }));
  });

  test("runtime translates library errors and keeps export output path-only", async () => {
    const missing = await Effect.runPromise(
      runSkillSetsProgram({ operation: "history", setId: "" }).pipe(Effect.flip),
    );
    expect(missing).toBeInstanceOf(CLIError);
    expect(missing).toMatchObject({ code: "MISSING_FLAG", message: "--set is required." });

    const precedence = await Effect.runPromise(
      runSkillSetsProgram({
        operation: "create",
        name: "invalid-harness-without-skills",
        harnesses: ["unsupported"],
        skillPaths: [],
      }).pipe(Effect.flip),
    );
    expect(precedence).toMatchObject({
      code: "MISSING_FLAG",
      message: "Select at least one skill.",
    });

    const pathResult: SkillSetsProgramResult = {
      operation: "export",
      value: "/tmp/set.json",
      text: "/tmp/set.json",
      pathOnly: true,
    };
    expect(formatSkillSetsResult(pathResult, false)).toBe("/tmp/set.json");
    expect(formatSkillSetsResult(pathResult, true)).toBe("/tmp/set.json");
  });

  test("is Effect-owned, absent from legacy routing, and owns its lazy module", () => {
    expect(isEffectCliInvocation("sets", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("sets");
    const source = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/effect-cli/commands/sets.ts"),
      "utf8",
    );
    expect(source).toContain('import("@selftune/runtime/skill-sets/programs")');
    expect(source).not.toMatch(/\bcliMain\b|process\.argv|process\.exit\s*\(/);
    expect(source).not.toMatch(/Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/);
  });
});
