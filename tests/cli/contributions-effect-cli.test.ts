import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import {
  makeLiveContributionsCommandActions,
  type ContributionsActionDependencies,
  type ContributionsCommandActions,
} from "../../apps/cli/src/effect-cli/commands/contributions.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import type {
  ContributionsStatusResult,
  ContributionsUploadResult,
} from "../../packages/runtime/contributions.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

function disabled(operation: string) {
  return () => Effect.fail(new CLIError(`unexpected ${operation}`, "INTERNAL_ERROR"));
}

function makeActions(overrides: Partial<ContributionsCommandActions>): ContributionsCommandActions {
  return {
    status: overrides.status ?? disabled("status"),
    preview: overrides.preview ?? disabled("preview"),
    approve: overrides.approve ?? disabled("approve"),
    revoke: overrides.revoke ?? disabled("revoke"),
    setDefault: overrides.setDefault ?? disabled("default"),
    upload: overrides.upload ?? disabled("upload"),
    reset: overrides.reset ?? disabled("reset"),
  };
}

function run(args: ReadonlyArray<string>, contributionsActions: ContributionsCommandActions) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { contributionsActions }).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
}

type ContributionsModule = Awaited<ReturnType<ContributionsActionDependencies["loadModule"]>>;

const unusedRuntimeOperation = () => {
  throw new Error("unused runtime operation");
};

function makeRuntimeModule(overrides: Partial<ContributionsModule> = {}): ContributionsModule {
  return {
    runContributionsStatusProgram: unusedRuntimeOperation,
    formatContributionsStatus: unusedRuntimeOperation,
    runContributionsPreviewProgram: unusedRuntimeOperation,
    formatContributionsPreview: unusedRuntimeOperation,
    runContributionsPreferenceProgram: unusedRuntimeOperation,
    formatContributionsPreference: unusedRuntimeOperation,
    runContributionsDefaultProgram: unusedRuntimeOperation,
    formatContributionsDefault: unusedRuntimeOperation,
    runContributionsUploadProgram: unusedRuntimeOperation,
    formatContributionsUpload: unusedRuntimeOperation,
    runContributionsResetProgram: unusedRuntimeOperation,
    formatContributionsReset: unusedRuntimeOperation,
    ...overrides,
  };
}

