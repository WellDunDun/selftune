import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import {
  runWatchActionWithDependencies,
  type WatchAction,
  type WatchActionDependencies,
  type WatchProgramModule,
} from "../../apps/cli/src/effect-cli/commands/watch.js";
import {
  prepareLegacyWatchArguments,
  WATCH_INTERNAL_HELP_FLAG,
  WatchLegacyParseFailure,
  WatchLegacyRuntimeFailure,
} from "../../apps/cli/src/effect-cli/compatibility/watch.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import type {
  WatchProgramInput,
  WatchProgramResult,
} from "../../packages/orchestration/src/watch/model.js";
import {
  WatchDiagnostics,
  WatchEvaluation,
  WatchMemory,
  WatchRollback,
  WatchSourceSync,
} from "../../packages/orchestration/src/watch/services.js";
import type { WatchResult } from "../../packages/runtime/monitoring/watch.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const BASE_INPUT: WatchProgramInput = {
  skillName: "demo",
  skillPath: "skills/demo/SKILL.md",
  windowSessions: 20,
  regressionThreshold: 0.1,
  gradeRegressionThreshold: 0.15,
  enableGradeWatch: true,
  autoRollback: false,
  syncFirst: false,
  syncForce: false,
};

const TEST_WATCH_LAYER = Layer.mergeAll(
  Layer.succeed(
    WatchSourceSync,
    WatchSourceSync.of({ run: () => Effect.die("unused watch source sync") }),
  ),
  Layer.succeed(
    WatchEvaluation,
    WatchEvaluation.of({ run: () => Effect.die("unused watch evaluation") }),
  ),
  Layer.succeed(
    WatchRollback,
    WatchRollback.of({ run: () => Effect.die("unused watch rollback") }),
  ),
  Layer.succeed(WatchMemory, WatchMemory.of({ update: () => Effect.die("unused watch memory") })),
);

function diagnosticsLayer(report: (message: string) => void) {
  return Layer.succeed(WatchDiagnostics, WatchDiagnostics.of({ report }));
}

function watchResult(): WatchResult {
  return {
    snapshot: {
      timestamp: "2026-07-17T00:00:00.000Z",
      skill_name: "demo",
      window_sessions: 20,
      skill_checks: 0,
      pass_rate: 0,
      false_negative_rate: 0,
      by_invocation_type: {
        explicit: { passed: 0, total: 0 },
        implicit: { passed: 0, total: 0 },
        contextual: { passed: 0, total: 0 },
        negative: { passed: 0, total: 0 },
      },
      regression_detected: false,
      baseline_pass_rate: 0.5,
    },
    alert: null,
    rolledBack: false,
    recommendation: "Need more data.",
  };
}

function programResult(overrides: Partial<WatchProgramResult> = {}): WatchProgramResult {
  return {
    watch: watchResult(),
    stdout: ["watch-json"],
    stderr: [],
    exitCode: 0,
    ...overrides,
  };
}

function makeRuntimeModule(overrides: Partial<WatchProgramModule> = {}): WatchProgramModule {
  return {
    isWatchInternalFailure: () => false,
    makeWatchDiagnosticsLayer: diagnosticsLayer,
    runWatchProgram: () => Effect.succeed(programResult()),
    watchLiveLayer: TEST_WATCH_LAYER,
    ...overrides,
  };
}

function run(args: ReadonlyArray<string>, watchAction: WatchAction) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { watchAction }).pipe(Effect.provide(BunServices.layer)),
  );
}

