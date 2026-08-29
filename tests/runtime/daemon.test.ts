import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  DaemonFailure,
  getDaemonStatus,
  manifestMatchesStopExpectation,
  parseDaemonRunOptions,
  resolveDaemonRunOptions,
  resolveStopExpectation,
  runDaemonProgram,
  runDaemonRotateTokenProgram,
  runDaemonStatusProgram,
  startDaemon,
  stopDaemon,
  type DaemonCommandProgramDependencies,
  type DaemonStartDependencies,
  type DaemonStopDependencies,
} from "@selftune/local/daemon";
import type { DaemonRunInput } from "@selftune/local/daemon-cli-contract";
import {
  localAuthPath,
  writeServerManifest,
  type ServerManifest,
} from "@selftune/local/local-runtime";

describe("daemon options", () => {
  const serviceInstallationNonce = "abcdefghijklmnopqrstuvwxyz_ABCDE";
  const originalEnvironment = {
    configDir: process.env.SELFTUNE_CONFIG_DIR,
    desktop: process.env.SELFTUNE_DESKTOP,
    owner: process.env.SELFTUNE_RUNTIME_OWNER,
    supervised: process.env.SELFTUNE_SUPERVISED,
  };
  const roots: string[] = [];

  function restoreEnvironment(
    name: keyof typeof originalEnvironment,
    environmentName: string,
  ): void {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[environmentName];
    else process.env[environmentName] = value;
  }

  function temporaryConfigRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "selftune-daemon-options-"));
    roots.push(root);
    process.env.SELFTUNE_CONFIG_DIR = root;
    delete process.env.SELFTUNE_DESKTOP;
    delete process.env.SELFTUNE_RUNTIME_OWNER;
    delete process.env.SELFTUNE_SUPERVISED;
    return root;
  }

  afterEach(() => {
    restoreEnvironment("configDir", "SELFTUNE_CONFIG_DIR");
    restoreEnvironment("desktop", "SELFTUNE_DESKTOP");
    restoreEnvironment("owner", "SELFTUNE_RUNTIME_OWNER");
    restoreEnvironment("supervised", "SELFTUNE_SUPERVISED");
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("parses the desktop supervised contract", () => {
    const configDir = temporaryConfigRoot();
    const options = parseDaemonRunOptions([
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
      "--config-dir",
      configDir,
      "--spa-dir",
      "/tmp/dashboard",
      "--supervised",
      "--service-installation-nonce",
      serviceInstallationNonce,
      "--owner",
      "desktop",
      "--ready-sentinel",
    ]);
    expect(options).toMatchObject({
      port: 0,
      hostname: "127.0.0.1",
      configDir,
      owner: "desktop",
      spaDir: "/tmp/dashboard",
      serviceInstallationNonce,
      supervision: "os-service",
      readySentinel: true,
      runtimeMode: "standalone",
    });
  });

  it("distinguishes CLI ownership from a desktop-managed child", () => {
    temporaryConfigRoot();
    const cli = parseDaemonRunOptions([]);
    const desktop = parseDaemonRunOptions(["--owner", "desktop"]);

    expect(cli).toMatchObject({ owner: "cli", supervision: "none" });
    expect(desktop).toMatchObject({
      owner: "desktop",
      supervision: "desktop-child",
    });
  });

  it("rejects an invalid port before starting the server", () => {
    temporaryConfigRoot();
    expect(() => parseDaemonRunOptions(["--port", "70000"])).toThrow(DaemonFailure);
  });

  it("validates service installation nonces and requires explicit supervision", () => {
    temporaryConfigRoot();
    expect(
      parseDaemonRunOptions([
        "--supervised",
        "--service-installation-nonce",
        serviceInstallationNonce,
      ]),
    ).toMatchObject({ serviceInstallationNonce, supervision: "os-service" });
    expect(() =>
      parseDaemonRunOptions(["--service-installation-nonce", serviceInstallationNonce]),
    ).toThrow("requires --supervised");
    for (const nonce of ["short", "a".repeat(129), `${"a".repeat(31)}+`]) {
      expect(() =>
        parseDaemonRunOptions(["--supervised", "--service-installation-nonce", nonce]),
      ).toThrow("32-128 base64url");
    }
  });

  it("validates every run value before token-backed startup", async () => {
    const configDir = temporaryConfigRoot();
    let started = false;
    const input: DaemonRunInput = {
      configDir,
      foreground: false,
      hostname: "0.0.0.0",
      port: 7888,
      readySentinel: false,
      supervised: false,
    };

    await expect(
      Effect.runPromise(
        runDaemonProgram(input, {
          resolveOptions: resolveDaemonRunOptions,
          start: () => {
            started = true;
            return Effect.fail(DaemonFailure.make({ operation: "start", message: "unexpected" }));
          },
        }),
      ),
    ).rejects.toThrow("only listen on 127.0.0.1");
    expect(started).toBe(false);
  });

  it("finalizes startup that completes while interruption is pending", async () => {
    temporaryConfigRoot();
    const enteredStartup = Promise.withResolvers<void>();
    const pendingStartup = Promise.withResolvers<{
      readonly shutdownRequested: Promise<void>;
      readonly stop: () => void;
    }>();
    let stops = 0;
    const input: DaemonRunInput = {
      foreground: true,
      readySentinel: false,
      supervised: false,
    };
    const fiber = Effect.runFork(
      runDaemonProgram(input, {
        resolveOptions: () => parseDaemonRunOptions([]),
        start: () =>
          Effect.acquireRelease(
            Effect.promise(() => {
              enteredStartup.resolve();
              return pendingStartup.promise;
            }),
            (handle) => Effect.sync(() => handle.stop()),
          ),
      }),
    );
    await enteredStartup.promise;

    const interruption = Effect.runPromise(Fiber.interrupt(fiber));
    pendingStartup.resolve({ shutdownRequested: Promise.resolve(), stop: () => (stops += 1) });
    await interruption;

    expect(stops).toBe(1);
  });

  it("returns from the daemon program when authenticated shutdown is requested", async () => {
    const shutdown = Promise.withResolvers<void>();
    const input: DaemonRunInput = {
      foreground: true,
      readySentinel: false,
      supervised: false,
    };
    const program = Effect.runPromise(
      runDaemonProgram(input, {
        resolveOptions: () => parseDaemonRunOptions([]),
        start: () => Effect.succeed({ shutdownRequested: shutdown.promise, stop: () => undefined }),
      }),
    );

    shutdown.resolve();
    await expect(program).resolves.toBeUndefined();
  });

  it("cleans the manifest, server, and lock when ready-sentinel output fails", async () => {
    const configDir = temporaryConfigRoot();
    const events: string[] = [];
    const options = resolveDaemonRunOptions({
      configDir,
      foreground: true,
      port: 0,
      readySentinel: true,
      supervised: false,
    });
    const dependencies: DaemonStartDependencies = {
      acquireLock: () => {
        events.push("lock:acquire");
        return {
          port: 0,
          stop: async () => {
            events.push("lock:stop");
          },
        };
      },
      createInstanceId: () => "instance-id",
      executablePath: "/usr/local/bin/selftune",
      installedVersion: () => "1.0.0",
      loadAuthToken: () => {
        events.push("token:load");
        return "token";
      },
      printReady: () => {
        events.push("ready:print");
        throw new Error("stdout closed");
      },
      processId: 42,
      reconcileSchedule: () => events.push("schedule:reconcile"),
      removeManifest: () => events.push("manifest:remove"),
      startServer: async () => {
        events.push("server:start");
        return { port: 4123, stop: () => events.push("server:stop") };
      },
      writeManifest: () => events.push("manifest:write"),
    };

    await expect(
      Effect.runPromise(Effect.scoped(startDaemon(options, dependencies))),
    ).rejects.toThrow("stdout closed");
    expect(events).toEqual([
      "lock:acquire",
      "schedule:reconcile",
      "token:load",
      "server:start",
      "manifest:write",
      "ready:print",
      "manifest:remove",
      "server:stop",
      "lock:stop",
    ]);
  });

  it("awaits runtime-lock release before reporting startup failure", async () => {
    const configDir = temporaryConfigRoot();
    const release = Promise.withResolvers<void>();
    let releaseStarted = false;
    let settled = false;
    const options = resolveDaemonRunOptions({
      configDir,
      foreground: true,
      readySentinel: false,
      supervised: false,
    });
    const dependencies: DaemonStartDependencies = {
      acquireLock: () => ({
        port: 0,
        stop: async () => {
          releaseStarted = true;
          await release.promise;
        },
      }),
      createInstanceId: () => "instance-id",
      executablePath: "/usr/local/bin/selftune",
      installedVersion: () => "1.0.0",
      loadAuthToken: () => {
        throw new Error("token load failed");
      },
      printReady: () => undefined,
      processId: 42,
      removeManifest: () => undefined,
      startServer: async () => {
        throw new Error("server must not start");
      },
      writeManifest: () => undefined,
    };

    const startup = Effect.runPromise(Effect.scoped(startDaemon(options, dependencies)));
    void startup.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Bun.sleep(0);

    expect(releaseStarted).toBe(true);
    expect(settled).toBe(false);
    release.resolve();
    await expect(startup).rejects.toThrow("token load failed");
  });

  it("finalizes a late-bound server when scoped startup is interrupted", async () => {
    const configDir = temporaryConfigRoot();
    const enteredStartup = Promise.withResolvers<void>();
    const pendingServer = Promise.withResolvers<{
      readonly port: number;
      readonly stop: () => void;
    }>();
    const events: string[] = [];
    const options = resolveDaemonRunOptions({
      configDir,
      foreground: true,
      readySentinel: false,
      supervised: false,
    });
    const dependencies: DaemonStartDependencies = {
      acquireLock: () => ({
        port: 0,
        stop: async () => {
          events.push("lock:stop");
        },
      }),
      createInstanceId: () => "instance-id",
      executablePath: "/usr/local/bin/selftune",
      installedVersion: () => "1.0.0",
      loadAuthToken: () => "token",
      printReady: () => undefined,
      processId: 42,
      removeManifest: () => events.push("manifest:remove"),
      startServer: () => {
        enteredStartup.resolve();
        return pendingServer.promise;
      },
      writeManifest: () => events.push("manifest:write"),
    };
    const fiber = Effect.runFork(Effect.scoped(startDaemon(options, dependencies)));
    await enteredStartup.promise;

    const interruption = Effect.runPromise(Fiber.interrupt(fiber));
    pendingServer.resolve({ port: 4123, stop: () => events.push("server:stop") });
    await interruption;

    expect(events).toEqual(["manifest:write", "manifest:remove", "server:stop", "lock:stop"]);
  });

  it("passes authenticated ownership identity to the dashboard health endpoint", async () => {
    const configDir = temporaryConfigRoot();
    const options = resolveDaemonRunOptions({
      configDir,
      foreground: true,
      owner: "desktop",
      readySentinel: false,
      serviceInstallationNonce,
      supervised: true,
    });
    let serverOptions: Parameters<DaemonStartDependencies["startServer"]>[0] | undefined;
    const dependencies: DaemonStartDependencies = {
      acquireLock: () => ({ port: 0, stop: () => undefined }),
      createInstanceId: () => "instance-id",
      executablePath: "/Applications/SelfTune.app/Contents/MacOS/SelfTune",
      installedVersion: () => "1.0.0",
      loadAuthToken: () => "token",
      printReady: () => undefined,
      processId: 42,
      removeManifest: () => undefined,
      startServer: async (input) => {
        serverOptions = input;
        return { port: 4123, stop: () => undefined };
      },
      writeManifest: () => undefined,
    };

    await Effect.runPromise(Effect.scoped(startDaemon(options, dependencies)));

    expect(serverOptions).toMatchObject({
      runtimeIdentity: {
        configDir,
        instanceId: "instance-id",
        owner: "desktop",
        supervision: "os-service",
        ownerExecutablePath: "/Applications/SelfTune.app/Contents/MacOS/SelfTune",
      },
    });
    expect(serverOptions?.runtimeIdentity?.serviceInstallationNonce).toBe(serviceInstallationNonce);
    expect(typeof serverOptions?.runtimeShutdown).toBe("function");
  });

  it("attempts every release when individual cleanup actions throw", async () => {
    const configDir = temporaryConfigRoot();
    const events: string[] = [];
    const options = resolveDaemonRunOptions({
      configDir,
      foreground: true,
      readySentinel: true,
      supervised: false,
    });
    const dependencies: DaemonStartDependencies = {
      acquireLock: () => ({
        port: 0,
        stop: async () => {
          events.push("lock:stop");
        },
      }),
      createInstanceId: () => "instance-id",
      executablePath: "/usr/local/bin/selftune",
      installedVersion: () => "1.0.0",
      loadAuthToken: () => "token",
      printReady: () => {
        throw new Error("sentinel failed");
      },
      processId: 42,
      removeManifest: () => {
        events.push("manifest:remove");
        throw new Error("manifest cleanup failed");
      },
      startServer: async () => ({
        port: 4123,
        stop: () => {
          events.push("server:stop");
          throw new Error("server cleanup failed");
        },
      }),
      writeManifest: () => undefined,
    };

    await expect(
      Effect.runPromise(Effect.scoped(startDaemon(options, dependencies))),
    ).rejects.toThrow("sentinel failed");
    expect(events).toEqual(["manifest:remove", "server:stop", "lock:stop"]);
  });

  it("does not create credentials while checking or stopping a live manifest", async () => {
    const configDir = temporaryConfigRoot();
    writeServerManifest(configDir, {
      version: 2,
      kind: "selftune-runtime",
      pid: process.pid,
      port: 7888,
      origin: "http://127.0.0.1:7888",
      started_at: new Date().toISOString(),
      owner: "cli",
      supervision: "none",
      owner_version: "1.0.0",
      owner_executable_path: process.execPath,
      instance_id: "123e4567-e89b-42d3-a456-426614174000",
    });

    const status = await Effect.runPromise(getDaemonStatus(configDir));
    expect(status.manifest?.pid).toBe(process.pid);
    expect(status.reachable).toBe(false);
    expect(existsSync(localAuthPath(configDir))).toBe(false);
    await expect(Effect.runPromise(stopDaemon(configDir))).rejects.toThrow(
      "local authentication is missing",
    );
    expect(existsSync(localAuthPath(configDir))).toBe(false);
  });

  it("validates stop expectations as an atomic pair", () => {
    expect(() => resolveStopExpectation({ expectedPid: 42 })).toThrow("must be provided together");
    expect(() =>
      resolveStopExpectation({ expectedInstanceId: "instance", expectedPid: 1 }),
    ).toThrow("Invalid expected daemon pid");
    expect(resolveStopExpectation({ expectedInstanceId: "instance", expectedPid: 42 })).toEqual({
      instanceId: "instance",
      pid: 42,
    });
  });

  it("binds shutdown to the authenticated instance instead of signaling a PID", async () => {
    const manifest: ServerManifest = {
      version: 2,
      kind: "selftune-runtime",
      pid: 4242,
      port: 7888,
      origin: "http://127.0.0.1:7888",
      started_at: "2026-07-16T00:00:00.000Z",
      owner: "desktop",
      supervision: "os-service",
      owner_version: "1.0.0",
      owner_executable_path: "C:\\Program Files\\SelfTune\\selftune.exe",
      instance_id: "11111111-1111-4111-8111-111111111111",
    };
    const successor: ServerManifest = {
      ...manifest,
      pid: 5000,
      instance_id: "22222222-2222-4222-8222-222222222222",
    };
    let current: ServerManifest | null = manifest;
    let requestedInstance: string | null = null;
    let shutdownOutcome: "accepted" | "instance-mismatch" = "instance-mismatch";
    const dependencies: DaemonStopDependencies = {
      isProcessAlive: () => true,
      manifestOwnsProcess: async () => true,
      now: () => 0,
      readAuthToken: () => "owner-token",
      readManifest: () => current,
      removeManifest: () => undefined,
      requestShutdown: async (observed) => {
        requestedInstance = observed.instance_id;
        current = shutdownOutcome === "accepted" ? null : successor;
        return shutdownOutcome;
      },
      sleep: async () => undefined,
    };

    expect(
      await Effect.runPromise(stopDaemon("C:\\Users\\test\\.selftune", undefined, dependencies)),
    ).toBe(false);
    expect(requestedInstance).toBe(manifest.instance_id);
    expect(current).toBe(successor);

    current = manifest;
    shutdownOutcome = "accepted";
    expect(
      await Effect.runPromise(stopDaemon("C:\\Users\\test\\.selftune", undefined, dependencies)),
    ).toBe(true);
  });

  it("formats status and token rotation through injected programs", async () => {
    const printed: string[] = [];
    const dependencies: DaemonCommandProgramDependencies = {
      getStatus: () => Effect.succeed({ manifest: null, reachable: false }),
      print: (message) => printed.push(message),
      resolveConfigDir: () => "/tmp/selftune",
      rotateToken: () => "rotated-token",
      stop: () => Effect.succeed(false),
    };

    await Effect.runPromise(runDaemonStatusProgram({ json: false }, dependencies));
    await Effect.runPromise(runDaemonStatusProgram({ json: true }, dependencies));
    await Effect.runPromise(runDaemonRotateTokenProgram({}, dependencies));

    expect(printed).toEqual([
      "SelfTune daemon is not running.",
      JSON.stringify({ manifest: null, reachable: false }),
      "SelfTune local authentication token rotated. Restart the daemon to apply it.",
    ]);
  });

  it("rejects non-loopback listeners and mismatched config roots", () => {
    const configDir = temporaryConfigRoot();
    expect(() => parseDaemonRunOptions(["--hostname", "0.0.0.0"])).toThrow(
      "only listen on 127.0.0.1",
    );
    expect(() => parseDaemonRunOptions(["--config-dir", `${configDir}-other`])).toThrow(
      "must match SELFTUNE_CONFIG_DIR",
    );
  });

  it("binds conditional cleanup to one runtime instance", () => {
    const manifest: ServerManifest = {
      version: 2,
      kind: "selftune-runtime",
      pid: 4242,
      port: 7888,
      origin: "http://127.0.0.1:7888",
      started_at: "2026-07-15T00:00:00.000Z",
      owner: "desktop",
      supervision: "desktop-child",
      owner_version: "0.3.0",
      owner_executable_path: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
      instance_id: "11111111-1111-4111-8111-111111111111",
    };

    expect(
      manifestMatchesStopExpectation(manifest, {
        instanceId: manifest.instance_id,
        pid: manifest.pid,
      }),
    ).toBe(true);
    expect(
      manifestMatchesStopExpectation(manifest, {
        instanceId: "22222222-2222-4222-8222-222222222222",
        pid: manifest.pid,
      }),
    ).toBe(false);
  });
});
