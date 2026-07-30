import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LocalDatabaseError,
  LocalDatabaseService,
  makeLocalDatabaseLive,
} from "../../packages/local-store/src/db.js";
import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import {
  runWorkflowsActionWithDependencies,
  type WorkflowsAction,
  type WorkflowsActionDependencies,
} from "../../apps/cli/src/effect-cli/commands/workflows.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import {
  formatWorkflowResult,
  type WorkflowProgramInput,
  type WorkflowProgramResult,
} from "../../packages/runtime/workflows/programs.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

function run(args: ReadonlyArray<string>, workflowsAction: WorkflowsAction) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { workflowsAction }).pipe(Effect.provide(BunServices.layer)),
  );
}

interface WorkflowCall {
  readonly input: WorkflowProgramInput;
  readonly jsonRequested: boolean;
}

function recordingAction(calls: WorkflowCall[]): WorkflowsAction {
  return (input, jsonRequested) => Effect.sync(() => calls.push({ input, jsonRequested }));
}

type WorkflowsModule = Awaited<ReturnType<WorkflowsActionDependencies["loadModule"]>>;
const TEST_DATABASE_LAYER = makeLocalDatabaseLive(":memory:");

function discoverResult(): WorkflowProgramResult {
  return {
    operation: "discover",
    value: { workflows: [], total_sessions_analyzed: 0, generated_at: "2026-01-01T00:00:00Z" },
  };
}

function makeRuntimeModule(overrides: Partial<WorkflowsModule> = {}): WorkflowsModule {
  return {
    runWorkflowProgram: () => Effect.succeed(discoverResult()),
    formatWorkflowResult,
    ...overrides,
  };
}

