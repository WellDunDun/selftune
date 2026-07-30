import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import {
  runLibraryActionWithDependencies,
  type LibraryAction,
  type LibraryActionDependencies,
} from "../../apps/cli/src/effect-cli/commands/library.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import {
  formatLibraryResult,
  runLibraryProgram,
  type LibraryProgramInput,
  type LibraryProgramResult,
} from "../../packages/runtime/library/programs.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

function run(args: ReadonlyArray<string>, libraryAction: LibraryAction) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { libraryAction }).pipe(Effect.provide(BunServices.layer)),
  );
}

function recordingAction(calls: LibraryProgramInput[]): LibraryAction {
  return (input) => Effect.sync(() => calls.push(input));
}

type LibraryModule = Awaited<ReturnType<LibraryActionDependencies["loadModule"]>>;

function makeRuntimeModule(overrides: Partial<LibraryModule> = {}): LibraryModule {
  return {
    runLibraryProgram: (input) =>
      Effect.succeed({
        operation: input.operation,
        value: { operation: input.operation },
        text: JSON.stringify({ operation: input.operation }, null, 2),
      }),
    formatLibraryResult,
    ...overrides,
  };
}

describe("Effect CLI library command", () => {
  test("dispatches both defaults and all fourteen typed leaves", async () => {
    const calls: LibraryProgramInput[] = [];
    const action = recordingAction(calls);

    await run(["library"], action);
    await run(["library", "list"], action);
    await run(
      ["library", "configure", "--url=https://library.example", "--api-key", "device-key"],
      action,
    );
    await run(["library", "preview"], action);
    await run(["library", "sync"], action);
    await run(["library", "status"], action);
    await run(["library", "diagnostics"], action);
    await run(["library", "export", "--output", "backup.json"], action);
    await run(["library", "restore", "--target", "/tmp/clean"], action);
    await run(["library", "synthesize"], action);
    await run(["library", "synthesize", "scan"], action);
    await run(["library", "synthesize", "list"], action);
    await run(
      [
        "library",
        "synthesize",
        "review",
        "--candidate-id",
        "candidate-1",
        "--action",
        "snooze",
        "--reason",
        "later",
        "--snooze-until",
        "tomorrow",
        "--title",
        "Edited title",
        "--summary",
        "Edited summary",
      ],
      action,
    );
    await run(
      ["library", "synthesize", "draft", "--candidate-id", "candidate-2", "--output-dir", "out"],
      action,
    );
    await run(["library", "synthesize", "evaluate", "--candidate-id", "candidate-3"], action);
    await run(["library", "synthesize", "release", "--candidate-id", "candidate-4"], action);

    expect(calls).toEqual([
      { operation: "list" },
      { operation: "list" },
      { operation: "configure", url: "https://library.example", apiKey: "device-key" },
      { operation: "preview" },
      { operation: "sync" },
      { operation: "status" },
      { operation: "diagnostics" },
      { operation: "export", output: "backup.json" },
      { operation: "restore", target: "/tmp/clean" },
      { operation: "synthesize.list" },
      { operation: "synthesize.scan" },
      { operation: "synthesize.list" },
      {
        operation: "synthesize.review",
        candidateId: "candidate-1",
        action: "snooze",
        reason: "later",
        snoozedUntil: "tomorrow",
        title: "Edited title",
        summary: "Edited summary",
      },
      { operation: "synthesize.draft", candidateId: "candidate-2", outputDir: "out" },
      { operation: "synthesize.evaluate", candidateId: "candidate-3" },
      { operation: "synthesize.release", candidateId: "candidate-4" },
    ]);
  });

  test("preserves global option tolerance, last wins, sentinels, and ignored positionals", async () => {
    const calls: LibraryProgramInput[] = [];
    const action = recordingAction(calls);

    await run(["library", "preview", "ignored", "--url", "unused"], action);
    await run(
      [
        "library",
        "configure",
        "--url=first",
        "--url=",
        "--api-key=first",
        "--api-key=-secret=value",
        "ignored",
      ],
      action,
    );
    await run(["library", "list", "--", "--unknown", "ignored"], action);

    expect(calls).toEqual([
      { operation: "preview" },
      { operation: "configure", url: "", apiKey: "-secret=value" },
      { operation: "list" },
    ]);
  });

  test("keeps universal help strict and rejects unknown commands with legacy identity", async () => {
    const calls: LibraryProgramInput[] = [];
    const action = recordingAction(calls);

    await run(["library", "--help", "ignored"], action);
    await run(["library", "synthesize", "review", "-hh", "ignored"], action);
    expect(calls).toEqual([]);

    const errors = await Promise.all(
      [
        ["library", "--help", "--unknown"],
        ["library", "unknown"],
        ["library", "synthesize", "unknown"],
        ["library", "synthesize", "unknown", "--candidate-id", "candidate"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { libraryAction: action }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    expect(errors[0]).toMatchObject({ code: "INVALID_FLAG" });
    expect(errors[1]).toMatchObject({
      code: "INVALID_FLAG",
      message: "Unknown library command: unknown",
    });
    expect(errors[2]).toMatchObject({
      code: "MISSING_FLAG",
      message: "--candidate-id is required.",
    });
    expect(errors[3]).toMatchObject({
      code: "INVALID_FLAG",
      message: "Unknown synthesize action: unknown",
    });
  });

  test("shared test programs fail closed for every operation", async () => {
    const commands: ReadonlyArray<ReadonlyArray<string>> = [
      ["library", "list"],
      ["library", "configure"],
      ["library", "preview"],
      ["library", "sync"],
      ["library", "status"],
      ["library", "diagnostics"],
      ["library", "export"],
      ["library", "restore"],
      ["library", "synthesize", "scan"],
      ["library", "synthesize", "list"],
      ["library", "synthesize", "review"],
      ["library", "synthesize", "draft"],
      ["library", "synthesize", "evaluate"],
      ["library", "synthesize", "release"],
    ];
    const errors = await Promise.all(
      commands.map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args).pipe(Effect.provide(BunServices.layer), Effect.flip),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "INTERNAL_ERROR" }));
  });

  test("live action lazy-loads, awaits the Effect program, and owns output and exit", async () => {
    const events: string[] = [];
    const action = runLibraryActionWithDependencies(
      { operation: "status" },
      {
        loadModule: async () => {
          events.push("load");
          return makeRuntimeModule({
            runLibraryProgram: () =>
              Effect.sync(() => {
                events.push("program-complete");
                return {
                  operation: "status",
                  value: { connected: true },
                  text: '{\n  "connected": true\n}',
                };
              }),
          });
        },
        print: (message) => events.push(`print:${message}`),
        setExitCode: (exitCode) => events.push(`exit:${exitCode}`),
      },
    );

    expect(events).toEqual([]);
    await Effect.runPromise(action);
    expect(events).toEqual([
      "load",
      "program-complete",
      'print:{\n  "connected": true\n}',
      "exit:0",
    ]);
  });

  test("maps boundary failures and preserves typed runtime failures", async () => {
    const input: LibraryProgramInput = { operation: "list" };
    const quiet = { print: () => {}, setExitCode: () => {} };
    const importError = await Effect.runPromise(
      runLibraryActionWithDependencies(input, {
        ...quiet,
        loadModule: async () => {
          throw new Error("missing module");
        },
      }).pipe(Effect.flip),
    );
    expect(importError).toMatchObject({ code: "INTERNAL_ERROR" });

    const sentinel = new CLIError("sentinel", "GUARD_BLOCKED", undefined, 2);
    const identity = await Effect.runPromise(
      runLibraryActionWithDependencies(input, {
        ...quiet,
        loadModule: async () =>
          makeRuntimeModule({ runLibraryProgram: () => Effect.fail(sentinel) }),
      }).pipe(Effect.flip),
    );
    expect(identity).toBe(sentinel);

    const result: LibraryProgramResult = { operation: "list", value: [], text: "[]" };
    const errors = await Promise.all(
      [
        {
          module: makeRuntimeModule({
            runLibraryProgram: () =>
              Effect.fail(new CLIError("program failed", "OPERATION_FAILED")),
          }),
          print: () => {},
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({
            runLibraryProgram: () => Effect.succeed(result),
            formatLibraryResult: () => {
              throw new Error("format failed");
            },
          }),
          print: () => {},
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({ runLibraryProgram: () => Effect.succeed(result) }),
          print: () => {
            throw new Error("print failed");
          },
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({ runLibraryProgram: () => Effect.succeed(result) }),
          print: () => {},
          setExitCode: () => {
            throw new Error("exit failed");
          },
        },
      ].map((boundary) =>
        Effect.runPromise(
          runLibraryActionWithDependencies(input, {
            loadModule: async () => boundary.module,
            print: boundary.print,
            setExitCode: boundary.setExitCode,
          }).pipe(Effect.flip),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "OPERATION_FAILED" }));
  });

  test("runtime validation is typed and ordered before remote acquisition", async () => {
    const missingUrl = await Effect.runPromise(
      runLibraryProgram({ operation: "configure", apiKey: "key" }).pipe(Effect.flip),
    );
    expect(missingUrl).toMatchObject({ code: "MISSING_FLAG", message: "--url is required." });

    const missingOutput = await Effect.runPromise(
      runLibraryProgram({ operation: "export" }).pipe(Effect.flip),
    );
    expect(missingOutput).toMatchObject({
      code: "MISSING_FLAG",
      message: "--output is required.",
    });

    const review = await Effect.runPromise(
      runLibraryProgram({ operation: "synthesize.review", action: "invalid" }).pipe(Effect.flip),
    );
    expect(review).toMatchObject({
      code: "MISSING_FLAG",
      message: "--candidate-id is required.",
    });

    const result: LibraryProgramResult = { operation: "list", value: { ok: true }, text: "x" };
    expect(formatLibraryResult(result)).toBe("x");
  });

  test("is Effect-owned and keeps remote work in the single Effect runtime", () => {
    expect(isEffectCliInvocation("library", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("library");

    const commandSource = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/effect-cli/commands/library.ts"),
      "utf8",
    );
    expect(commandSource).toContain('import("@selftune/runtime/library/programs")');
    expect(commandSource).not.toMatch(/\bcliMain\b|process\.argv|process\.exit\s*\(/);
    expect(commandSource).not.toMatch(/Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/);

    const runtimeSource = readFileSync(
      join(import.meta.dir, "../../packages/runtime/library/programs.ts"),
      "utf8",
    );
    expect(runtimeSource).toContain("RemoteLibraryHttp");
    expect(runtimeSource).not.toMatch(/createRemoteLibraryHandle|remote\/transport|ManagedRuntime/);
    expect(runtimeSource).not.toMatch(
      /Effect\.(?:runPromise|runSync|runFork)\b|process\.|console\./,
    );
    for (const relativePath of [
      "../../packages/library/src/remote/effect-sync.ts",
      "../../packages/runtime/remote-library/effect-sync.ts",
      "../../packages/runtime/remote-library/effect-pull.ts",
      "../../packages/runtime/remote-library/effect-restore.ts",
    ]) {
      const source = readFileSync(join(import.meta.dir, relativePath), "utf8");
      expect(source).not.toMatch(
        /createRemoteLibraryHandle|RemoteLibraryHandle|ManagedRuntime|Effect\.(?:runPromise|runSync|runFork)\b/,
      );
    }
    expect(existsSync(join(import.meta.dir, "../../packages/runtime/library-cli.ts"))).toBe(false);
  });
});
