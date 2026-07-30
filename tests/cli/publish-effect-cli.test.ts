import { afterEach, describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  runPublishActionWithDependencies,
  type PublishAction,
  type PublishInput,
} from "../../apps/cli/src/effect-cli/commands/publish.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import type {
  CreatePublishResult,
  RunCreatePublishOptions,
} from "../../packages/runtime/create/publish.js";
import { runPublish, type RunPublishOptions } from "../../packages/runtime/publish.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makePublishResult(published: boolean): CreatePublishResult {
  return {
    skill: "demo",
    skill_path: "/tmp/demo/SKILL.md",
    published,
    watch_started: published,
    watch_gate_blocked: false,
    next_command: null,
    package_evaluation: null,
    replay_exit_code: 0,
    baseline_exit_code: 0,
    watch_exit_code: 0,
    watch_result: null,
    watch_stdout: "",
    watch_stderr: "",
    watch_gate_passed: null,
    watch_gate_warnings: [],
    watch_trust_score: null,
    watch_gate_bypassed: false,
  };
}

function run(args: ReadonlyArray<string>, publishAction: PublishAction) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { publishAction }).pipe(Effect.provide(BunServices.layer)),
  );
}

async function runEntrypoint(args: ReadonlyArray<string>) {
  const root = mkdtempSync(join(tmpdir(), "selftune-publish-effect-"));
  temporaryRoots.push(root);
  const child = Bun.spawn([process.execPath, "run", CLI_ENTRYPOINT, ...args], {
    env: {
      ...process.env,
      HOME: root,
      SELFTUNE_CONFIG_DIR: join(root, ".selftune"),
      SELFTUNE_NO_ANALYTICS: "1",
      SELFTUNE_SKIP_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { root, stdout, stderr, exitCode };
}

describe("Effect CLI publish command", () => {
  test("preserves default, opt-out, and hidden explicit watch semantics", async () => {
    const inputs: PublishInput[] = [];
    const action: PublishAction = (input) => Effect.sync(() => inputs.push(input));

    await run(["publish", "--skill-path", "/tmp/default"], action);
    await run(["publish", "--skill-path", "/tmp/manual", "--no-watch"], action);
    await run(["publish", "--skill-path", "/tmp/explicit", "--watch"], action);
    await run(["publish", "--no-watch", "--no-watch"], action);

    expect(inputs.map(({ skillPath, watch }) => ({ skillPath, watch }))).toEqual([
      { skillPath: "/tmp/default", watch: true },
      { skillPath: "/tmp/manual", watch: false },
      { skillPath: "/tmp/explicit", watch: true },
      { skillPath: "", watch: false },
    ]);
  });

  test("preserves parseArgs repeated, empty, leading-dash, and clustered-help behavior", async () => {
    const inputs: PublishInput[] = [];
    const action: PublishAction = (input) => Effect.sync(() => inputs.push(input));
    await run(
      ["publish", "--skill-path", "first", "--skill-path=", "--ignore-watch-alerts", "--json"],
      action,
    );
    await run(["publish", "--skill-path=-draft"], action);
    await run(["publish", "--skill-path=path=with=equals"], action);
    await run(["publish", "-hh"], action);

    expect(inputs).toEqual([
      {
        skillPath: "",
        watch: true,
        ignoreWatchAlerts: true,
        json: true,
      },
      {
        skillPath: "-draft",
        watch: true,
        ignoreWatchAlerts: false,
        json: false,
      },
      {
        skillPath: "path=with=equals",
        watch: true,
        ignoreWatchAlerts: false,
        json: false,
      },
    ]);
  });

  test("help wins over malformed input and hides legacy --watch", async () => {
    const help = await runEntrypoint(["publish", "--bogus", "--help", "--watch", "--no-watch"]);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("selftune publish");
    expect(help.stdout).toContain("--no-watch");
    expect(help.stdout).not.toMatch(/^\s+--watch\b/m);
    expect(help.stdout).not.toContain("selftune-internal-publish");
    expect(existsSync(join(help.root, ".selftune"))).toBe(false);

    const helpAfterTerminator = await runEntrypoint(["publish", "--", "--help"]);
    expect(helpAfterTerminator).toMatchObject({ exitCode: 0, stderr: "" });
    expect(helpAfterTerminator.stdout).toBe(help.stdout);

    const shortHelp = await runEntrypoint(["publish", "--watch", "--no-watch", "-h"]);
    expect(shortHelp).toMatchObject({ exitCode: 0, stderr: "" });
    expect(shortHelp.stdout).toBe(help.stdout);
  });

  test("rejects watch conflicts and malformed grammar before the action", async () => {
    const action: PublishAction = () =>
      Effect.fail(new CLIError("action should not run", "INTERNAL_ERROR"));
    const conflict = await Effect.runPromise(
      makeEffectCliTestProgram(["publish", "--watch", "--no-watch"], {
        publishAction: action,
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );
    expect(conflict).toMatchObject({
      code: "INVALID_FLAG",
      message: "Use either --watch or --no-watch, not both.",
      suggestion: "selftune publish --skill-path <path> [--no-watch]",
    });

    const malformed = await Promise.all(
      [
        ["publish", "--watch=false", "--no-watch"],
        ["publish", "--watch=false"],
        ["publish", "positional"],
        ["publish", "--skill-path", "-draft"],
        ["publish", "--no-watch=true"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { publishAction: action }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    for (const error of malformed) {
      expect(error).toBeInstanceOf(CLIError);
      expect(error.message).not.toBe("action should not run");
    }
  });

  test("test programs fail closed when no action is injected", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["publish", "--no-watch"]).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );
    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live publish is disabled in the Effect CLI test program.",
    });
  });

  test("loads once per execution and owns TTY, JSON, and exit-code output", async () => {
    const loads: string[] = [];
    const printed: string[] = [];
    const exitCodes: number[] = [];
    const dependencies = {
      loadModule: async () => {
        loads.push("publish");
        return {
          runPublish: async (options: RunPublishOptions) =>
            makePublishResult(options.watch === true),
          formatPublishResult: () => "formatted publish",
        };
      },
      isStdoutTTY: () => true,
      print: (message: string) => printed.push(message),
      setExitCode: (code: number) => exitCodes.push(code),
    };

    await Effect.runPromise(
      runPublishActionWithDependencies(
        { skillPath: "/tmp/demo", watch: true, ignoreWatchAlerts: false, json: false },
        dependencies,
      ),
    );
    await Effect.runPromise(
      runPublishActionWithDependencies(
        { skillPath: "/tmp/demo", watch: false, ignoreWatchAlerts: false, json: true },
        dependencies,
      ),
    );
    await Effect.runPromise(
      runPublishActionWithDependencies(
        { skillPath: "/tmp/demo", watch: false, ignoreWatchAlerts: false, json: false },
        { ...dependencies, isStdoutTTY: () => false },
      ),
    );

    expect(loads).toEqual(["publish", "publish", "publish"]);
    expect(printed[0]).toBe("formatted publish");
    expect(JSON.parse(printed[1]!)).toMatchObject({ published: false });
    expect(JSON.parse(printed[2]!)).toMatchObject({ published: false });
    expect(exitCodes).toEqual([0, 1, 1]);
  });

  test("maps import, run, formatter, print, and exit failures and preserves CLIError identity", async () => {
    const input = {
      skillPath: "/tmp/demo",
      watch: true,
      ignoreWatchAlerts: false,
      json: false,
    };
    const output = { isStdoutTTY: () => true, print: () => {}, setExitCode: () => {} };
    const importError = await Effect.runPromise(
      runPublishActionWithDependencies(input, {
        ...output,
        loadModule: async () => {
          throw new Error("missing module");
        },
      }).pipe(Effect.flip),
    );
    expect(importError).toMatchObject({ code: "INTERNAL_ERROR" });

    const sentinel = new CLIError("sentinel", "MISSING_DATA", "selftune publish --help");
    const identity = await Effect.runPromise(
      runPublishActionWithDependencies(input, {
        ...output,
        loadModule: async () => ({
          runPublish: async () => {
            throw sentinel;
          },
          formatPublishResult: () => "unused",
        }),
      }).pipe(Effect.flip),
    );
    expect(identity).toBe(sentinel);

    const failingBoundaries = [
      {
        runPublish: async () => {
          throw new Error("run failed");
        },
        formatPublishResult: () => "unused",
        print: () => {},
        setExitCode: () => {},
      },
      {
        runPublish: async () => makePublishResult(true),
        formatPublishResult: () => {
          throw new Error("format failed");
        },
        print: () => {},
        setExitCode: () => {},
      },
      {
        runPublish: async () => makePublishResult(true),
        formatPublishResult: () => "formatted",
        print: () => {
          throw new Error("print failed");
        },
        setExitCode: () => {},
      },
      {
        runPublish: async () => makePublishResult(true),
        formatPublishResult: () => "formatted",
        print: () => {},
        setExitCode: () => {
          throw new Error("exit failed");
        },
      },
    ];
    const boundaryErrors = await Promise.all(
      failingBoundaries.map((boundary) =>
        Effect.runPromise(
          runPublishActionWithDependencies(input, {
            loadModule: async () => boundary,
            isStdoutTTY: () => true,
            print: boundary.print,
            setExitCode: boundary.setExitCode,
          }).pipe(Effect.flip),
        ),
      ),
    );
    for (const error of boundaryErrors) {
      expect(error).toMatchObject({
        code: "OPERATION_FAILED",
        message: expect.stringContaining("Publish failed:"),
      });
    }
  });

  test("runtime facade defaults watch on when called without parser normalization", async () => {
    let received: RunCreatePublishOptions | undefined;
    const sentinel = new Error("stop after capture");
    try {
      await runPublish(
        { skillPath: "/tmp/demo" },
        {
          runCreatePublish: async (options) => {
            received = options;
            throw sentinel;
          },
        },
      );
    } catch (cause) {
      expect(cause).toBe(sentinel);
    }
    expect(received).toEqual({ skillPath: "/tmp/demo", watch: true });
  });

  test("is Effect-owned, absent from legacy routing, and owns its lazy module", () => {
    expect(isEffectCliInvocation("publish", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.lifecycle).not.toContain("publish");
    const source = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/effect-cli/commands/publish.ts"),
      "utf8",
    );
    expect(source).toContain('import("@selftune/runtime/publish")');
    expect(source).not.toMatch(/\bcliMain\b|process\.argv|process\.exit\s*\(/);
    expect(source).not.toMatch(/Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/);
  });
});
