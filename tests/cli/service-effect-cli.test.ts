import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";

import { buildBackgroundServiceArgs } from "../../apps/desktop/src/main/background-service.js";
import type { ServiceAction, ServiceInput } from "../../apps/local/src/service-cli-contract.js";
import type {
  ServiceMaintenanceAction,
  ServiceMaintenanceInput,
} from "../../apps/local/src/service/maintenance/contract.js";
import {
  runServiceLifecycleActionWithDependencies,
  runServiceMaintenanceActionWithDependencies,
  type ServiceActionDependencies,
  type ServiceCommandActions,
} from "../../apps/cli/src/effect-cli/commands/service.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";
import packageJson from "../../package.json" with { type: "json" };

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const selftuneRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryHomes: string[] = [];
const SERVICE_ACTIONS: ReadonlyArray<ServiceAction> = [
  "install",
  "status",
  "start",
  "stop",
  "restart",
  "uninstall",
];

interface ServiceCall {
  readonly action: ServiceAction;
  readonly input: ServiceInput;
}

interface MaintenanceCall {
  readonly action: ServiceMaintenanceAction;
  readonly input: ServiceMaintenanceInput;
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-service-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runServiceCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "service", ...args], {
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

function makeActions(
  calls: ServiceCall[],
  maintenanceCalls: MaintenanceCall[] = [],
): ServiceCommandActions {
  const record = (action: ServiceAction, input: ServiceInput) =>
    Effect.sync(() => calls.push({ action, input }));
  return {
    install: (input) => record("install", input),
    maintenance: (action, input) => Effect.sync(() => maintenanceCalls.push({ action, input })),
    status: (input) => record("status", input),
    start: (input) => record("start", input),
    stop: (input) => record("stop", input),
    restart: (input) => record("restart", input),
    uninstall: (input) => record("uninstall", input),
  };
}

async function runTestCommand(args: ReadonlyArray<string>, calls: ServiceCall[]) {
  await Effect.runPromise(
    makeEffectCliTestProgram(args, { serviceActions: makeActions(calls) }).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
}

async function runMaintenanceTestCommand(args: ReadonlyArray<string>, calls: MaintenanceCall[]) {
  await Effect.runPromise(
    makeEffectCliTestProgram(args, { serviceActions: makeActions([], calls) }).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
}

const serviceInput: ServiceInput = {
  boot: false,
  configDir: "/tmp/selftune",
  executable: undefined,
  json: false,
  owner: "cli",
  port: 7888,
  resourceDir: undefined,
  version: undefined,
};

function makeLifecycleModule(
  run: (action: ServiceAction, input: ServiceInput) => Effect.Effect<unknown, unknown>,
) {
  return {
    runServiceInstallProgram: (input: ServiceInput) => run("install", input),
    runServiceStatusProgram: (input: ServiceInput) => run("status", input),
    runServiceStartProgram: (input: ServiceInput) => run("start", input),
    runServiceStopProgram: (input: ServiceInput) => run("stop", input),
    runServiceRestartProgram: (input: ServiceInput) => run("restart", input),
    runServiceUninstallProgram: (input: ServiceInput) => run("uninstall", input),
  };
}

function makeMaintenanceModule(
  run: (
    action: ServiceMaintenanceAction,
    input: ServiceMaintenanceInput,
  ) => Effect.Effect<unknown, unknown>,
) {
  return {
    runServiceDoctorProgram: (input: ServiceMaintenanceInput) => run("doctor", input),
    runServiceRepairLockProgram: (input: ServiceMaintenanceInput) => run("repair-lock", input),
  };
}

function actionsWithDependencies(dependencies: ServiceActionDependencies): ServiceCommandActions {
  return {
    install: (input) => runServiceLifecycleActionWithDependencies("install", input, dependencies),
    maintenance: (action, input) =>
      runServiceMaintenanceActionWithDependencies(action, input, dependencies),
    status: (input) => runServiceLifecycleActionWithDependencies("status", input, dependencies),
    start: (input) => runServiceLifecycleActionWithDependencies("start", input, dependencies),
    stop: (input) => runServiceLifecycleActionWithDependencies("stop", input, dependencies),
    restart: (input) => runServiceLifecycleActionWithDependencies("restart", input, dependencies),
    uninstall: (input) =>
      runServiceLifecycleActionWithDependencies("uninstall", input, dependencies),
  };
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("service Effect CLI ownership", () => {
  test("loads lifecycle and maintenance support only when their action effects execute", async () => {
    let lifecycleLoads = 0;
    let maintenanceLoads = 0;
    const calls: Array<ServiceAction | ServiceMaintenanceAction> = [];
    const dependencies: ServiceActionDependencies = {
      loadLifecycleModule: async () => {
        lifecycleLoads += 1;
        return makeLifecycleModule((action) => Effect.sync(() => calls.push(action)));
      },
      loadMaintenanceModule: async () => {
        maintenanceLoads += 1;
        return makeMaintenanceModule((action) => Effect.sync(() => calls.push(action)));
      },
    };

    expect(lifecycleLoads).toBe(0);
    expect(maintenanceLoads).toBe(0);
    await Effect.runPromise(
      Effect.all(
        SERVICE_ACTIONS.map((action) =>
          runServiceLifecycleActionWithDependencies(action, serviceInput, dependencies),
        ),
        { concurrency: 1, discard: true },
      ),
    );
    expect(lifecycleLoads).toBe(6);
    expect(maintenanceLoads).toBe(0);

    await Effect.runPromise(
      Effect.all(
        (["doctor", "repair-lock"] as const).map((action) =>
          runServiceMaintenanceActionWithDependencies(action, { json: false }, dependencies),
        ),
        { concurrency: 1, discard: true },
      ),
    );

    expect(lifecycleLoads).toBe(6);
    expect(maintenanceLoads).toBe(2);
    expect(calls).toEqual([...SERVICE_ACTIONS, "doctor", "repair-lock"]);
  });

  test("does not load either service module for root or leaf help", async () => {
    let lifecycleLoads = 0;
    let maintenanceLoads = 0;
    const dependencies: ServiceActionDependencies = {
      loadLifecycleModule: async () => {
        lifecycleLoads += 1;
        return makeLifecycleModule(() => Effect.void);
      },
      loadMaintenanceModule: async () => {
        maintenanceLoads += 1;
        return makeMaintenanceModule(() => Effect.void);
      },
    };
    const serviceActions = actionsWithDependencies(dependencies);

    await Promise.all(
      [
        ["service", "--help"],
        ["service", "install", "--help"],
        ["service", "doctor", "--help"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { serviceActions }).pipe(
            Effect.provide(BunServices.layer),
          ),
        ),
      ),
    );

    expect(lifecycleLoads).toBe(0);
    expect(maintenanceLoads).toBe(0);
  });

  test("maps lifecycle and maintenance import failures to actionable internal errors", async () => {
    const dependencies: ServiceActionDependencies = {
      loadLifecycleModule: async () => Promise.reject(new Error("lifecycle missing")),
      loadMaintenanceModule: async () => Promise.reject(new Error("maintenance missing")),
    };
    const programs = [
      ...SERVICE_ACTIONS.map((action) => ({
        action,
        program: runServiceLifecycleActionWithDependencies(action, serviceInput, dependencies),
      })),
      ...(["doctor", "repair-lock"] as const).map((action) => ({
        action,
        program: runServiceMaintenanceActionWithDependencies(action, { json: false }, dependencies),
      })),
    ];

    const errors = await Promise.all(
      programs.map(({ program }) => Effect.runPromise(program.pipe(Effect.flip))),
    );
    for (const [index, { action }] of programs.entries()) {
      const error = errors[index];
      expect(error).toMatchObject({
        code: "INTERNAL_ERROR",
        message: `Unable to load service ${action} support: ${
          action === "doctor" || action === "repair-lock"
            ? "maintenance missing"
            : "lifecycle missing"
        }`,
        suggestion: "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
      });
    }
  });

  test("maps synchronous construction and typed execution failures without defects", async () => {
    const constructionDependencies: ServiceActionDependencies = {
      loadLifecycleModule: async () =>
        makeLifecycleModule(() => {
          throw { operation: "parse", message: "bad descriptor" };
        }),
      loadMaintenanceModule: async () => makeMaintenanceModule(() => Effect.void),
    };
    const constructionError = await Effect.runPromise(
      runServiceLifecycleActionWithDependencies(
        "install",
        serviceInput,
        constructionDependencies,
      ).pipe(Effect.flip),
    );
    expect(constructionError).toMatchObject({
      code: "INVALID_FLAG",
      message: "bad descriptor",
      suggestion: "selftune service --help",
    });

    const maintenanceConstructionDependencies: ServiceActionDependencies = {
      loadLifecycleModule: async () => makeLifecycleModule(() => Effect.void),
      loadMaintenanceModule: async () =>
        makeMaintenanceModule(() => {
          throw { operation: "doctor", message: "maintenance construction failed" };
        }),
    };
    const maintenanceConstructionError = await Effect.runPromise(
      runServiceMaintenanceActionWithDependencies(
        "doctor",
        { json: false },
        maintenanceConstructionDependencies,
      ).pipe(Effect.flip),
    );
    expect(maintenanceConstructionError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "maintenance construction failed",
      suggestion: "selftune service status --json",
    });

    const executionDependencies: ServiceActionDependencies = {
      loadLifecycleModule: async () =>
        makeLifecycleModule(() =>
          Effect.fail({ operation: "start", message: "supervisor unavailable" }),
        ),
      loadMaintenanceModule: async () => makeMaintenanceModule(() => Effect.void),
    };
    const executionError = await Effect.runPromise(
      runServiceLifecycleActionWithDependencies("start", serviceInput, executionDependencies).pipe(
        Effect.flip,
      ),
    );
    expect(executionError).toMatchObject({
      code: "OPERATION_FAILED",
      message: "supervisor unavailable",
      suggestion: "selftune service status --json",
    });

    const maintenanceExecutionDependencies: ServiceActionDependencies = {
      loadLifecycleModule: async () => makeLifecycleModule(() => Effect.void),
      loadMaintenanceModule: async () =>
        makeMaintenanceModule(() =>
          Effect.fail({ operation: "parse", message: "invalid maintenance request" }),
        ),
    };
    const maintenanceExecutionError = await Effect.runPromise(
      runServiceMaintenanceActionWithDependencies(
        "repair-lock",
        { json: true },
        maintenanceExecutionDependencies,
      ).pipe(Effect.flip),
    );
    expect(maintenanceExecutionError).toMatchObject({
      code: "INVALID_FLAG",
      message: "invalid maintenance request",
      suggestion: "selftune service --help",
    });
  });

  test("preserves an existing CLIError object and successful maintenance results", async () => {
    const original = new CLIError("retry later", "API_ERROR", "wait", 7, true);
    let maintenanceRuns = 0;
    const identityDependencies: ServiceActionDependencies = {
      loadLifecycleModule: async () => makeLifecycleModule(() => Effect.fail(original)),
      loadMaintenanceModule: async () =>
        makeMaintenanceModule(() =>
          Effect.sync(() => {
            maintenanceRuns += 1;
          }),
        ),
    };

    const received = await Effect.runPromise(
      runServiceLifecycleActionWithDependencies("status", serviceInput, identityDependencies).pipe(
        Effect.flip,
      ),
    );
    expect(received).toBe(original);
    expect(received).toMatchObject({ exitCode: 7, retryable: true });

    await Effect.runPromise(
      runServiceMaintenanceActionWithDependencies("doctor", { json: true }, identityDependencies),
    );
    expect(maintenanceRuns).toBe(1);
  });

  test("fails closed for all service actions in the shared test root", async () => {
    const cases = [
      ...SERVICE_ACTIONS.map((action) => ({ action, args: ["service", action] })),
      { action: "maintenance", args: ["service", "doctor"] },
      { action: "maintenance", args: ["service", "repair-lock"] },
    ];

    const errors = await Promise.all(
      cases.map(({ args }) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args).pipe(Effect.provide(BunServices.layer), Effect.flip),
        ),
      ),
    );
    for (const [index, { action }] of cases.entries()) {
      const error = errors[index];
      expect(error).toMatchObject({
        code: "INTERNAL_ERROR",
        message: `Live service ${action} is disabled in the Effect CLI test program.`,
      });
    }
  });
});

