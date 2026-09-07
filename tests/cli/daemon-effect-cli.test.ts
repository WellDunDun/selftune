import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";

import type {
  DaemonRotateTokenInput,
  DaemonRunInput,
  DaemonStatusInput,
  DaemonStopInput,
} from "../../apps/local/src/daemon-cli-contract.js";
import { serviceProgramArguments } from "../../apps/local/src/service.js";
import {
  runDaemonActionWithDependencies,
  runDaemonRotateTokenActionWithDependencies,
  runDaemonStatusActionWithDependencies,
  runDaemonStopActionWithDependencies,
  type DaemonActionDependencies,
  type DaemonCommandActions,
} from "../../apps/cli/src/effect-cli/commands/daemon.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const DIRECT_DAEMON_ENTRYPOINT = fileURLToPath(
  new URL("../../apps/local/src/daemon.ts", import.meta.url),
);
const selftuneRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-daemon-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runDaemonCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "daemon", ...args], {
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

async function runDaemonLifecycle(
  home: string,
  entrypoint: string = CLI_ENTRYPOINT,
  commandPrefix: ReadonlyArray<string> = ["daemon"],
): Promise<void> {
  const manifestPath = join(home, ".selftune", "server-control", "server.json");
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      entrypoint,
      ...commandPrefix,
      "run",
      "--port",
      "0",
      "--ready-sentinel",
    ],
    {
      cwd: selftuneRoot,
      env: {
        ...process.env,
        CI: "1",
        HOME: home,
        SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
        SELFTUNE_NO_ANALYTICS: "1",
        SELFTUNE_SKIP_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const ready = Promise.withResolvers<void>();
  let readySeen = false;
  const stdout = (async () => {
    let output = "";
    for await (const chunk of child.stdout) {
      output += Buffer.from(chunk).toString("utf8");
      if (output.includes("SELFTUNE_READY:")) {
        readySeen = true;
        ready.resolve();
      }
    }
    return output;
  })();
  const stderr = new Response(child.stderr).text();

  try {
    await Promise.race([
      ready.promise,
      child.exited.then(async (exitCode) => {
        if (!readySeen) {
          throw new Error(`Daemon exited ${exitCode} before readiness: ${await stderr}`);
        }
        return undefined;
      }),
      Bun.sleep(10_000).then(() => {
        throw new Error("Timed out waiting for the daemon ready sentinel.");
      }),
    ]);
    expect(existsSync(manifestPath)).toBe(true);
    child.kill("SIGTERM");
    await Promise.race([
      child.exited,
      Bun.sleep(10_000).then(() => {
        throw new Error("Timed out waiting for the daemon to stop.");
      }),
    ]);
    await Promise.all([stdout, stderr]);
    expect(existsSync(manifestPath)).toBe(false);
  } finally {
    child.kill("SIGKILL");
  }
}

interface DaemonCalls {
  readonly runs: DaemonRunInput[];
  readonly statuses: DaemonStatusInput[];
  readonly stops: DaemonStopInput[];
  readonly rotations: DaemonRotateTokenInput[];
}

function makeDaemonActions(calls: DaemonCalls): DaemonCommandActions {
  return {
    run: (input) => Effect.sync(() => calls.runs.push(input)),
    status: (input) => Effect.sync(() => calls.statuses.push(input)),
    stop: (input) => Effect.sync(() => calls.stops.push(input)),
    rotateToken: (input) => Effect.sync(() => calls.rotations.push(input)),
  };
}

function emptyCalls(): DaemonCalls {
  return { runs: [], statuses: [], stops: [], rotations: [] };
}

async function runTestCommand(args: ReadonlyArray<string>, calls: DaemonCalls) {
  await Effect.runPromise(
    makeEffectCliTestProgram(args, {
      daemonActions: makeDaemonActions(calls),
    }).pipe(Effect.provide(BunServices.layer)),
  );
}

const runInput: DaemonRunInput = {
  configDir: "/tmp/selftune",
  foreground: true,
  hostname: "127.0.0.1",
  owner: "cli",
  port: 0,
  readySentinel: false,
  runtimeMode: "test",
  serviceInstallationNonce: undefined,
  spaDir: undefined,
  supervised: false,
};
const statusInput: DaemonStatusInput = { configDir: "/tmp/selftune", json: true };
const stopInput: DaemonStopInput = {
  configDir: "/tmp/selftune",
  expectedInstanceId: "instance",
  expectedPid: 42,
};
const rotateTokenInput: DaemonRotateTokenInput = { configDir: "/tmp/selftune" };

function daemonActionPrograms(dependencies: DaemonActionDependencies) {
  return [
    runDaemonActionWithDependencies(runInput, dependencies),
    runDaemonStatusActionWithDependencies(statusInput, dependencies),
    runDaemonStopActionWithDependencies(stopInput, dependencies),
    runDaemonRotateTokenActionWithDependencies(rotateTokenInput, dependencies),
  ] as const;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("daemon Effect CLI compatibility", () => {
  const serviceInstallationNonce = "abcdefghijklmnopqrstuvwxyz_ABCDE";

  test("owns the complete daemon command family", () => {
    expect(isEffectCliInvocation("daemon", [])).toBe(true);
    expect(isEffectCliInvocation("daemon", ["run"])).toBe(true);
    expect(isEffectCliInvocation("daemon", ["--unknown"])).toBe(true);
  });

  test("owns its lazy live adapters without a global handler registry", () => {
    const commandSource = readFileSync(
      join(selftuneRoot, "apps/cli/src/effect-cli/commands/daemon.ts"),
      "utf8",
    );
    expect(commandSource).toContain('import("@selftune/local/daemon")');
    expect(existsSync(join(selftuneRoot, "apps/cli/src/effect-cli/commands/contracts.ts"))).toBe(
      false,
    );
    expect(existsSync(join(selftuneRoot, "apps/cli/src/effect-cli/handlers/live.ts"))).toBe(false);
  });

  test("fails closed for every daemon action in the shared test root", async () => {
    const cases = [
      { action: "run", args: ["daemon", "run"] },
      { action: "status", args: ["daemon", "status"] },
      { action: "stop", args: ["daemon", "stop"] },
      { action: "rotateToken", args: ["daemon", "rotate-token"] },
    ] as const;

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
        message: `Live daemon ${action} is disabled in the Effect CLI test program.`,
      });
    }
  });

  test("loads daemon support only when each action effect executes", async () => {
    let loads = 0;
    const calls: string[] = [];
    const dependencies: DaemonActionDependencies = {
      loadModule: async () => {
        loads += 1;
        return {
          runDaemonProgram: () => Effect.sync(() => calls.push("run")),
          runDaemonStatusProgram: () => Effect.sync(() => calls.push("status")),
          runDaemonStopProgram: () => Effect.sync(() => calls.push("stop")),
          runDaemonRotateTokenProgram: () => Effect.sync(() => calls.push("rotate-token")),
        };
      },
    };
    const programs = daemonActionPrograms(dependencies);

    expect(loads).toBe(0);
    expect(calls).toEqual([]);

    await Effect.runPromise(Effect.all(programs, { concurrency: 1, discard: true }));

    expect(loads).toBe(4);
    expect(calls).toEqual(["run", "status", "stop", "rotate-token"]);
  });

  test("does not load daemon support for help", async () => {
    let loads = 0;
    const dependencies: DaemonActionDependencies = {
      loadModule: async () => {
        loads += 1;
        return {
          runDaemonProgram: () => Effect.void,
          runDaemonStatusProgram: () => Effect.void,
          runDaemonStopProgram: () => Effect.void,
          runDaemonRotateTokenProgram: () => Effect.void,
        };
      },
    };
    const daemonActions: DaemonCommandActions = {
      run: (input) => runDaemonActionWithDependencies(input, dependencies),
      status: (input) => runDaemonStatusActionWithDependencies(input, dependencies),
      stop: (input) => runDaemonStopActionWithDependencies(input, dependencies),
      rotateToken: (input) => runDaemonRotateTokenActionWithDependencies(input, dependencies),
    };

    await Promise.all(
      [
        ["daemon", "run", "--help"],
        ["daemon", "status", "--help"],
        ["daemon", "stop", "--help"],
        ["daemon", "rotate-token", "--help"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { daemonActions }).pipe(Effect.provide(BunServices.layer)),
        ),
      ),
    );

    expect(loads).toBe(0);
  });

  test("maps all lazy import failures to actionable internal errors", async () => {
    const programs = daemonActionPrograms({
      loadModule: async () => Promise.reject(new Error("module missing")),
    });
    const actions = ["run", "status", "stop", "rotate-token"] as const;

    const errors = await Promise.all(
      programs.map((program) => Effect.runPromise(program.pipe(Effect.flip))),
    );

    for (const [index, error] of errors.entries()) {
      expect(error).toMatchObject({
        code: "INTERNAL_ERROR",
        message: `Unable to load daemon ${actions[index]} support: module missing`,
        suggestion: "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
      });
    }
  });

  test("maps daemon failures by operation for every action", async () => {
    const failures = [
      { operation: "parse", message: "invalid daemon configuration", code: "INVALID_FLAG" },
      { operation: "stop", message: "daemon did not stop", code: "OPERATION_FAILED" },
    ] as const;
    const mappedFailures = await Promise.all(
      failures.map(async (failure) => {
        const dependencies: DaemonActionDependencies = {
          loadModule: async () => ({
            runDaemonProgram: () => Effect.fail(failure),
            runDaemonStatusProgram: () => Effect.fail(failure),
            runDaemonStopProgram: () => Effect.fail(failure),
            runDaemonRotateTokenProgram: () => Effect.fail(failure),
          }),
        };
        const errors = await Promise.all(
          daemonActionPrograms(dependencies).map((program) =>
            Effect.runPromise(program.pipe(Effect.flip)),
          ),
        );
        return { errors, failure };
      }),
    );

    for (const { errors, failure } of mappedFailures) {
      for (const error of errors) {
        expect(error).toMatchObject({
          code: failure.code,
          message: failure.message,
          suggestion: "selftune daemon --help",
        });
      }
    }
  });

  test("preserves typed CLI errors without losing identity", async () => {
    const typed = new CLIError("Daemon credentials missing.", "AUTH_MISSING", "relink", 4);
    const dependencies: DaemonActionDependencies = {
      loadModule: async () => ({
        runDaemonProgram: () => Effect.fail(typed),
        runDaemonStatusProgram: () => Effect.fail(typed),
        runDaemonStopProgram: () => Effect.fail(typed),
        runDaemonRotateTokenProgram: () => Effect.fail(typed),
      }),
    };

    const errors = await Promise.all(
      daemonActionPrograms(dependencies).map((program) =>
        Effect.runPromise(program.pipe(Effect.flip)),
      ),
    );

    for (const error of errors) {
      expect(error).toBe(typed);
      expect(error).toMatchObject({ suggestion: "relink", exitCode: 4 });
    }
  });

  test("parses run defaults and every supported run option", async () => {
    const calls = emptyCalls();
    await runTestCommand(["daemon", "run"], calls);
    await runTestCommand(
      [
        "daemon",
        "run",
        "--port",
        "0",
        "--hostname",
        "127.0.0.1",
        "--config-dir",
        "/tmp/selftune",
        "--spa-dir",
        "/tmp/spa",
        "--owner",
        "desktop",
        "--runtime-mode",
        "dev-server",
        "--foreground",
        "--supervised",
        "--service-installation-nonce",
        serviceInstallationNonce,
        "--ready-sentinel",
      ],
      calls,
    );
    await runTestCommand(["daemon", "run", "--port", "65535"], calls);

    expect(calls.runs).toEqual([
      {
        configDir: undefined,
        foreground: false,
        hostname: "127.0.0.1",
        owner: undefined,
        port: 7888,
        readySentinel: false,
        runtimeMode: undefined,
        serviceInstallationNonce: undefined,
        spaDir: undefined,
        supervised: false,
      },
      {
        configDir: "/tmp/selftune",
        foreground: true,
        hostname: "127.0.0.1",
        owner: "desktop",
        port: 0,
        readySentinel: true,
        runtimeMode: "dev-server",
        serviceInstallationNonce,
        spaDir: "/tmp/spa",
        supervised: true,
      },
      {
        configDir: undefined,
        foreground: false,
        hostname: "127.0.0.1",
        owner: undefined,
        port: 65_535,
        readySentinel: false,
        runtimeMode: undefined,
        serviceInstallationNonce: undefined,
        spaDir: undefined,
        supervised: false,
      },
    ]);
  });

  test("parses status, stop, and token rotation without touching live state", async () => {
    const calls = emptyCalls();
    await runTestCommand(["daemon", "status", "--config-dir", "/tmp/a", "--json"], calls);
    await runTestCommand(
      [
        "daemon",
        "stop",
        "--config-dir",
        "/tmp/b",
        "--expected-pid",
        "42",
        "--expected-instance-id",
        "instance",
      ],
      calls,
    );
    await runTestCommand(["daemon", "rotate-token", "--config-dir", "/tmp/c"], calls);

    expect(calls.statuses).toEqual([{ configDir: "/tmp/a", json: true }]);
    expect(calls.stops).toEqual([
      { configDir: "/tmp/b", expectedInstanceId: "instance", expectedPid: 42 },
    ]);
    expect(calls.rotations).toEqual([{ configDir: "/tmp/c" }]);
  });

  test("accepts the exact daemon arguments generated for OS services", async () => {
    const calls = emptyCalls();
    const [, ...args] = serviceProgramArguments({
      boot: false,
      configDir: "/tmp/selftune-service-fixture",
      executableArgsPrefix: [],
      executablePath: "/usr/local/bin/selftune",
      owner: "desktop",
      port: 7888,
      resourceDir: "/Applications/SelfTune.app/Contents/Resources/selftune",
      version: "1.0.0",
    });

    await runTestCommand(args, calls);

    expect(calls.runs).toEqual([
      {
        configDir: undefined,
        foreground: true,
        hostname: "127.0.0.1",
        owner: "desktop",
        port: 7888,
        readySentinel: false,
        runtimeMode: "standalone",
        serviceInstallationNonce: undefined,
        spaDir: "/Applications/SelfTune.app/Contents/Resources/selftune/dashboard",
        supervised: true,
      },
    ]);
  });

  test("rejects incomplete stop identity before invoking the handler", async () => {
    await Promise.all(
      [
        ["daemon", "stop", "--expected-pid", "42"],
        ["daemon", "stop", "--expected-instance-id", "instance"],
      ].map(async (args) => {
        const calls = emptyCalls();
        await expect(runTestCommand(args, calls)).rejects.toThrow("must be provided together");
        expect(calls.stops).toEqual([]);
      }),
    );
  });

  test("requires supervised service installation nonces before invoking the handler", async () => {
    const unsupervised = emptyCalls();
    await expect(
      runTestCommand(
        ["daemon", "run", "--service-installation-nonce", serviceInstallationNonce],
        unsupervised,
      ),
    ).rejects.toThrow("requires --supervised");
    expect(unsupervised.runs).toEqual([]);

    await Promise.all(
      ["short", "a".repeat(129), `${"a".repeat(31)}+`].map(async (nonce) => {
        const invalid = emptyCalls();
        await expect(
          runTestCommand(
            ["daemon", "run", "--supervised", "--service-installation-nonce", nonce],
            invalid,
          ),
        ).rejects.toThrow();
        expect(invalid.runs).toEqual([]);
      }),
    );
  });

  test("help wins at root and leaf commands without creating local state", () => {
    for (const args of [
      [],
      ["--help"],
      ["-h"],
      ["run", "--help"],
      ["run", "--help", "--port"],
      ["status", "--help"],
      ["stop", "--help"],
      ["rotate-token", "--help"],
    ]) {
      const home = makeHome();
      const result = runDaemonCli(home, ...args);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("selftune daemon");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("rejects removed token arguments and missing values before creating state", () => {
    const invalidArguments = [
      ["run", "--auth-token", "secret"],
      ["run", "--auth-token=secret"],
      ...[
        "--port",
        "--hostname",
        "--config-dir",
        "--spa-dir",
        "--owner",
        "--runtime-mode",
        "--service-installation-nonce",
      ].map((flag) => ["run", flag]),
      ["status", "--config-dir"],
      ["stop", "--expected-pid"],
      ["stop", "--expected-instance-id"],
      ["rotate-token", "--config-dir"],
    ];

    for (const args of invalidArguments) {
      const home = makeHome();
      const result = runDaemonCli(home, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toBe("");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }

    const home = makeHome();
    const removedToken = runDaemonCli(home, "run", "--auth-token=secret");
    expect(removedToken.stderr).toContain("process arguments are observable");
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("rejects malformed options and operands before creating state", () => {
    for (const args of [
      ["run", "--port", "-1"],
      ["run", "--port", "1.5"],
      ["run", "--port", "3141junk"],
      ["run", "--port", "65536"],
      ["run", "--owner", "unknown"],
      ["run", "--runtime-mode", "unknown"],
      ["run", "--hostname", "0.0.0.0"],
      ["run", "--unknown"],
      ["run", "unexpected"],
      ["stop", "--expected-pid", "1", "--expected-instance-id", "instance"],
      ["stop", "--expected-pid", "42", "--expected-instance-id", ""],
    ]) {
      const home = makeHome();
      const result = runDaemonCli(home, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toBe("");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("live status is read-only and reports a missing daemon as JSON", () => {
    const home = makeHome();
    const result = runDaemonCli(home, "status", "--json");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ manifest: null, reachable: false });
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("SIGTERM releases the live daemon and the same config can start again", async () => {
    const home = makeHome();
    await runDaemonLifecycle(home);
    await runDaemonLifecycle(home);
  }, 30_000);

  test("direct daemon execution releases its scope on SIGTERM", async () => {
    await runDaemonLifecycle(makeHome(), DIRECT_DAEMON_ENTRYPOINT, []);
  }, 30_000);
});
