import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { readFileSync } from "node:fs";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import {
  runSyncActionWithDependencies,
  type SyncAction,
  type SyncActionDependencies,
  type SyncCommandInput,
  type SyncProgramModule,
} from "../../apps/cli/src/effect-cli/commands/sync.js";
import {
  prepareLegacySyncArguments,
  SYNC_INTERNAL_HELP_FLAG,
  SyncLegacyParseFailure,
} from "../../apps/cli/src/effect-cli/compatibility/sync.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import type {
  SyncProgramInput,
  SyncProgramResult,
  SyncResult,
} from "../../packages/orchestration/src/sync/model.js";
import {
  SyncAudit,
  SyncCore,
  SyncInternalFailure,
  SyncProgress,
  SyncPreferences,
} from "../../packages/orchestration/src/sync/services.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

interface SyncCall {
  readonly input: SyncCommandInput;
  readonly jsonRequested: boolean;
}

function run(args: ReadonlyArray<string>, syncAction: SyncAction) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { syncAction }).pipe(Effect.provide(BunServices.layer)),
  );
}

function recordingAction(calls: SyncCall[]): SyncAction {
  return (input, jsonRequested) =>
    Effect.sync(() => {
      calls.push({ input, jsonRequested });
    });
}

const TEST_SYNC_LAYER = Layer.mergeAll(
  Layer.succeed(
    SyncPreferences,
    SyncPreferences.of({
      load: () => Effect.die("unused sync preferences"),
    }),
  ),
  Layer.succeed(
    SyncCore,
    SyncCore.of({
      run: () => Effect.die("unused sync core"),
    }),
  ),
  Layer.succeed(
    SyncAudit,
    SyncAudit.of({
      recordSuccess: () => Effect.die("unused sync audit"),
      recordError: () => Effect.die("unused sync audit"),
    }),
  ),
);

function emptySyncResult(): SyncResult {
  const unavailable = { available: false, scanned: 0, synced: 0, skipped: 0 };
  return {
    since: null,
    dry_run: false,
    sources: {
      claude: unavailable,
      codex: unavailable,
      opencode: unavailable,
      openclaw: unavailable,
      pi: unavailable,
    },
    repair: {
      ran: false,
      repaired_sessions: 0,
      repaired_records: 0,
      codex_repaired_records: 0,
    },
    creator_contributions: {
      ran: true,
      eligible_skills: 0,
      built_signals: 0,
      staged_signals: 0,
    },
    timings: [],
    total_elapsed_ms: 2,
  };
}

function programResult(overrides: Partial<SyncProgramResult> = {}): SyncProgramResult {
  return {
    sync: emptySyncResult(),
    stdout: [],
    stderr: [],
    exitCode: 0,
    ...overrides,
  };
}

function makeRuntimeModule(overrides: Partial<SyncProgramModule> = {}): SyncProgramModule {
  return {
    isSyncInternalFailure: (cause) => cause instanceof SyncInternalFailure,
    makeSyncProgressLayer: (report) => Layer.succeed(SyncProgress, SyncProgress.of({ report })),
    runSyncProgram: () => Effect.succeed(programResult()),
    syncLiveLayer: TEST_SYNC_LAYER,
    ...overrides,
  };
}

const baseInput: SyncCommandInput = {
  dryRun: false,
  force: false,
  skipClaude: false,
  skipCodex: false,
  skipOpenCode: false,
  skipOpenClaw: false,
  skipPi: false,
  skipRepair: false,
};

