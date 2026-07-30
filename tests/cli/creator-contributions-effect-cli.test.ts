import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import {
  makeLiveCreatorContributionsCommandActions,
  type CreatorContributionsActionDependencies,
  type CreatorContributionsCommandActions,
} from "../../apps/cli/src/effect-cli/commands/creator-contributions.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import type {
  CreatorContributionsDisableResult,
  CreatorContributionsEnableResult,
  CreatorContributionsStatusResult,
  RunCreatorContributionsEnableOptions,
} from "../../packages/runtime/creator-contributions.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

function disabled(operation: string) {
  return () => Effect.fail(new CLIError(`unexpected ${operation}`, "INTERNAL_ERROR"));
}

function makeActions(
  overrides: Partial<CreatorContributionsCommandActions>,
): CreatorContributionsCommandActions {
  return {
    status: overrides.status ?? disabled("status"),
    enable: overrides.enable ?? disabled("enable"),
    disable: overrides.disable ?? disabled("disable"),
  };
}

function run(
  args: ReadonlyArray<string>,
  creatorContributionsActions: CreatorContributionsCommandActions,
) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { creatorContributionsActions }).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
}

type CreatorContributionsModule = Awaited<
  ReturnType<CreatorContributionsActionDependencies["loadModule"]>
>;

const unusedRuntimeOperation = () => {
  throw new Error("unused runtime operation");
};

function makeRuntimeModule(
  overrides: Partial<CreatorContributionsModule> = {},
): CreatorContributionsModule {
  return {
    runCreatorContributionsStatusProgram: unusedRuntimeOperation,
    formatCreatorContributionsStatus: unusedRuntimeOperation,
    runCreatorContributionsEnableProgram: unusedRuntimeOperation,
    formatCreatorContributionsEnable: unusedRuntimeOperation,
    runCreatorContributionsDisableProgram: unusedRuntimeOperation,
    formatCreatorContributionsDisable: unusedRuntimeOperation,
    ...overrides,
  };
}

const statusResult: CreatorContributionsStatusResult = {
  mode: "named",
  skillName: "demo",
  config: null,
};

const enableResult: CreatorContributionsEnableResult = {
  all: false,
  skillName: "demo",
  outcome: { written: ["demo"], helpers: [], skipped: [] },
  configs: [],
};

const disableResult: CreatorContributionsDisableResult = {
  skillName: "demo",
  removed: true,
  helperRemoved: [],
};

