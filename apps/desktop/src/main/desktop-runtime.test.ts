import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
  DesktopRuntime,
  makeDesktopRuntimeLayer,
  type DesktopRuntimeCallbacks,
  type DesktopRuntimeDependencies,
  type DesktopRuntimeService,
} from "./desktop-runtime";
import type { SidecarConnection } from "./sidecar";
import { TrayHealthResponseSchema } from "./tray-state";

function connection(
  id: string,
  supervision: SidecarConnection["supervision"] = "desktop-child",
  owner: SidecarConnection["owner"] = "desktop",
): SidecarConnection {
  const port = 8_000 + Number(id.replace(/\D/g, "") || "0");
  return {
    authToken: `token-${id}`,
    baseUrl: `http://127.0.0.1:${port}`,
    child: null,
    instanceId: id,
    owner,
    ownerExecutablePath: `/runtime/${id}`,
    ownerVersion: "1.0.0",
    pid: port,
    port,
    supervision,
    stderrTail: () => "",
  };
}

function dependencies(
  overrides: Partial<DesktopRuntimeDependencies> = {},
): DesktopRuntimeDependencies {
  return {
    announceBackup: async () => undefined,
    attachExistingRuntime: async () => null,
    attachSupervisedSidecar: async () => null,
    canManageBackgroundService: false,
    configDir: "/tmp/selftune-desktop-runtime-test",
    confirmReset: async () => true,
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    getBackgroundStatus: () =>
      Effect.succeed({
        detail: [],
        pid: null,
        platform: "darwin",
        registered: false,
        running: false,
        supported: true,
      }),
    installBackgroundService: () => Effect.void,
    installRuntime: () => Effect.void,
    log: () => undefined,
    monitorFailureThreshold: 3,
    monitorIntervalMs: null,
    platform: "darwin",
    promptForBackgroundService: async () => false,
    readBackgroundPreference: () => false,
    resetState: () => ({ backupDir: "/tmp/selftune-backup", moved: [] }),
    restartBackgroundService: () => Effect.void,
    startSidecar: async () => connection("1"),
    stopBackgroundService: () => Effect.void,
    stopSidecar: async () => undefined,
    uninstallBackgroundService: () => Effect.void,
    version: "1.0.0",
    writeBackgroundPreference: () => undefined,
    ...overrides,
  };
}

function callbacks(events: string[] = []): DesktopRuntimeCallbacks {
  return {
    rebindConnection: async (active) => {
      events.push(`rebind:${active.instanceId}`);
    },
    onConnectionActivated: async (active) => {
      events.push(`activated:${active.instanceId}`);
    },
    onRecoveryFailed: async (cause) => {
      events.push(`recovery-failed:${cause instanceof Error ? cause.message : String(cause)}`);
    },
  };
}

async function loadService(
  runtime: ManagedRuntime.ManagedRuntime<DesktopRuntime, never>,
): Promise<DesktopRuntimeService> {
  return runtime.runPromise(
    Effect.gen(function* () {
      return yield* DesktopRuntime;
    }),
  );
}