describe("Effect CLI contributions command", () => {
  test("dispatches every operation and preserves ignored trailing arguments", async () => {
    const calls: string[] = [];
    const actions = makeActions({
      status: () => Effect.sync(() => calls.push("status")),
      preview: (skill) => Effect.sync(() => calls.push(`preview:${skill}`)),
      approve: (skill) => Effect.sync(() => calls.push(`approve:${skill}`)),
      revoke: (skill) => Effect.sync(() => calls.push(`revoke:${skill}`)),
      setDefault: (value) => Effect.sync(() => calls.push(`default:${value ?? "none"}`)),
      upload: (options) => Effect.sync(() => calls.push(`upload:${JSON.stringify(options)}`)),
      reset: () => Effect.sync(() => calls.push("reset")),
    });

    await run(["contributions"], actions);
    await run(["contributions", "status", "ignored", "--help"], actions);
    await run(["contributions", "preview", "demo", "ignored"], actions);
    await run(["contributions", "approve", "demo", "ignored"], actions);
    await run(["contributions", "revoke", "demo", "ignored"], actions);
    await run(["contributions", "default", "never", "ignored"], actions);
    await run(["contributions", "reset", "ignored"], actions);

    expect(calls).toEqual([
      "status",
      "status",
      "preview:demo",
      "approve:demo",
      "revoke:demo",
      "default:never",
      "reset",
    ]);
  });

  test("preserves positional --help as data for simple leaves", async () => {
    const calls: string[] = [];
    const actions = makeActions({
      preview: (skill) => Effect.sync(() => calls.push(skill)),
      setDefault: (value) => Effect.sync(() => calls.push(value ?? "none")),
    });
    await run(["contributions", "preview", "--help"], actions);
    await run(["contributions", "default"], actions);
    expect(calls).toEqual(["--help", "none"]);
  });

  test("preserves sequential upload parsing and parseInt quirks", async () => {
    const inputs: unknown[] = [];
    const actions = makeActions({
      upload: (options) => Effect.sync(() => inputs.push(options)),
    });
    await run(["contributions", "upload"], actions);
    await run(
      [
        "contributions",
        "upload",
        "--dry-run",
        "--retry-failed",
        "--limit",
        "2x",
        "--limit",
        "1.9",
        "--endpoint",
        "--help",
        "--api-key",
        "key",
      ],
      actions,
    );

    expect(inputs).toEqual([
      {
        dryRun: false,
        retryFailed: false,
        limit: undefined,
        endpoint: undefined,
        apiKey: undefined,
      },
      { dryRun: true, retryFailed: true, limit: 1, endpoint: "--help", apiKey: "key" },
    ]);
  });

  test("upload help short-circuits only when the sequential parser reaches it", async () => {
    const actions = makeActions({});
    await run(["contributions", "upload", "--help", "--bad"], actions);

    const errors = await Promise.all(
      [
        ["contributions", "upload", "--bad", "--help"],
        ["contributions", "upload", "--limit", "--help"],
        ["contributions", "upload", "--limit=2"],
        ["contributions", "upload", "--dry-run=true"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { contributionsActions: actions }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toBeInstanceOf(CLIError));
  });

  test("parent help is first-token fail-open and unknown commands preserve INVALID_FLAG", async () => {
    const actions = makeActions({});
    await run(["contributions", "--help", "--bad"], actions);
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["contributions", "unknown"], {
        contributionsActions: actions,
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );
    expect(error).toMatchObject({
      code: "INVALID_FLAG",
      message: "Unknown contributions subcommand: unknown",
      suggestion: "selftune contributions --help",
    });
  });

  test("test programs fail closed for every operation", async () => {
    const errors = await Promise.all(
      [
        ["contributions"],
        ["contributions", "preview", "demo"],
        ["contributions", "approve", "demo"],
        ["contributions", "revoke", "demo"],
        ["contributions", "default", "ask"],
        ["contributions", "upload"],
        ["contributions", "reset"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args).pipe(Effect.provide(BunServices.layer), Effect.flip),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "INTERNAL_ERROR" }));
  });

  test("live actions lazy-load, preserve plain text, and own upload exit status", async () => {
    const loads: string[] = [];
    const output: string[] = [];
    const exitCodes: number[] = [];
    const statusResult: ContributionsStatusResult = {
      preferences: { version: 1, global_default: "ask", skills: {} },
      discovered: [],
      promptCandidates: [],
      relayStats: { pending: 0, sending: 0, sent: 0, failed: 0 },
      relayEndpoint: "https://example.test",
      stagedCounts: new Map(),
    };
    const uploadResult: ContributionsUploadResult = {
      options: { dryRun: false, retryFailed: false },
      result: {
        endpoint: "https://example.test",
        attempted: 1,
        sent: 0,
        failed: 1,
        requeued: 0,
        retried_failed: 0,
        stats: { pending: 0, sending: 0, sent: 0, failed: 1 },
        dry_run: false,
      },
      exitCode: 1,
    };
    const actions = makeLiveContributionsCommandActions({
      loadModule: async () => {
        loads.push("contributions");
        return {
          runContributionsStatusProgram: () => statusResult,
          formatContributionsStatus: () => "plain status",
          runContributionsPreviewProgram: () => {
            throw new Error("unused");
          },
          formatContributionsPreview: () => "unused",
          runContributionsPreferenceProgram: () => {
            throw new Error("unused");
          },
          formatContributionsPreference: () => "unused",
          runContributionsDefaultProgram: () => {
            throw new Error("unused");
          },
          formatContributionsDefault: () => "unused",
          runContributionsUploadProgram: async () => uploadResult,
          formatContributionsUpload: () => "plain upload",
          runContributionsResetProgram: () => {},
          formatContributionsReset: () => "plain reset",
        };
      },
      print: (message) => output.push(message),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });

    await Effect.runPromise(actions.status());
    await Effect.runPromise(actions.upload({ dryRun: false, retryFailed: false }));
    expect(loads).toEqual(["contributions", "contributions"]);
    expect(output).toEqual(["plain status", "plain upload"]);
    expect(exitCodes).toEqual([0, 1]);
  });

  test("maps import, runtime, formatter, printer, and exit failures while preserving CLIError", async () => {
    const noOutput = { print: () => {}, setExitCode: () => {} };
    const importError = await Effect.runPromise(
      makeLiveContributionsCommandActions({
        ...noOutput,
        loadModule: async () => {
          throw new Error("missing module");
        },
      })
        .status()
        .pipe(Effect.flip),
    );
    expect(importError).toMatchObject({ code: "INTERNAL_ERROR" });

    const sentinel = new CLIError("sentinel", "MISSING_DATA");
    const identity = await Effect.runPromise(
      makeLiveContributionsCommandActions({
        ...noOutput,
        loadModule: async () =>
          makeRuntimeModule({
            runContributionsStatusProgram: () => {
              throw sentinel;
            },
          }),
      })
        .status()
        .pipe(Effect.flip),
    );
    expect(identity).toBe(sentinel);

    const statusResult: ContributionsStatusResult = {
      preferences: { version: 1, global_default: "ask", skills: {} },
      discovered: [],
      promptCandidates: [],
      relayStats: { pending: 0, sending: 0, sent: 0, failed: 0 },
      relayEndpoint: "https://example.test",
      stagedCounts: new Map(),
    };
    const errors = await Promise.all(
      [
        {
          module: makeRuntimeModule({
            runContributionsStatusProgram: () => statusResult,
            formatContributionsStatus: () => {
              throw new Error("format failed");
            },
          }),
          print: () => {},
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({
            runContributionsStatusProgram: () => statusResult,
            formatContributionsStatus: () => "status",
          }),
          print: () => {
            throw new Error("print failed");
          },
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({
            runContributionsStatusProgram: () => statusResult,
            formatContributionsStatus: () => "status",
          }),
          print: () => {},
          setExitCode: () => {
            throw new Error("exit failed");
          },
        },
      ].map((boundary) =>
        Effect.runPromise(
          makeLiveContributionsCommandActions({
            loadModule: async () => boundary.module,
            print: boundary.print,
            setExitCode: boundary.setExitCode,
          })
            .status()
            .pipe(Effect.flip),
        ),
      ),
    );
    errors.forEach((error) =>
      expect(error).toMatchObject({
        code: "OPERATION_FAILED",
        message: expect.stringContaining("Contributions status failed:"),
      }),
    );
  });

  test("is Effect-owned, absent from legacy routing, and owns its lazy module", () => {
    expect(isEffectCliInvocation("contributions", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("contributions");
    const source = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/effect-cli/commands/contributions.ts"),
      "utf8",
    );
    expect(source).toContain('import("@selftune/runtime/contributions")');
    expect(source).not.toMatch(/\bcliMain\b|process\.argv|process\.exit\s*\(/);
    expect(source).not.toMatch(/Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/);
  });
});