describe("Effect CLI creator-contributions command", () => {
  test("dispatches status defaults and all typed enable and disable options", async () => {
    const calls: unknown[] = [];
    const actions = makeActions({
      status: (skill) => Effect.sync(() => calls.push(["status", skill])),
      enable: (options) => Effect.sync(() => calls.push(["enable", options])),
      disable: (skill, skillPath) => Effect.sync(() => calls.push(["disable", skill, skillPath])),
    });

    await run(["creator-contributions"], actions);
    await run(["creator-contributions", "status", "--skill", "demo"], actions);
    await run(
      [
        "creator-contributions",
        "enable",
        "--skill",
        "demo",
        "--all",
        "--prefix",
        "team-",
        "--skill-path",
        "/tmp/SKILL.md",
        "--creator-id",
        "creator",
        "--signals",
        "trigger,grade",
        "--message",
        "share",
        "--privacy-url",
        "https://example.test/privacy",
        "--feedback-endpoint",
        "https://example.test/feedback",
        "--no-helper",
      ],
      actions,
    );
    await run(
      ["creator-contributions", "disable", "--skill", "demo", "--skill-path", "/tmp/SKILL.md"],
      actions,
    );

    expect(calls).toEqual([
      ["status", undefined],
      ["status", "demo"],
      [
        "enable",
        {
          skillName: "demo",
          all: true,
          prefix: "team-",
          explicitSkillPath: "/tmp/SKILL.md",
          explicitCreatorId: "creator",
          signals: "trigger,grade",
          message: "share",
          privacyUrl: "https://example.test/privacy",
          helper: false,
          feedbackEndpoint: "https://example.test/feedback",
        },
      ],
      ["disable", "demo", "/tmp/SKILL.md"],
    ]);
  });

  test("preserves defaults, repeated values, empty values, leading dashes, and equals", async () => {
    const inputs: RunCreatorContributionsEnableOptions[] = [];
    const actions = makeActions({
      enable: (options) => Effect.sync(() => inputs.push(options)),
    });

    await run(["creator-contributions", "enable", "--skill", "demo"], actions);
    await run(
      [
        "creator-contributions",
        "enable",
        "--skill",
        "first",
        "--skill=",
        "--prefix=-team",
        "--message=a=b=c",
      ],
      actions,
    );

    expect(inputs).toEqual([
      {
        skillName: "demo",
        all: false,
        prefix: undefined,
        explicitSkillPath: undefined,
        explicitCreatorId: undefined,
        signals: "trigger,grade,miss_category",
        message: undefined,
        privacyUrl: undefined,
        helper: true,
        feedbackEndpoint: undefined,
      },
      {
        skillName: "",
        all: false,
        prefix: "-team",
        explicitSkillPath: undefined,
        explicitCreatorId: undefined,
        signals: "trigger,grade,miss_category",
        message: "a=b=c",
        privacyUrl: undefined,
        helper: true,
        feedbackEndpoint: undefined,
      },
    ]);
  });

  test("keeps parent help fail-open and leaf help strict", async () => {
    const actions = makeActions({});
    await run(["creator-contributions", "--help", "--bogus"], actions);
    await run(["creator-contributions", "enable", "-hh"], actions);

    const errors = await Promise.all(
      [
        ["creator-contributions", "enable", "--help", "--bogus"],
        ["creator-contributions", "status", "positional"],
        ["creator-contributions", "enable", "--all=true"],
        ["creator-contributions", "enable", "--skill"],
        ["creator-contributions", "disable", "--unknown"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { creatorContributionsActions: actions }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "INVALID_FLAG" }));
  });

  test("preserves unknown-subcommand error identity", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["creator-contributions", "unknown"], {
        creatorContributionsActions: makeActions({}),
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );
    expect(error).toMatchObject({
      code: "UNKNOWN_COMMAND",
      message: "Unknown creator-contributions subcommand: unknown",
      suggestion: "selftune creator-contributions --help",
    });
  });

  test("test programs fail closed for every operation", async () => {
    const errors = await Promise.all(
      [
        ["creator-contributions"],
        ["creator-contributions", "status"],
        ["creator-contributions", "enable", "--skill", "demo"],
        ["creator-contributions", "disable", "--skill", "demo"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args).pipe(Effect.provide(BunServices.layer), Effect.flip),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "INTERNAL_ERROR" }));
  });

  test("live actions lazy-load, print plain text, and own successful exit status", async () => {
    const loads: string[] = [];
    const output: string[] = [];
    const exitCodes: number[] = [];
    const actions = makeLiveCreatorContributionsCommandActions({
      loadModule: async () => {
        loads.push("creator-contributions");
        return makeRuntimeModule({
          runCreatorContributionsStatusProgram: () => statusResult,
          formatCreatorContributionsStatus: () => "plain status",
          runCreatorContributionsEnableProgram: () => enableResult,
          formatCreatorContributionsEnable: () => "plain enable",
          runCreatorContributionsDisableProgram: () => disableResult,
          formatCreatorContributionsDisable: () => "plain disable",
        });
      },
      print: (message) => output.push(message),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });

    await Effect.runPromise(actions.status("demo"));
    await Effect.runPromise(actions.enable({ skillName: "demo" }));
    await Effect.runPromise(actions.disable("demo"));
    expect(loads).toEqual([
      "creator-contributions",
      "creator-contributions",
      "creator-contributions",
    ]);
    expect(output).toEqual(["plain status", "plain enable", "plain disable"]);
    expect(exitCodes).toEqual([0, 0, 0]);
  });

  test("maps import, runtime, formatter, printer, and exit failures while preserving CLIError", async () => {
    const noOutput = { print: () => {}, setExitCode: () => {} };
    const importError = await Effect.runPromise(
      makeLiveCreatorContributionsCommandActions({
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
      makeLiveCreatorContributionsCommandActions({
        ...noOutput,
        loadModule: async () =>
          makeRuntimeModule({
            runCreatorContributionsStatusProgram: () => {
              throw sentinel;
            },
          }),
      })
        .status()
        .pipe(Effect.flip),
    );
    expect(identity).toBe(sentinel);

    const errors = await Promise.all(
      [
        {
          module: makeRuntimeModule({
            runCreatorContributionsStatusProgram: () => statusResult,
            formatCreatorContributionsStatus: () => {
              throw new Error("format failed");
            },
          }),
          print: () => {},
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({
            runCreatorContributionsStatusProgram: () => statusResult,
            formatCreatorContributionsStatus: () => "status",
          }),
          print: () => {
            throw new Error("print failed");
          },
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({
            runCreatorContributionsStatusProgram: () => statusResult,
            formatCreatorContributionsStatus: () => "status",
          }),
          print: () => {},
          setExitCode: () => {
            throw new Error("exit failed");
          },
        },
      ].map((boundary) =>
        Effect.runPromise(
          makeLiveCreatorContributionsCommandActions({
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
        message: expect.stringContaining("Creator contributions status failed:"),
      }),
    );
  });

  test("is Effect-owned, absent from legacy routing, and owns its lazy module", () => {
    expect(isEffectCliInvocation("creator-contributions", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("creator-contributions");
    const source = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/effect-cli/commands/creator-contributions.ts"),
      "utf8",
    );
    expect(source).toContain('import("@selftune/runtime/creator-contributions")');
    expect(source).not.toMatch(/\bcliMain\b|process\.argv|process\.exit\s*\(/);
    expect(source).not.toMatch(/Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/);
  });
});