describe("Effect CLI workflows command", () => {
  test("dispatches default discovery, save, and scaffold as typed operations", async () => {
    const calls: WorkflowCall[] = [];
    const action = recordingAction(calls);

    await run(["workflows"], action);
    await run(
      [
        "workflows",
        "save",
        "workflow-1",
        "--min-occurrences",
        "4",
        "--window",
        "25",
        "--skill",
        "cloudflare",
        "--skill-path",
        "/tmp/SKILL.md",
      ],
      action,
    );
    await run(
      [
        "workflows",
        "scaffold",
        "2",
        "--output-dir",
        "/tmp/skills",
        "--skill-name",
        "release-flow",
        "--description",
        "Release safely",
        "--write",
        "--force",
        "--json",
      ],
      action,
    );

    expect(calls).toEqual([
      {
        input: {
          operation: "discover",
          minOccurrences: undefined,
          window: undefined,
          skill: undefined,
        },
        jsonRequested: false,
      },
      {
        input: {
          operation: "save",
          selection: "workflow-1",
          minOccurrences: 4,
          window: 25,
          skill: "cloudflare",
          skillPath: "/tmp/SKILL.md",
        },
        jsonRequested: false,
      },
      {
        input: {
          operation: "scaffold",
          selection: "2",
          minOccurrences: undefined,
          window: undefined,
          skill: undefined,
          outputDir: "/tmp/skills",
          skillName: "release-flow",
          description: "Release safely",
          write: true,
          force: true,
        },
        jsonRequested: true,
      },
    ]);
  });

  test("preserves fallback discovery, global flag tolerance, last wins, and parseInt quirks", async () => {
    const calls: WorkflowCall[] = [];
    const action = recordingAction(calls);

    await run(
      [
        "workflows",
        "not-a-subcommand",
        "ignored",
        "--min-occurrences",
        "12cats",
        "--window=4.9",
        "--skill",
        "first",
        "--skill=second",
        "--skill-path",
        "ignored.md",
        "--output-dir",
        "ignored",
        "--write",
        "--force",
        "--json",
      ],
      action,
    );
    await run(
      [
        "workflows",
        "save",
        "1",
        "extra",
        "--min-occurrences=0x10",
        "--window=",
        "--skill-path=first",
        "--skill-path=-target.md",
        "--json",
        "--write",
      ],
      action,
    );

    expect(calls[0]).toEqual({
      input: {
        operation: "discover",
        minOccurrences: 12,
        window: 4,
        skill: "second",
      },
      jsonRequested: true,
    });
    expect(calls[1]).toEqual({
      input: {
        operation: "save",
        selection: "1",
        minOccurrences: 0,
        window: undefined,
        skill: undefined,
        skillPath: "-target.md",
      },
      jsonRequested: false,
    });
  });

  test("keeps universal help strict while preserving legacy validation precedence", async () => {
    const calls: WorkflowCall[] = [];
    const action = recordingAction(calls);

    await run(["workflows", "scaffold", "1", "--help", "--min-occurrences", "invalid"], action);
    expect(calls).toEqual([]);

    const errors = await Promise.all(
      [
        ["workflows", "--help", "--unknown"],
        ["workflows", "--min-occurrences", "invalid"],
        ["workflows", "--window=-1day"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { workflowsAction: action }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    expect(errors[0]).toMatchObject({ code: "INVALID_FLAG" });
    expect(errors[1]).toMatchObject({
      code: "INVALID_FLAG",
      message: "--min-occurrences must be a non-negative integer.",
    });
    expect(errors[2]).toMatchObject({
      code: "INVALID_FLAG",
      message: "--window must be a non-negative integer.",
    });
  });

  test("shared test programs fail closed for all operations", async () => {
    const errors = await Promise.all(
      [["workflows"], ["workflows", "save", "1"], ["workflows", "scaffold", "1"]].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args).pipe(Effect.provide(BunServices.layer), Effect.flip),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "INTERNAL_ERROR" }));
  });

  test("live action lazy-loads, awaits the program, and owns output and exit ordering", async () => {
    const events: string[] = [];
    const input: WorkflowProgramInput = {
      operation: "discover",
    };
    const action = runWorkflowsActionWithDependencies(input, false, {
      loadModule: async () => {
        events.push("load");
        return makeRuntimeModule({
          runWorkflowProgram: () =>
            Effect.sync(() => {
              events.push("program-complete");
              return discoverResult();
            }),
          formatWorkflowResult: (_result, jsonOutput) => {
            events.push(`format:${jsonOutput}`);
            return "ready";
          },
        });
      },
      print: (message) => events.push(`print:${message}`),
      isTTY: () => true,
      setExitCode: (exitCode) => events.push(`exit:${exitCode}`),
      databaseLayer: TEST_DATABASE_LAYER,
    });

    expect(events).toEqual([]);
    await Effect.runPromise(action);
    expect(events).toEqual(["load", "program-complete", "format:false", "print:ready", "exit:0"]);
  });

  test("requests JSON formatting explicitly or whenever stdout is not a TTY", async () => {
    const jsonModes: boolean[] = [];
    const dependencies: WorkflowsActionDependencies = {
      loadModule: async () =>
        makeRuntimeModule({
          formatWorkflowResult: (_result, jsonOutput) => {
            jsonModes.push(jsonOutput);
            return "ready";
          },
        }),
      print: () => {},
      isTTY: () => false,
      setExitCode: () => {},
      databaseLayer: TEST_DATABASE_LAYER,
    };
    const input: WorkflowProgramInput = { operation: "discover" };

    await Effect.runPromise(runWorkflowsActionWithDependencies(input, false, dependencies));
    await Effect.runPromise(
      runWorkflowsActionWithDependencies(input, true, {
        ...dependencies,
        isTTY: () => true,
      }),
    );

    expect(jsonModes).toEqual([true, true]);
  });

  test("maps boundary failures and preserves typed runtime failures", async () => {
    const input: WorkflowProgramInput = {
      operation: "discover",
    };
    const quiet = { print: () => {}, setExitCode: () => {} };
    const importError = await Effect.runPromise(
      runWorkflowsActionWithDependencies(input, false, {
        ...quiet,
        isTTY: () => false,
        databaseLayer: TEST_DATABASE_LAYER,
        loadModule: async () => {
          throw new Error("missing module");
        },
      }).pipe(Effect.flip),
    );
    expect(importError).toMatchObject({ code: "INTERNAL_ERROR" });

    const sentinel = new CLIError("sentinel", "GUARD_BLOCKED", undefined, 2);
    const identity = await Effect.runPromise(
      runWorkflowsActionWithDependencies(input, false, {
        ...quiet,
        isTTY: () => false,
        databaseLayer: TEST_DATABASE_LAYER,
        loadModule: async () =>
          makeRuntimeModule({ runWorkflowProgram: () => Effect.fail(sentinel) }),
      }).pipe(Effect.flip),
    );
    expect(identity).toBe(sentinel);

    const result = discoverResult();
    const errors = await Promise.all(
      [
        {
          module: makeRuntimeModule({
            runWorkflowProgram: () =>
              Effect.fail(new CLIError("program failed", "OPERATION_FAILED")),
          }),
          print: () => {},
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({
            runWorkflowProgram: () => Effect.succeed(result),
            formatWorkflowResult: () => {
              throw new Error("format failed");
            },
          }),
          print: () => {},
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({ runWorkflowProgram: () => Effect.succeed(result) }),
          print: () => {
            throw new Error("print failed");
          },
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({ runWorkflowProgram: () => Effect.succeed(result) }),
          print: () => {},
          setExitCode: () => {
            throw new Error("exit failed");
          },
        },
      ].map((boundary) =>
        Effect.runPromise(
          runWorkflowsActionWithDependencies(input, false, {
            loadModule: async () => boundary.module,
            print: boundary.print,
            isTTY: () => false,
            setExitCode: boundary.setExitCode,
            databaseLayer: TEST_DATABASE_LAYER,
          }).pipe(Effect.flip),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "OPERATION_FAILED" }));

    const ttyError = await Effect.runPromise(
      runWorkflowsActionWithDependencies(input, false, {
        ...quiet,
        loadModule: async () => makeRuntimeModule(),
        isTTY: () => {
          throw new Error("tty probe failed");
        },
        databaseLayer: TEST_DATABASE_LAYER,
      }).pipe(Effect.flip),
    );
    expect(ttyError).toMatchObject({ code: "OPERATION_FAILED" });

    const databaseError = await Effect.runPromise(
      runWorkflowsActionWithDependencies(input, false, {
        ...quiet,
        loadModule: async () => makeRuntimeModule(),
        isTTY: () => false,
        databaseLayer: Layer.effect(LocalDatabaseService)(
          Effect.fail(
            new LocalDatabaseError({
              path: "/invalid/selftune.db",
              message: "database unavailable",
              cause: new Error("open failed"),
            }),
          ),
        ),
      }).pipe(Effect.flip),
    );
    expect(databaseError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Workflow discover failed: database unavailable",
    });
  });

  test("is fully Effect-owned and does not route through the Promise CLI", () => {
    expect(isEffectCliInvocation("workflows", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("workflows");

    const commandSource = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/effect-cli/commands/workflows.ts"),
      "utf8",
    );
    expect(commandSource).toContain('import("@selftune/runtime/workflows/programs")');
    expect(commandSource).not.toMatch(/\bcliMain\b|process\.argv|process\.exit\s*\(/);
    expect(commandSource).not.toMatch(/Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/);

    const operationsSource = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/commands/operations.ts"),
      "utf8",
    );
    expect(operationsSource).not.toContain('case "workflows"');
  });
});