describe("service Effect CLI compatibility", () => {
  test("owns the complete service command family", () => {
    expect(isEffectCliInvocation("service", [])).toBe(true);
    for (const action of SERVICE_ACTIONS) {
      expect(isEffectCliInvocation("service", [action])).toBe(true);
    }
    expect(isEffectCliInvocation("service", ["doctor"])).toBe(true);
    expect(isEffectCliInvocation("service", ["repair-lock"])).toBe(true);
    expect(isEffectCliInvocation("service", ["--unknown"])).toBe(true);
  });

  test("parses maintenance commands through a descriptor-free grammar", async () => {
    const calls: MaintenanceCall[] = [];
    await runMaintenanceTestCommand(["service", "doctor"], calls);
    await runMaintenanceTestCommand(["service", "repair-lock", "--json"], calls);

    expect(calls).toEqual([
      { action: "doctor", input: { json: false } },
      { action: "repair-lock", input: { json: true } },
    ]);
  });

  test("rejects every descriptor or candidate authority on maintenance commands", async () => {
    const invalid: ReadonlyArray<ReadonlyArray<string>> = [
      ["unexpected"],
      ["--boot"],
      ["--config-dir", "/tmp/foreign"],
      ["--executable", "/tmp/selftune"],
      ["--owner", "desktop"],
      ["--pid", "404"],
      ["--port", "7888"],
      ["--resource-dir", "/tmp/resources"],
      ["--service-version", "1.2.3"],
      ["--version", "1.2.3"],
      ["--force"],
      ["--path", "/tmp/lock"],
    ];
    await Promise.all(
      (["doctor", "repair-lock"] as const).flatMap((action) =>
        invalid.map(async (suffix) => {
          const calls: MaintenanceCall[] = [];
          await expect(
            runMaintenanceTestCommand(["service", action, ...suffix], calls),
          ).rejects.toThrow();
          expect(calls).toEqual([]);
        }),
      ),
    );
  });

  test("parses shared defaults for every action", async () => {
    const calls = await Promise.all(
      SERVICE_ACTIONS.map(async (action) => {
        const actionCalls: ServiceCall[] = [];
        await runTestCommand(["service", action], actionCalls);
        return actionCalls[0];
      }),
    );

    expect(calls).toEqual(
      SERVICE_ACTIONS.map((action) => ({
        action,
        input: {
          boot: false,
          configDir: undefined,
          executable: undefined,
          json: false,
          owner: undefined,
          port: 7888,
          resourceDir: undefined,
          version: undefined,
        },
      })),
    );
  });

  test("parses every shared flag and service port boundary", async () => {
    const calls: ServiceCall[] = [];
    await runTestCommand(
      [
        "service",
        "install",
        "--port",
        "1",
        "--config-dir",
        "/tmp/selftune",
        "--owner",
        "desktop",
        "--boot",
        "--json",
        "--executable",
        "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
        "--resource-dir",
        "/Applications/SelfTune.app/Contents/Resources/selftune",
        "--service-version",
        "1.2.3",
      ],
      calls,
    );
    await runTestCommand(["service", "status", "--port", "65535"], calls);

    expect(calls).toEqual([
      {
        action: "install",
        input: {
          boot: true,
          configDir: "/tmp/selftune",
          executable: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
          json: true,
          owner: "desktop",
          port: 1,
          resourceDir: "/Applications/SelfTune.app/Contents/Resources/selftune",
          version: "1.2.3",
        },
      },
      {
        action: "status",
        input: {
          boot: false,
          configDir: undefined,
          executable: undefined,
          json: false,
          owner: undefined,
          port: 65_535,
          resourceDir: undefined,
          version: undefined,
        },
      },
    ]);
  });

  test("normalizes both legacy service version spellings before global version parsing", async () => {
    const calls: ServiceCall[] = [];
    await runTestCommand(["service", "install", "--version", "1.2.3"], calls);
    await runTestCommand(["service", "restart", "--version=2.0.0"], calls);

    expect(calls.map(({ action, input }) => ({ action, version: input.version }))).toEqual([
      { action: "install", version: "1.2.3" },
      { action: "restart", version: "2.0.0" },
    ]);

    const home = makeHome();
    const version = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "--version"], {
      cwd: selftuneRoot,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(version.exitCode).toBe(0);
    expect(Buffer.from(version.stdout).toString("utf8").trim()).toBe(packageJson.version);
  });

  test("accepts the exact Desktop-generated arguments for every action", async () => {
    const options = {
      configDir: "/Users/test/.selftune",
      executablePath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
      resourceDir: "/Applications/SelfTune.app/Contents/Resources/selftune",
      version: "0.3.0",
    };

    const calls = await Promise.all(
      SERVICE_ACTIONS.map(async (action) => {
        const actionCalls: ServiceCall[] = [];
        await runTestCommand(buildBackgroundServiceArgs(options, action), actionCalls);
        return actionCalls[0];
      }),
    );

    expect(calls.map(({ action, input }) => ({ action, input }))).toEqual(
      SERVICE_ACTIONS.map((action) => ({
        action,
        input: {
          boot: false,
          configDir: options.configDir,
          executable: options.executablePath,
          json: true,
          owner: "desktop",
          port: 7888,
          resourceDir: options.resourceDir,
          version: options.version,
        },
      })),
    );
  });

  test("accepts complete argv from older Desktop builds for every action", async () => {
    const options = {
      configDir: "/Users/test/.selftune",
      executablePath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
      resourceDir: "/Applications/SelfTune.app/Contents/Resources/selftune",
      version: "0.3.0",
    };
    const calls = await Promise.all(
      SERVICE_ACTIONS.map(async (action) => {
        const actionCalls: ServiceCall[] = [];
        const legacyArgs = buildBackgroundServiceArgs(options, action).map((argument) =>
          argument === "--service-version" ? "--version" : argument,
        );
        await runTestCommand(legacyArgs, actionCalls);
        return actionCalls[0];
      }),
    );

    expect(calls.map(({ action, input }) => ({ action, version: input.version }))).toEqual(
      SERVICE_ACTIONS.map((action) => ({ action, version: options.version })),
    );
  });

  test("help wins at the root and every leaf without creating local state", () => {
    for (const args of [
      [],
      ["--help"],
      ["-h"],
      ...SERVICE_ACTIONS.map((action) => [action, "--help"]),
      ["doctor", "--help"],
      ["repair-lock", "--help"],
      ["install", "--help", "--port"],
    ]) {
      const home = makeHome();
      const result = runServiceCli(home, ...args);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("selftune service");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("rejects missing, malformed, and unsupported arguments before invoking a handler", async () => {
    const invalidArguments: ReadonlyArray<ReadonlyArray<string>> = [
      ...[
        "--port",
        "--config-dir",
        "--owner",
        "--executable",
        "--resource-dir",
        "--service-version",
        "--version",
      ].map((flag) => ["service", "install", flag]),
      ["service", "install", "--version="],
      ["service", "install", "--port", "-1"],
      ["service", "install", "--port", "0"],
      ["service", "install", "--port", "1.5"],
      ["service", "install", "--port", "7888junk"],
      ["service", "install", "--port", "65536"],
      ["service", "install", "--owner", "unknown"],
      ["service", "install", "--unknown"],
      ["service", "install", "unexpected"],
    ];

    await Promise.all(
      invalidArguments.map(async (args) => {
        const calls: ServiceCall[] = [];
        await expect(runTestCommand(args, calls)).rejects.toThrow();
        expect(calls).toEqual([]);
      }),
    );
  });

  test("rejects invalid public invocations without creating service state", () => {
    for (const args of [
      ["install", "--port"],
      ["install", "--port", "0"],
      ["install", "--version="],
      ["install", "--owner", "unknown"],
      ["install", "--unknown"],
      ["install", "unexpected"],
    ]) {
      const home = makeHome();
      const result = runServiceCli(home, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toBe("");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });
});