describe("watch Effect CLI compatibility", () => {
  test("dispatches the complete validated watch input and keeps duplicate last-wins behavior", async () => {
    const inputs: WatchProgramInput[] = [];
    await run(
      [
        "watch",
        "--skill",
        "first",
        "--skill=-dash",
        "--skill-path",
        "first.md",
        "--skill-path=-skill.md",
        "--window",
        "2",
        "--window=7",
        "--threshold",
        "1",
        "--threshold=0",
        "--grade-threshold",
        "1",
        "--grade-threshold=0",
        "--auto-rollback",
        "--no-grade-watch",
        "--sync-first",
        "--sync-force",
      ],
      (input) => Effect.sync(() => inputs.push(input)),
    );

    expect(inputs).toEqual([
      {
        skillName: "-dash",
        skillPath: "-skill.md",
        windowSessions: 7,
        regressionThreshold: 0,
        gradeRegressionThreshold: 0,
        enableGradeWatch: false,
        autoRollback: true,
        syncFirst: true,
        syncForce: true,
      },
    ]);
  });

  test("preserves parser, help, required, dependency, and numeric validation ordering", async () => {
    expect(prepareLegacyWatchArguments(["--help", "--window", "bad"])).toEqual([
      `--${WATCH_INTERNAL_HELP_FLAG}`,
    ]);
    expect(() => prepareLegacyWatchArguments(["--help", "--unknown"])).toThrow(
      WatchLegacyParseFailure,
    );
    expect(() => prepareLegacyWatchArguments(["--sync-force", "--window", "bad"])).toThrow(
      new CLIError(
        "--skill and --skill-path are required.",
        "MISSING_FLAG",
        "Usage: selftune watch --skill <name> --skill-path <path>",
      ),
    );
    expect(() =>
      prepareLegacyWatchArguments([
        "--skill",
        "demo",
        "--skill-path",
        "skill.md",
        "--sync-force",
        "--window",
        "bad",
      ]),
    ).toThrow(
      new CLIError(
        "--sync-force requires --sync-first.",
        "INVALID_FLAG",
        "Add --sync-first when using --sync-force.",
      ),
    );
  });

  test("help and invalid grammar never invoke the command action", async () => {
    const calls: WatchProgramInput[] = [];
    const action: WatchAction = (input) => Effect.sync(() => calls.push(input));
    await run(["watch", "--help", "--window", "bad"], action);
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["watch", "-h"], { watchAction: action }).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(WatchLegacyParseFailure);
    expect(calls).toEqual([]);
  });

  test("the shared test root fails closed for watch", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["watch", "--skill", "demo", "--skill-path", "skill.md"]).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );
    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live watch is disabled in the Effect CLI test program.",
    });
  });

  test("is fully Effect-owned and keeps orchestration values behind a lazy boundary", () => {
    expect(isEffectCliInvocation("watch", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("watch");

    const commandSource = readFileSync(
      new URL("../../apps/cli/src/effect-cli/commands/watch.ts", import.meta.url),
      "utf8",
    );
    const operationsSource = readFileSync(
      new URL("../../apps/cli/src/commands/operations.ts", import.meta.url),
      "utf8",
    );
    expect(commandSource).not.toMatch(
      /import\s+(?!type\b)[^;]*from\s+["']@selftune\/orchestration\/watch/,
    );
    expect(commandSource).toContain(
      'loadModule: () => import("@selftune/orchestration/watch/programs")',
    );
    expect(commandSource).not.toMatch(/cliMain|liveSourceSyncRunner|Effect\.run/);
    expect(operationsSource).not.toContain('case "watch"');
  });
});

describe("watch Effect action boundary", () => {
  test("loads lazily, writes diagnostics before JSON, and applies the result exit status", async () => {
    let loads = 0;
    const output: string[] = [];
    const exits: number[] = [];
    const effect = runWatchActionWithDependencies(BASE_INPUT, {
      loadModule: async () => {
        loads += 1;
        return makeRuntimeModule({
          runWatchProgram: () =>
            Effect.succeed(
              programResult({
                stderr: ["diagnostic-one", "diagnostic-two"],
                stdout: ["pretty-json"],
                exitCode: 1,
              }),
            ),
        });
      },
      writeStdout: (message) => output.push(`stdout:${message}`),
      writeStderr: (message) => output.push(`stderr:${message}`),
      setExitCode: (exitCode) => exits.push(exitCode),
    });

    expect(loads).toBe(0);
    await Effect.runPromise(effect);
    expect(loads).toBe(1);
    expect(output).toEqual([
      "stderr:diagnostic-one",
      "stderr:diagnostic-two",
      "stdout:pretty-json",
    ]);
    expect(exits).toEqual([1]);
  });

  test("maps import, construction, runtime, and output failures without losing CLIError identity", async () => {
    const quiet: Omit<WatchActionDependencies, "loadModule"> = {
      writeStdout: () => {},
      writeStderr: () => {},
      setExitCode: () => {},
    };
    const importError = await Effect.runPromise(
      runWatchActionWithDependencies(BASE_INPUT, {
        ...quiet,
        loadModule: async () => Promise.reject(new Error("module missing")),
      }).pipe(Effect.flip),
    );
    expect(importError).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unable to load watch support: module missing",
    });

    const constructionError = await Effect.runPromise(
      runWatchActionWithDependencies(BASE_INPUT, {
        ...quiet,
        loadModule: async () =>
          makeRuntimeModule({
            runWatchProgram: () => {
              throw new Error("construction failed");
            },
          }),
      }).pipe(Effect.flip),
    );
    expect(constructionError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Watch failed: construction failed",
    });

    const typed = new CLIError("watch input rejected", "INVALID_FLAG");
    const typedError = await Effect.runPromise(
      runWatchActionWithDependencies(BASE_INPUT, {
        ...quiet,
        loadModule: async () => makeRuntimeModule({ runWatchProgram: () => Effect.fail(typed) }),
      }).pipe(Effect.flip),
    );
    expect(typedError).toBe(typed);

    const internalError = await Effect.runPromise(
      runWatchActionWithDependencies(BASE_INPUT, {
        ...quiet,
        loadModule: async () =>
          makeRuntimeModule({
            isWatchInternalFailure: (cause) =>
              cause instanceof Error && cause.message === "database unavailable",
            runWatchProgram: () => Effect.fail(new Error("database unavailable")),
          }),
      }).pipe(Effect.flip),
    );
    expect(internalError).toBeInstanceOf(WatchLegacyRuntimeFailure);
    expect(internalError.message).toBe("database unavailable");

    const outputError = await Effect.runPromise(
      runWatchActionWithDependencies(BASE_INPUT, {
        ...quiet,
        loadModule: async () => makeRuntimeModule(),
        writeStdout: () => {
          throw new Error("stdout failed");
        },
      }).pipe(Effect.flip),
    );
    expect(outputError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Watch failed: stdout failed",
    });
  });
});