describe("scoped desktop runtime", () => {
  it("boots one desktop child and stops only that owned child on disposal", async () => {
    const events: string[] = [];
    const stopped: string[] = [];
    const runtime = ManagedRuntime.make(
      makeDesktopRuntimeLayer(
        dependencies({
          installRuntime: () => Effect.sync(() => events.push("install")),
          startSidecar: async () => {
            events.push("start:child-1");
            return connection("1");
          },
          stopSidecar: async (active) => {
            stopped.push(active.instanceId);
          },
        }),
        callbacks(events),
      ),
    );
    const service = await loadService(runtime);

    await runtime.runPromise(service.boot);
    expect((await runtime.runPromise(service.connection))?.instanceId).toBe("1");
    await runtime.dispose();

    expect(events).toEqual(["install", "start:child-1", "rebind:1", "activated:1"]);
    expect(stopped).toEqual(["1"]);
  });

  it("preserves CLI-owned and OS-supervised runtimes on disposal", async () => {
    await Promise.all(
      [connection("11", "none", "cli"), connection("12", "os-service", "desktop")].map(
        async (active) => {
          const stopped: string[] = [];
          const registered = active.supervision === "os-service";
          const runtime = ManagedRuntime.make(
            makeDesktopRuntimeLayer(
              dependencies({
                canManageBackgroundService: true,
                getBackgroundStatus: () =>
                  Effect.succeed({
                    detail: [],
                    pid: active.pid,
                    platform: "darwin",
                    registered,
                    running: true,
                    supported: true,
                  }),
                attachExistingRuntime: async () => (registered ? null : active),
                attachSupervisedSidecar: async () => (registered ? active : null),
                stopSidecar: async (candidate) => {
                  stopped.push(candidate.instanceId);
                },
              }),
              callbacks(),
            ),
          );
          const service = await loadService(runtime);

          await runtime.runPromise(service.boot);
          await runtime.dispose();

          expect(stopped).toEqual([]);
        },
      ),
    );
  });

  it("queues explicit restarts instead of dropping an operation during a transition", async () => {
    let starts = 0;
    const stopped: string[] = [];
    const runtime = ManagedRuntime.make(
      makeDesktopRuntimeLayer(
        dependencies({
          startSidecar: async () => {
            starts += 1;
            await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
            return connection(String(starts));
          },
          stopSidecar: async (active) => {
            stopped.push(active.instanceId);
          },
        }),
        callbacks(),
      ),
    );
    const service = await loadService(runtime);
    await runtime.runPromise(service.boot);

    await Promise.all([runtime.runPromise(service.restart), runtime.runPromise(service.restart)]);

    expect(starts).toBe(3);
    expect(stopped).toEqual(["1", "2"]);
    expect((await runtime.runPromise(service.connection))?.instanceId).toBe("3");
    await runtime.dispose();
  });

  it("aborts startup and leaves pre-connection cleanup with the sidecar dependency", async () => {
    const started = Promise.withResolvers<void>();
    const abortObserved = Promise.withResolvers<void>();
    const cleanedDuringStartup: string[] = [];
    const stopped: string[] = [];
    const runtime = ManagedRuntime.make(
      makeDesktopRuntimeLayer(
        dependencies({
          startSidecar: (signal) =>
            new Promise<SidecarConnection>((_resolveStart, rejectStart) => {
              started.resolve();
              signal.addEventListener(
                "abort",
                () => {
                  cleanedDuringStartup.push("spawned-child");
                  abortObserved.resolve();
                  rejectStart(new Error("startup interrupted"));
                },
                { once: true },
              );
            }),
          stopSidecar: async (active) => {
            stopped.push(active.instanceId);
          },
        }),
        callbacks(),
      ),
    );
    const service = await loadService(runtime);
    const boot = runtime.runPromise(service.boot).catch(() => undefined);
    await started.promise;

    const shutdown = runtime.runPromise(service.shutdown);
    await abortObserved.promise;
    await Promise.all([boot, shutdown]);

    expect(cleanedDuringStartup).toEqual(["spawned-child"]);
    expect(stopped).toEqual([]);
    expect(await runtime.runPromise(service.connection)).toBeNull();
    await runtime.dispose();
  });

  it("interrupts sidecar startup when the managed runtime is disposed", async () => {
    const started = Promise.withResolvers<void>();
    const abortObserved = Promise.withResolvers<void>();
    const runtime = ManagedRuntime.make(
      makeDesktopRuntimeLayer(
        dependencies({
          startSidecar: (signal) =>
            new Promise<SidecarConnection>((_resolveStart, rejectStart) => {
              started.resolve();
              signal.addEventListener(
                "abort",
                () => {
                  abortObserved.resolve();
                  rejectStart(new Error("startup interrupted"));
                },
                { once: true },
              );
            }),
        }),
        callbacks(),
      ),
    );
    const service = await loadService(runtime);
    const boot = runtime.runPromise(service.boot).catch(() => undefined);
    await started.promise;

    await runtime.dispose();
    await Promise.all([abortObserved.promise, boot]);
  });

  it("stops a new child exactly once when its window rebind fails", async () => {
    let starts = 0;
    const stopped: string[] = [];
    const runtime = ManagedRuntime.make(
      makeDesktopRuntimeLayer(
        dependencies({
          startSidecar: async () => {
            starts += 1;
            return connection(String(starts));
          },
          stopSidecar: async (active) => {
            stopped.push(active.instanceId);
          },
        }),
        {
          ...callbacks(),
          rebindConnection: async (active) => {
            if (active.instanceId === "2") throw new Error("window reload failed");
          },
        },
      ),
    );
    const service = await loadService(runtime);
    await runtime.runPromise(service.boot);

    await expect(runtime.runPromise(service.restart)).rejects.toMatchObject({
      operation: "replace local service",
    });
    expect(stopped).toEqual(["1", "2"]);
    expect(await runtime.runPromise(service.connection)).toBeNull();

    await runtime.runPromise(service.shutdown);
    expect(stopped).toEqual(["1", "2"]);
    await runtime.dispose();
  });

  it("ignores a stale failed health probe after the connection generation changes", async () => {
    const probeStarted = Promise.withResolvers<void>();
    const releaseProbe = Promise.withResolvers<void>();
    const events: string[] = [];
    let probes = 0;
    let starts = 0;
    const runtime = ManagedRuntime.make(
      makeDesktopRuntimeLayer(
        dependencies({
          monitorFailureThreshold: 1,
          monitorIntervalMs: 2,
          fetch: async () => {
            probes += 1;
            if (probes === 1) {
              probeStarted.resolve();
              await releaseProbe.promise;
              return new Response(null, { status: 503 });
            }
            return new Response(null, { status: 200 });
          },
          startSidecar: async () => {
            starts += 1;
            return connection(String(starts));
          },
        }),
        callbacks(events),
      ),
    );
    const service = await loadService(runtime);
    await runtime.runPromise(service.boot);
    await probeStarted.promise;

    await runtime.runPromise(service.restart);
    releaseProbe.resolve();
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));

    expect(starts).toBe(2);
    expect(events.some((event) => event.startsWith("recovery-failed:"))).toBeFalse();
    expect((await runtime.runPromise(service.connection))?.instanceId).toBe("2");
    await runtime.dispose();
  });

  it("rejects malformed authenticated sidecar responses at the schema boundary", async () => {
    const runtime = ManagedRuntime.make(
      makeDesktopRuntimeLayer(
        dependencies({
          fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        }),
        callbacks(),
      ),
    );
    const service = await loadService(runtime);
    await runtime.runPromise(service.boot);

    await expect(
      runtime.runPromise(service.requestJson("/api/health", TrayHealthResponseSchema)),
    ).rejects.toMatchObject({ operation: "decode local API response" });
    await runtime.dispose();
  });

  it("restores a managed runtime after background installation fails without claiming success", async () => {
    let starts = 0;
    const preferences: boolean[] = [];
    const runtime = ManagedRuntime.make(
      makeDesktopRuntimeLayer(
        dependencies({
          canManageBackgroundService: true,
          installBackgroundService: () => Effect.fail(new Error("service install failed")),
          startSidecar: async () => {
            starts += 1;
            return connection(String(starts));
          },
          writeBackgroundPreference: (enabled) => {
            preferences.push(enabled);
          },
        }),
        callbacks(),
      ),
    );
    const service = await loadService(runtime);
    await runtime.runPromise(service.boot);
    preferences.length = 0;

    await expect(
      runtime.runPromise(service.setBackgroundServiceEnabled(true)),
    ).rejects.toMatchObject({ message: "service install failed" });

    expect(preferences).toEqual([]);
    expect(starts).toBe(2);
    expect((await runtime.runPromise(service.connection))?.instanceId).toBe("2");
    await runtime.dispose();
  });

  it("rejects lifecycle mutations through a retained service after shutdown", async () => {
    let starts = 0;
    const runtime = ManagedRuntime.make(
      makeDesktopRuntimeLayer(
        dependencies({
          startSidecar: async () => {
            starts += 1;
            return connection(String(starts));
          },
        }),
        callbacks(),
      ),
    );
    const service = await loadService(runtime);
    await runtime.runPromise(service.boot);
    await runtime.runPromise(service.shutdown);

    await expect(runtime.runPromise(service.restart)).rejects.toMatchObject({
      operation: "run desktop lifecycle operation",
    });
    expect(starts).toBe(1);
    await runtime.dispose();
  });

  it("interrupts an active background command before shutdown takes the transition permit", async () => {
    const installStarted = Promise.withResolvers<void>();
    const installInterrupted = Promise.withResolvers<void>();
    const runtime = ManagedRuntime.make(
      makeDesktopRuntimeLayer(
        dependencies({
          canManageBackgroundService: true,
          installBackgroundService: () =>
            Effect.gen(function* () {
              yield* Effect.sync(() => installStarted.resolve());
              return yield* Effect.never;
            }).pipe(Effect.ensuring(Effect.sync(() => installInterrupted.resolve()))),
        }),
        callbacks(),
      ),
    );
    const service = await loadService(runtime);
    await runtime.runPromise(service.boot);
    const enabling = runtime
      .runPromise(service.setBackgroundServiceEnabled(true))
      .catch(() => undefined);
    await installStarted.promise;

    await Promise.race([
      runtime.runPromise(service.shutdown),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("runtime shutdown did not interrupt the command")), 250),
      ),
    ]);
    await Promise.all([installInterrupted.promise, enabling]);
    await runtime.dispose();
  });
});