describe("sync Effect CLI compatibility", () => {
  test("dispatches every value and boolean as a typed program input", async () => {
    const calls: SyncCall[] = [];
    await run(
      [
        "sync",
        "--projects-dir",
        "/tmp/claude-first",
        "--projects-dir=-claude-last",
        "--codex-home=/tmp/codex",
        "--opencode-data-dir=/tmp/opencode",
        "--openclaw-agents-dir=/tmp/openclaw",
        "--pi-sessions-dir=/tmp/pi",
        "--skill-log=/tmp/skill.jsonl",
        "--repaired-skill-log=/tmp/repaired.jsonl",
        "--repaired-sessions-marker=/tmp/repaired.json",
        "--since=2026-01-02",
        "--dry-run",
        "--force",
        "--no-claude",
        "--no-codex",
        "--no-opencode",
        "--no-openclaw",
        "--no-pi",
        "--no-repair",
        "--json",
      ],
      recordingAction(calls),
    );

    expect(calls).toEqual([
      {
        input: {
          projectsDir: "-claude-last",
          codexHome: "/tmp/codex",
          opencodeDataDir: "/tmp/opencode",
          openclawAgentsDir: "/tmp/openclaw",
          piSessionsDir: "/tmp/pi",
          skillLogPath: "/tmp/skill.jsonl",
          repairedSkillLogPath: "/tmp/repaired.jsonl",
          repairedSessionsPath: "/tmp/repaired.json",
          since: new Date("2026-01-02"),
          sinceArgument: "2026-01-02",
          dryRun: true,
          force: true,
          skipClaude: true,
          skipCodex: true,
          skipOpenCode: true,
          skipOpenClaw: true,
          skipPi: true,
          skipRepair: true,
        },
        jsonRequested: true,
      },
    ]);
  });

  test("preserves empty values, leading dashes, duplicates, and last wins", () => {
    expect(
      prepareLegacySyncArguments([
        "--projects-dir=first",
        "--projects-dir=-last",
        "--codex-home=",
        "--since=2026-01-01",
        "--since=",
        "--dry-run",
        "--dry-run",
      ]),
    ).toEqual(["--projects-dir", ":-last", "--codex-home", ":", "--dry-run"]);
  });

  test("keeps parser, help, and date validation ordering exact", () => {
    expect(prepareLegacySyncArguments(["--help", "--since", "bad"])).toEqual([
      `--${SYNC_INTERNAL_HELP_FLAG}`,
    ]);
    expect(() => prepareLegacySyncArguments(["--help", "--unknown"])).toThrow(
      SyncLegacyParseFailure,
    );
    expect(() => prepareLegacySyncArguments(["--since", "bad"])).toThrow(
      new CLIError("Invalid --since date: bad", "INVALID_FLAG", "selftune sync --since 2026-01-01"),
    );

    try {
      prepareLegacySyncArguments(["--projects-dir", "--force"]);
      throw new Error("expected parse failure");
    } catch (cause) {
      expect(cause).toBeInstanceOf(SyncLegacyParseFailure);
      if (cause instanceof SyncLegacyParseFailure) {
        expect(cause.message).toContain("argument is ambiguous");
      }
    }
  });

  test("help returns normally without invoking sync", async () => {
    const calls: SyncCall[] = [];
    await run(["sync", "--help", "--since", "bad"], recordingAction(calls));
    expect(calls).toEqual([]);
  });

  test("parser and date failures never invoke or load sync", async () => {
    const calls: SyncCall[] = [];
    const action = recordingAction(calls);
    const parserFailure = await Effect.runPromise(
      makeEffectCliTestProgram(["sync", "--unknown"], { syncAction: action }).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );
    const dateFailure = await Effect.runPromise(
      makeEffectCliTestProgram(["sync", "--since", "bad"], { syncAction: action }).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );

    expect(parserFailure).toBeInstanceOf(SyncLegacyParseFailure);
    expect(dateFailure).toMatchObject({ code: "INVALID_FLAG" });
    expect(calls).toEqual([]);
  });

  test("the shared test root fails closed for sync", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["sync"]).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );
    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live sync is disabled in the Effect CLI test program.",
    });
  });

  test("is fully Effect-owned and absent from the legacy operations group", () => {
    expect(isEffectCliInvocation("sync", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("sync");
  });

  test("keeps orchestration runtime values behind one lazy command boundary", () => {
    const commandSource = readFileSync(
      new URL("../../apps/cli/src/effect-cli/commands/sync.ts", import.meta.url),
      "utf8",
    );
    const operationsSource = readFileSync(
      new URL("../../apps/cli/src/commands/operations.ts", import.meta.url),
      "utf8",
    );
    expect(commandSource).not.toMatch(
      /import\s+(?!type\b)[^;]*from\s+["']@selftune\/orchestration\/sync/,
    );
    expect(commandSource).toContain(
      'loadModule: () => import("@selftune/orchestration/sync/programs")',
    );
    expect(commandSource).not.toMatch(/cliMain|liveSourceSyncRunner/);
    expect(operationsSource).not.toContain('case "sync"');
  });
});

describe("sync Effect action boundary", () => {
  test("streams TTY header and progress before core completion", async () => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const stderr: string[] = [];
    const execution = Effect.runPromise(
      runSyncActionWithDependencies(baseInput, false, {
        loadModule: async () =>
          makeRuntimeModule({
            runSyncProgram: () =>
              Effect.gen(function* () {
                const progress = yield* SyncProgress;
                progress.report("selftune sync");
                progress.report("  scanning source...");
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return programResult({ stderr: ["", "Sources:", "Done"] });
              }),
          }),
        writeStdout: () => {},
        writeStderr: (message) => stderr.push(message),
        isTTY: () => true,
        setExitCode: () => {},
      }),
    );

    await Effect.runPromise(Deferred.await(entered));
    expect(stderr).toEqual(["selftune sync", "  scanning source..."]);

    await Effect.runPromise(Deferred.succeed(release, undefined));
    await execution;
    expect(stderr).toEqual(["selftune sync", "  scanning source...", "", "Sources:", "Done"]);
  });

  test("selects JSON from explicit intent or non-TTY and preserves ordered output", async () => {
    const programInputs: SyncProgramInput[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exits: number[] = [];
    let tty = true;
    const dependencies: SyncActionDependencies = {
      loadModule: async () =>
        makeRuntimeModule({
          runSyncProgram: (input) =>
            Effect.sync(() => {
              programInputs.push(input);
              return programResult({
                stdout: ["main-json", "alpha-json"],
                stderr: ["human-one", "", "human-two"],
              });
            }),
        }),
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
      isTTY: () => tty,
      setExitCode: (exitCode) => exits.push(exitCode),
    };

    await Effect.runPromise(runSyncActionWithDependencies(baseInput, false, dependencies));
    tty = false;
    await Effect.runPromise(runSyncActionWithDependencies(baseInput, false, dependencies));
    tty = true;
    await Effect.runPromise(runSyncActionWithDependencies(baseInput, true, dependencies));

    expect(programInputs.map((input) => input.jsonOutput)).toEqual([false, true, true]);
    expect(stdout).toEqual([
      "main-json",
      "alpha-json",
      "main-json",
      "alpha-json",
      "main-json",
      "alpha-json",
    ]);
    expect(stderr).toEqual([
      "human-one",
      "",
      "human-two",
      "human-one",
      "",
      "human-two",
      "human-one",
      "",
      "human-two",
    ]);
    expect(exits).toEqual([0, 0, 0]);
  });

  test("lazy-loads only after execution and maps import and typed runtime failures", async () => {
    let loads = 0;
    const quiet = {
      writeStdout: () => {},
      writeStderr: () => {},
      isTTY: () => true,
      setExitCode: () => {},
    };
    const lazy = runSyncActionWithDependencies(baseInput, false, {
      ...quiet,
      loadModule: async () => {
        loads += 1;
        return makeRuntimeModule();
      },
    });
    expect(loads).toBe(0);
    await Effect.runPromise(lazy);
    expect(loads).toBe(1);

    const importError = await Effect.runPromise(
      runSyncActionWithDependencies(baseInput, false, {
        ...quiet,
        loadModule: async () => Promise.reject(new Error("module missing")),
      }).pipe(Effect.flip),
    );
    expect(importError).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unable to load sync support: module missing",
    });

    const runtimeError = await Effect.runPromise(
      runSyncActionWithDependencies(baseInput, false, {
        ...quiet,
        loadModule: async () =>
          makeRuntimeModule({
            runSyncProgram: () =>
              Effect.fail(
                SyncInternalFailure.make({ operation: "sync", message: "database unavailable" }),
              ),
          }),
      }).pipe(Effect.flip),
    );
    expect(runtimeError).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "database unavailable",
    });
  });

  test("maps TTY, program construction, and output boundary failures", async () => {
    let loads = 0;
    const ttyError = await Effect.runPromise(
      runSyncActionWithDependencies(baseInput, false, {
        loadModule: async () => {
          loads += 1;
          return makeRuntimeModule();
        },
        writeStdout: () => {},
        writeStderr: () => {},
        isTTY: () => {
          throw new Error("tty failed");
        },
        setExitCode: () => {},
      }).pipe(Effect.flip),
    );
    expect(ttyError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Sync failed: tty failed",
    });
    expect(loads).toBe(0);

    const constructionError = await Effect.runPromise(
      runSyncActionWithDependencies(baseInput, false, {
        loadModule: async () =>
          makeRuntimeModule({
            runSyncProgram: () => {
              throw new Error("construction failed");
            },
          }),
        writeStdout: () => {},
        writeStderr: () => {},
        isTTY: () => true,
        setExitCode: () => {},
      }).pipe(Effect.flip),
    );
    expect(constructionError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Sync failed: construction failed",
    });

    const outputError = await Effect.runPromise(
      runSyncActionWithDependencies(baseInput, false, {
        loadModule: async () =>
          makeRuntimeModule({
            runSyncProgram: () => Effect.succeed(programResult({ stdout: ["result"] })),
          }),
        writeStdout: () => {
          throw new Error("stdout failed");
        },
        writeStderr: () => {},
        isTTY: () => true,
        setExitCode: () => {},
      }).pipe(Effect.flip),
    );
    expect(outputError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Sync failed: stdout failed",
    });
  });
});
