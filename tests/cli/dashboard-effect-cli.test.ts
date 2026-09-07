import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { DashboardInput } from "../../apps/local/src/dashboard-cli-contract.js";
import {
  runDashboardProgram,
  type DashboardProgramDependencies,
} from "../../apps/local/src/dashboard.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";
import {
  runDashboardActionWithDependencies,
  type DashboardActionDependencies,
} from "../../apps/cli/src/effect-cli/commands/dashboard.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const selftuneRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-dashboard-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runDashboardCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "dashboard", ...args], {
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

const DEFAULT_INPUT: DashboardInput = {
  openBrowser: true,
  port: 3141,
  removedExport: false,
  removedOut: false,
  restart: false,
  serve: false,
};

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("dashboard scoped program", () => {
  test("returns immediately when an existing dashboard is reused", async () => {
    const received: DashboardInput[] = [];
    const dependencies: DashboardProgramDependencies = {
      launch: async (input) => {
        received.push({ ...DEFAULT_INPUT, ...input });
        return { action: "reused" };
      },
    };

    await Effect.runPromise(runDashboardProgram(DEFAULT_INPUT, dependencies));

    expect(received).toEqual([DEFAULT_INPUT]);
  });

  test("keeps a started server alive and stops it exactly once on interruption", async () => {
    const launched = Promise.withResolvers<void>();
    let stopCount = 0;
    const dependencies: DashboardProgramDependencies = {
      launch: async () => {
        launched.resolve();
        return {
          action: "started",
          stop: () => {
            stopCount += 1;
          },
        };
      },
    };
    const fiber = Effect.runFork(
      runDashboardActionWithDependencies(DEFAULT_INPUT, {
        loadModule: async () => ({
          runDashboardProgram: (input) => runDashboardProgram(input, dependencies),
        }),
      }),
    );
    await launched.promise;
    await Bun.sleep(0);

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(stopCount).toBe(1);
  });

  test("finalizes a server that finishes starting during interruption", async () => {
    const enteredLaunch = Promise.withResolvers<void>();
    const pendingLaunch = Promise.withResolvers<{
      readonly action: "started";
      readonly stop: () => void;
    }>();
    let stopCount = 0;
    const dependencies: DashboardProgramDependencies = {
      launch: async () => {
        enteredLaunch.resolve();
        return pendingLaunch.promise;
      },
    };
    const fiber = Effect.runFork(runDashboardProgram(DEFAULT_INPUT, dependencies));
    await enteredLaunch.promise;

    const interruption = Effect.runPromise(Fiber.interrupt(fiber));
    pendingLaunch.resolve({ action: "started", stop: () => (stopCount += 1) });
    await interruption;

    expect(stopCount).toBe(1);
  });

  test("warns for the deprecated serve alias without changing launch options", async () => {
    const warnings: string[] = [];
    const dependencies: DashboardProgramDependencies = {
      launch: async () => ({ action: "reused" }),
      warn: (message) => warnings.push(message),
    };

    await Effect.runPromise(runDashboardProgram({ ...DEFAULT_INPUT, serve: true }, dependencies));

    expect(warnings).toEqual([
      "`selftune dashboard --serve` is deprecated; use `selftune dashboard` instead.",
    ]);
  });
});

describe("dashboard Effect CLI compatibility", () => {
  test("owns the command and parses every supported flag", async () => {
    expect(isEffectCliInvocation("dashboard", [])).toBe(true);
    expect(isEffectCliInvocation("dashboard", ["--unknown"])).toBe(true);

    const dashboards: DashboardInput[] = [];
    await Effect.runPromise(
      Effect.all(
        [["dashboard"], ["dashboard", "--port", "8080", "--restart", "--no-open", "--serve"]].map(
          (args) =>
            makeEffectCliTestProgram(args, {
              dashboardAction: (input) => Effect.sync(() => dashboards.push(input)),
            }).pipe(Effect.provide(BunServices.layer)),
        ),
        { concurrency: 1, discard: true },
      ),
    );

    expect(dashboards).toEqual([
      DEFAULT_INPUT,
      {
        openBrowser: false,
        port: 8080,
        removedExport: false,
        removedOut: false,
        restart: true,
        serve: true,
      },
    ]);
  });

  test("the shared test root fails closed instead of launching a live dashboard", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["dashboard"]).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live dashboard is disabled in the Effect CLI test program.",
    });
  });

  test("loads dashboard support only when the command action effect executes", async () => {
    let loads = 0;
    const inputs: DashboardInput[] = [];
    const dependencies: DashboardActionDependencies = {
      loadModule: async () => {
        loads += 1;
        return {
          runDashboardProgram: (input) => Effect.sync(() => inputs.push(input)),
        };
      },
    };

    const program = runDashboardActionWithDependencies(DEFAULT_INPUT, dependencies);
    expect(loads).toBe(0);
    expect(inputs).toEqual([]);

    await Effect.runPromise(program);

    expect(loads).toBe(1);
    expect(inputs).toEqual([DEFAULT_INPUT]);
  });

  test("maps lazy import failures to an actionable internal error", async () => {
    const error = await Effect.runPromise(
      runDashboardActionWithDependencies(DEFAULT_INPUT, {
        loadModule: async () => Promise.reject(new Error("module missing")),
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unable to load dashboard support: module missing",
      suggestion: "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
    });
  });

  test("maps unexpected execution failures without catching interruption", async () => {
    const error = await Effect.runPromise(
      runDashboardActionWithDependencies(DEFAULT_INPUT, {
        loadModule: async () => ({
          runDashboardProgram: () => Effect.fail(new Error("launch exploded")),
        }),
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Dashboard failed: launch exploded",
      suggestion: "selftune dashboard --help",
    });
  });

  test("preserves typed dashboard failures without losing identity", async () => {
    const typed = new CLIError(
      "Port is busy.",
      "OPERATION_FAILED",
      "selftune dashboard --port 8080",
      3,
    );
    const error = await Effect.runPromise(
      runDashboardActionWithDependencies(DEFAULT_INPUT, {
        loadModule: async () => ({
          runDashboardProgram: () => Effect.fail(typed),
        }),
      }).pipe(Effect.flip),
    );

    expect(error).toBe(typed);
    expect(error).toMatchObject({
      suggestion: "selftune dashboard --port 8080",
      exitCode: 3,
    });
  });

  test("help wins without loading dashboard state", () => {
    for (const args of [["--help"], ["-h"], ["--help", "--port"]]) {
      const home = makeHome();
      const result = runDashboardCli(home, ...args);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("selftune dashboard");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("rejects removed export modes with migration guidance", () => {
    for (const flag of ["--export", "--out"]) {
      const home = makeHome();
      const result = runDashboardCli(home, flag);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Legacy dashboard export was removed.");
      expect(result.stderr).toContain("share a route or screenshot");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("rejects missing, malformed, and out-of-range ports before launch", () => {
    for (const value of [undefined, "1.5", "3141junk", "0", "65536"]) {
      const home = makeHome();
      const args = value === undefined ? ["--port"] : ["--port", value];
      const result = runDashboardCli(home, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(value === undefined ? "argument missing" : "port");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("rejects unknown flags and positional operands before launch", () => {
    for (const args of [["--unknown"], ["unexpected"]]) {
      const home = makeHome();
      const result = runDashboardCli(home, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toBe("");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });
});
