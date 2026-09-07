import { afterEach, describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { CreateCommandActions } from "../../apps/cli/src/effect-cli/commands/create.js";
import {
  createExitCode,
  makeLiveCreateCommandActions,
  writeCreateActionResult,
} from "../../apps/cli/src/effect-cli/commands/create/actions.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const temporaryRoots: string[] = [];

async function failLoad(): Promise<never> {
  throw new Error("wrong create leaf loaded");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function disabled(action: keyof CreateCommandActions) {
  return () => Effect.fail(new CLIError(`Unexpected create ${action} call`, "INTERNAL_ERROR"));
}

function makeActions(overrides: Partial<CreateCommandActions>): CreateCommandActions {
  return {
    init: overrides.init ?? disabled("init"),
    status: overrides.status ?? disabled("status"),
    scaffold: overrides.scaffold ?? disabled("scaffold"),
    check: overrides.check ?? disabled("check"),
    replay: overrides.replay ?? disabled("replay"),
    baseline: overrides.baseline ?? disabled("baseline"),
    report: overrides.report ?? disabled("report"),
    publish: overrides.publish ?? disabled("publish"),
  };
}

function run(args: ReadonlyArray<string>, actions: CreateCommandActions) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { createActions: actions }).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
}

describe("Effect CLI create command family", () => {
  test("dispatches all eight leaves with typed inputs", async () => {
    const calls: string[] = [];
    const actions = makeActions({
      init: (input) => Effect.sync(() => calls.push(`init:${input.name}:${input.force}`)),
      status: (input) => Effect.sync(() => calls.push(`status:${input.skillPath}`)),
      scaffold: (input) =>
        Effect.sync(() => calls.push(`scaffold:${input.fromWorkflow}:${input.write}`)),
      check: (input) => Effect.sync(() => calls.push(`check:${input.skillPath}`)),
      replay: (input) => Effect.sync(() => calls.push(`replay:${input.mode}:${input.agent}`)),
      baseline: (input) => Effect.sync(() => calls.push(`baseline:${input.mode}`)),
      report: (input) => Effect.sync(() => calls.push(`report:${input.evalSetPath}`)),
      publish: (input) => Effect.sync(() => calls.push(`publish:${input.watch}`)),
    });

    await run(["create", "init", "--name", "alpha", "--description", "draft", "--force"], actions);
    await run(["create", "status", "--skill-path", "/tmp/a"], actions);
    await run(["create", "scaffold", "--from-workflow", "wf-1", "--write"], actions);
    await run(["create", "check", "--skill-path", "/tmp/b"], actions);
    await run(["create", "replay", "--mode", "package", "--agent", "codex"], actions);
    await run(["create", "baseline", "--mode", "routing"], actions);
    await run(["create", "report", "--eval-set", "/tmp/evals.json"], actions);
    await run(["create", "publish", "--watch"], actions);

    expect(calls).toEqual([
      "init:alpha:true",
      "status:/tmp/a",
      "scaffold:wf-1:true",
      "check:/tmp/b",
      "replay:package:codex",
      "baseline:routing",
      "report:/tmp/evals.json",
      "publish:true",
    ]);
  });

  test("preserves parseArgs repeated, empty, leading-dash, and clustered-help behavior", async () => {
    const inputs: string[] = [];
    const actions = makeActions({
      init: (input) =>
        Effect.sync(() => inputs.push(`${input.name}|${input.description}|${input.outputDir}`)),
    });

    await run(
      [
        "create",
        "init",
        "--name",
        "first",
        "--name=second",
        "--description=-draft",
        "--output-dir=",
      ],
      actions,
    );
    await run(["create", "init", "-hh"], actions);

    expect(inputs).toEqual(["second|-draft|"]);
  });

  test("keeps parent help fail-open and leaf help strict", async () => {
    const actions = makeActions({});
    await run(["create"], actions);
    await run(["create", "--help", "--bogus"], actions);

    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["create", "init", "--help", "--bogus"], {
        createActions: actions,
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );
    expect(error).toMatchObject({ code: "INVALID_FLAG" });
  });

  test("is fully Effect-owned and removed from the legacy lifecycle group", () => {
    expect(isEffectCliInvocation("create", [])).toBe(true);
    expect(isEffectCliInvocation("create", ["init", "--help"])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.lifecycle).not.toContain("create");
  });

  test("test programs fail closed for every create leaf", async () => {
    const actions = [
      "init",
      "status",
      "scaffold",
      "check",
      "replay",
      "baseline",
      "report",
      "publish",
    ] as const;
    const errors = await Promise.all(
      actions.map((action) =>
        Effect.runPromise(
          makeEffectCliTestProgram(["create", action]).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );

    errors.forEach((error, index) => {
      expect(error).toMatchObject({
        code: "INTERNAL_ERROR",
        message: `Live create ${actions[index]} is disabled in the Effect CLI test program.`,
      });
    });
  });

  test("live actions lazy-load only the selected runtime leaf", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-effect-"));
    temporaryRoots.push(root);
    const loads: string[] = [];
    const output: string[] = [];
    const exitCodes: number[] = [];
    const actions = makeLiveCreateCommandActions({
      loadInit: async () => {
        loads.push("init");
        return import("../../packages/runtime/create/init.js");
      },
      loadStatus: failLoad,
      loadScaffold: failLoad,
      loadCheck: failLoad,
      loadReplay: failLoad,
      loadBaseline: failLoad,
      loadReport: failLoad,
      loadPublish: failLoad,
      output: {
        isStdoutTTY: () => false,
        print: (value) => output.push(value),
        setExitCode: (code) => exitCodes.push(code),
      },
    });

    await Effect.runPromise(
      actions.init({
        name: "lazy-create",
        description: "A lazy create action",
        outputDir: root,
        force: false,
        json: false,
      }),
    );

    expect(loads).toEqual(["init"]);
    expect(JSON.parse(output[0]!)).toMatchObject({ skill_name: "lazy-create" });
    expect(exitCodes).toEqual([0]);
  });

  test("maps every leaf import failure without loading another leaf", async () => {
    const actions = makeLiveCreateCommandActions({
      loadInit: failLoad,
      loadStatus: failLoad,
      loadScaffold: failLoad,
      loadCheck: failLoad,
      loadReplay: failLoad,
      loadBaseline: failLoad,
      loadReport: failLoad,
      loadPublish: failLoad,
      output: { isStdoutTTY: () => true, print: () => {}, setExitCode: () => {} },
    });
    const invocations = [
      actions.init({ name: "x", description: "x", force: false, json: false }),
      actions.status({ json: false }),
      actions.scaffold({ write: false, force: false, json: false }),
      actions.check({ json: false }),
      actions.replay({ mode: "routing", json: false }),
      actions.baseline({ mode: "routing", json: false }),
      actions.report({ json: false }),
      actions.publish({ watch: false, ignoreWatchAlerts: false, json: false }),
    ];
    const names = [
      "init",
      "status",
      "scaffold",
      "check",
      "replay",
      "baseline",
      "report",
      "publish",
    ];
    const errors = await Promise.all(
      invocations.map((invocation) => Effect.runPromise(invocation.pipe(Effect.flip))),
    );
    errors.forEach((error, index) => {
      expect(error).toMatchObject({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining(`create ${names[index]} support`),
      });
    });
  });

  test("preserves CLIError identity from a loaded leaf", async () => {
    const sentinel = new CLIError("sentinel", "MISSING_DATA", "selftune create init --help");
    const actions = makeLiveCreateCommandActions({
      loadInit: async () => ({
        runCreateInit: () => {
          throw sentinel;
        },
        formatInitResult: () => "unused",
      }),
      loadStatus: failLoad,
      loadScaffold: failLoad,
      loadCheck: failLoad,
      loadReplay: failLoad,
      loadBaseline: failLoad,
      loadReport: failLoad,
      loadPublish: failLoad,
      output: { isStdoutTTY: () => true, print: () => {}, setExitCode: () => {} },
    });
    const error = await Effect.runPromise(
      actions.init({ name: "x", description: "x", force: false, json: false }).pipe(Effect.flip),
    );
    expect(error).toBe(sentinel);
  });

  test("owns every leaf exit predicate and TTY/JSON output decision", async () => {
    expect([
      createExitCode.status(),
      createExitCode.check(true),
      createExitCode.check(false),
      createExitCode.replay(0),
      createExitCode.replay(1),
      createExitCode.baseline(true),
      createExitCode.baseline(false),
      createExitCode.report(true),
      createExitCode.report(false),
      createExitCode.publish(true),
      createExitCode.publish(false),
    ]).toEqual([0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);

    const printed: string[] = [];
    const exitCodes: number[] = [];
    const output = {
      isStdoutTTY: () => true,
      print: (value: string) => printed.push(value),
      setExitCode: (code: number) => exitCodes.push(code),
    };
    await Effect.runPromise(
      writeCreateActionResult(
        "status",
        output,
        false,
        () => {
          throw new Error("JSON must remain lazy on a TTY");
        },
        () => "TTY",
        0,
      ),
    );
    await Effect.runPromise(
      writeCreateActionResult(
        "check",
        output,
        true,
        () => JSON.stringify({ ok: false }, null, 2),
        () => "unused",
        1,
      ),
    );
    await Effect.runPromise(
      writeCreateActionResult(
        "replay",
        { ...output, isStdoutTTY: () => false },
        false,
        () => JSON.stringify({ failed: 2 }, null, 2),
        () => "unused",
        1,
      ),
    );
    expect(printed).toEqual(["TTY", '{\n  "ok": false\n}', '{\n  "failed": 2\n}']);
    expect(exitCodes).toEqual([0, 1, 1]);

    const outputErrors = await Promise.all(
      [
        {
          ...output,
          print: () => {
            throw new Error("print failed");
          },
        },
        {
          ...output,
          setExitCode: () => {
            throw new Error("exit failed");
          },
        },
      ].map((failingOutput) =>
        Effect.runPromise(
          writeCreateActionResult(
            "publish",
            failingOutput,
            false,
            () => "{}",
            () => "value",
            0,
          ).pipe(Effect.flip),
        ),
      ),
    );
    outputErrors.forEach((error) => {
      expect(error).toMatchObject({
        code: "OPERATION_FAILED",
        suggestion: "selftune create publish --help",
      });
    });
    const formatError = await Effect.runPromise(
      writeCreateActionResult(
        "report",
        output,
        false,
        () => "{}",
        () => {
          throw new Error("format failed");
        },
        0,
      ).pipe(Effect.flip),
    );
    expect(formatError).toMatchObject({
      code: "OPERATION_FAILED",
      suggestion: "selftune create report --help",
    });
    const jsonError = await Effect.runPromise(
      writeCreateActionResult(
        "scaffold",
        output,
        true,
        () => {
          throw new Error("JSON encoding failed");
        },
        () => "unused",
        0,
      ).pipe(Effect.flip),
    );
    expect(jsonError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "JSON encoding failed",
      suggestion: "selftune create scaffold --help",
    });
  });

  test("rejects unknown subcommands and malformed leaf grammar before actions", async () => {
    const actions = makeActions({});
    const errors = await Promise.all(
      [
        ["create", "unknown"],
        ["create", "init", "positional"],
        ["create", "init", "--force=true"],
        ["create", "publish", "--no-watch"],
        ["create", "replay", "--mode"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { createActions: actions }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toBeInstanceOf(CLIError));
  });

  test("keeps leaf ownership local and free of legacy runtime boundaries", () => {
    const sourceRoot = join(import.meta.dir, "../../apps/cli/src/effect-cli/commands");
    const actionSource = readFileSync(join(sourceRoot, "create/actions.ts"), "utf8");
    const commandSources = [
      readFileSync(join(sourceRoot, "create.ts"), "utf8"),
      actionSource,
      readFileSync(join(sourceRoot, "create/scaffolding.ts"), "utf8"),
      readFileSync(join(sourceRoot, "create/evaluation.ts"), "utf8"),
      readFileSync(join(sourceRoot, "create/publish.ts"), "utf8"),
    ].join("\n");

    for (const leaf of [
      "init",
      "status",
      "scaffold",
      "check",
      "replay",
      "baseline",
      "report",
      "publish",
    ]) {
      expect(actionSource).toContain(`import("@selftune/runtime/create/${leaf}")`);
    }
    expect(commandSources).not.toMatch(/\bcliMain\b|process\.argv|process\.exit\s*\(/);
    expect(commandSources).not.toMatch(/Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/);
  });
});
