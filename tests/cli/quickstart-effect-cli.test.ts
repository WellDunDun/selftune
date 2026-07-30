import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";

import { CLIError } from "../../packages/runtime/utils/cli-error.js";
import {
  runQuickstartActionWithDependencies,
  type QuickstartActionDependencies,
} from "../../apps/cli/src/effect-cli/commands/quickstart.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const selftuneRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-quickstart-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runQuickstartCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "quickstart", ...args], {
    cwd: selftuneRoot,
    env: {
      ...process.env,
      HOME: home,
      SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
      SELFTUNE_NO_ANALYTICS: "1",
      SELFTUNE_SKIP_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
  };
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("quickstart Effect CLI ownership", () => {
  test("dispatches through the command-owned injected action", async () => {
    let calls = 0;

    await Effect.runPromise(
      makeEffectCliTestProgram(["quickstart"], {
        quickstartAction: () => Effect.sync(() => calls++),
      }).pipe(Effect.provide(BunServices.layer)),
    );

    expect(calls).toBe(1);
  });

  test("the shared test root fails closed instead of running live onboarding", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["quickstart"]).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live quickstart is disabled in the Effect CLI test program.",
    });
  });

  test("loads onboarding only when the live action effect is executed", async () => {
    let loads = 0;
    let runs = 0;
    const dependencies: QuickstartActionDependencies = {
      loadModule: async () => {
        loads++;
        return {
          quickstart: async () => {
            runs++;
          },
        };
      },
    };

    const program = runQuickstartActionWithDependencies(dependencies);
    expect(loads).toBe(0);
    expect(runs).toBe(0);

    await Effect.runPromise(program);

    expect(loads).toBe(1);
    expect(runs).toBe(1);
  });

  test("maps lazy import failures to an actionable internal error", async () => {
    const error = await Effect.runPromise(
      runQuickstartActionWithDependencies({
        loadModule: async () => Promise.reject(new Error("module missing")),
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unable to load quickstart support: module missing",
      suggestion: "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
    });
  });

  test("maps escaped onboarding failures to an actionable operation error", async () => {
    const error = await Effect.runPromise(
      runQuickstartActionWithDependencies({
        loadModule: async () => ({
          quickstart: async () => Promise.reject(new Error("database unavailable")),
        }),
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Quickstart failed: database unavailable",
      suggestion: "selftune quickstart --help",
    });
  });

  test("preserves typed onboarding failures without losing their identity", async () => {
    const typed = new CLIError("Configuration is missing.", "CONFIG_MISSING", "selftune init", 4);
    const error = await Effect.runPromise(
      runQuickstartActionWithDependencies({
        loadModule: async () => ({
          quickstart: async () => Promise.reject(typed),
        }),
      }).pipe(Effect.flip),
    );

    expect(error).toBe(typed);
    expect(error).toMatchObject({
      code: "CONFIG_MISSING",
      suggestion: "selftune init",
      exitCode: 4,
    });
  });

  test("help stays lazy and creates no onboarding state", () => {
    const home = makeHome();
    const result = runQuickstartCli(home, "--help");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("selftune quickstart");
    expect(result.stdout).toContain("guided onboarding");
    expect(result.stderr).toBe("");
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });
});
