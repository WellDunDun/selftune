import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import {
  runRegistryActionWithDependencies,
  type RegistryAction,
} from "../../apps/cli/src/effect-cli/commands/registry.js";
import {
  prepareLegacyRegistryArguments,
  REGISTRY_INTERNAL_PARENT_HELP_FLAG,
  REGISTRY_INTERNAL_VERSION_FLAG,
} from "../../apps/cli/src/effect-cli/compatibility/registry.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import type {
  RegistryProgramInput,
  RegistryProgramResult,
} from "../../packages/runtime/registry/programs.js";
import { registryLiveLayer } from "../../packages/runtime/registry/programs.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

function run(args: ReadonlyArray<string>, registryAction: RegistryAction) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { registryAction }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(BunServices.layer),
    ),
  );
}

function recordingAction(calls: RegistryProgramInput[]): RegistryAction {
  return (input) => Effect.sync(() => calls.push(input));
}

describe("registry Effect CLI compatibility", () => {
  test("dispatches all seven leaves as typed inputs", async () => {
    const calls: RegistryProgramInput[] = [];
    const action = recordingAction(calls);

    await run(
      [
        "registry",
        "push",
        "deploy",
        "ignored",
        "--version=1.2.3",
        "--version=9.9.9",
        "--summary=first",
        "--summary=second",
        "--unknown",
        "--help",
      ],
      action,
    );
    await run(
      ["registry", "install", "cloud", "ignored", "--global", "--unknown", "--help"],
      action,
    );
    await run(["registry", "sync", "ignored", "--unknown", "--help"], action);
    await run(["registry", "status", "ignored", "--unknown", "--help"], action);
    await run(
      [
        "registry",
        "rollback",
        "deploy",
        "ignored",
        "--to=1.0.0",
        "--to=2.0.0",
        "--reason=first",
        "--reason=second",
        "--unknown",
      ],
      action,
    );
    await run(["registry", "history", "deploy", "ignored", "--unknown", "--help"], action);
    await run(["registry", "list", "ignored", "--unknown", "--help"], action);

    expect(calls).toEqual([
      {
        operation: "push",
        name: "deploy",
        version: "1.2.3",
        summary: "first",
      },
      { operation: "install", target: "cloud", global: true },
      { operation: "sync", automaticOnly: false },
      { operation: "status" },
      {
        operation: "rollback",
        name: "deploy",
        targetVersion: "1.0.0",
        reason: "first",
      },
      { operation: "history", name: "deploy" },
      { operation: "list" },
    ]);
  });

  test("only recognizes help in the parent subcommand position", () => {
    expect(prepareLegacyRegistryArguments([])).toEqual([`--${REGISTRY_INTERNAL_PARENT_HELP_FLAG}`]);
    expect(prepareLegacyRegistryArguments(["--help", "--unknown"])).toEqual([
      `--${REGISTRY_INTERNAL_PARENT_HELP_FLAG}`,
    ]);
    expect(prepareLegacyRegistryArguments(["list", "--help"])).toEqual(["list"]);
    expect(prepareLegacyRegistryArguments(["history", "-h", "ignored"])).toEqual([
      "history",
      "--name",
      ":-h",
    ]);
    expect(() => prepareLegacyRegistryArguments(["-hh", "--json"])).toThrow(
      new CLIError(
        "Unknown registry subcommand: -hh",
        "UNKNOWN_COMMAND",
        "selftune registry --help",
      ),
    );
  });

  test("preserves first positional and attached-value parsing quirks", () => {
    expect(
      prepareLegacyRegistryArguments([
        "push",
        "--unknown",
        "-short-name",
        "later",
        "--version=",
        "--version=2.0.0",
        "--summary=:literal",
      ]),
    ).toEqual([
      "push",
      "--name",
      ":-short-name",
      `--${REGISTRY_INTERNAL_VERSION_FLAG}`,
      ":",
      "--summary",
      "::literal",
    ]);
    expect(
      prepareLegacyRegistryArguments([
        "rollback",
        "deploy",
        "--to=",
        "--to=2.0.0",
        "--reason=-urgent",
      ]),
    ).toEqual(["rollback", "--name", ":deploy", "--to", ":", "--reason", ":-urgent"]);
  });

  test("parent help never invokes a leaf action", async () => {
    const calls: RegistryProgramInput[] = [];
    const action = recordingAction(calls);

    await run(["registry"], action);
    await run(["registry", "--help", "--unknown"], action);

    expect(calls).toEqual([]);
  });

  test("is fully Effect-owned and absent from the legacy operations group", () => {
    expect(isEffectCliInvocation("registry", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("registry");
  });

  test("keeps runtime registry values behind the lazy module boundary", () => {
    const source = readFileSync(
      new URL("../../apps/cli/src/effect-cli/commands/registry.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/import\s+(?!type\b)[^;]*from\s+["']@selftune\/runtime\/registry\//);
  });
});

describe("registry Effect action boundary", () => {
  test("writes ordered output and records the program exit code", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCodes: Array<0 | 1> = [];
    const result: RegistryProgramResult = {
      operation: "push",
      stdout: ["Pushing deploy...", '{"success":true}'],
      stderr: ["warning"],
      exitCode: 1,
    };

    await Effect.runPromise(
      runRegistryActionWithDependencies(
        { operation: "push", name: "deploy" },
        {
          loadModule: async () => ({
            isRegistryInternalFailure: () => false,
            runRegistryProgram: () => Effect.succeed(result),
            registryLiveLayer,
          }),
          writeStdout: (message) => stdout.push(message),
          writeStderr: (message) => stderr.push(message),
          setExitCode: (exitCode) => exitCodes.push(exitCode),
        },
      ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(BunServices.layer)),
    );

    expect(stdout).toEqual(["Pushing deploy...", '{"success":true}']);
    expect(stderr).toEqual(["warning"]);
    expect(exitCodes).toEqual([1]);
  });

  test("maps loader and program failures to structured CLI errors", async () => {
    const input = { operation: "list" } satisfies RegistryProgramInput;
    const dependencies = {
      loadModule: async () => {
        throw new Error("missing module");
      },
      writeStdout: () => {},
      writeStderr: () => {},
      setExitCode: () => {},
    };

    const error = await Effect.runPromise(
      Effect.flip(runRegistryActionWithDependencies(input, dependencies)).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(BunServices.layer),
      ),
    );
    expect(error).toBeInstanceOf(CLIError);
    expect(error.message).toContain("Unable to load registry support: missing module");
  });

  test("loads lazily and maps synchronous output adapter failures", async () => {
    const result: RegistryProgramResult = {
      operation: "status",
      stdout: [],
      stderr: ['{"error":"registry unavailable"}'],
      exitCode: 1,
    };
    let loaded = 0;
    const program = runRegistryActionWithDependencies(
      { operation: "status" },
      {
        loadModule: async () => {
          loaded += 1;
          return {
            isRegistryInternalFailure: () => false,
            runRegistryProgram: () => Effect.succeed(result),
            registryLiveLayer,
          };
        },
        writeStdout: () => {},
        writeStderr: () => {
          throw new Error("broken stderr");
        },
        setExitCode: () => {},
      },
    );

    expect(loaded).toBe(0);
    const error = await Effect.runPromise(
      Effect.flip(program).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(BunServices.layer),
      ),
    );
    expect(loaded).toBe(1);
    expect(error).toBeInstanceOf(CLIError);
    expect(error.message).toBe("Registry status failed: broken stderr");
  });
});
