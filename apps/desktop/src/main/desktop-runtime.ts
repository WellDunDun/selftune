import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { BackgroundServiceStatus } from "./background-service";
import {
  replaceManagedConnection,
  type ManagedConnectionTransitionFailure,
} from "./managed-connection-lifecycle";
import type { ResetStateResult } from "./state-backup";
import {
  arbitrateRegisteredService,
  backgroundServiceEnabledFromRegistration,
} from "./runtime-ownership";
import type { SidecarConnection } from "./sidecar";

export const CONNECTION_MONITOR_INTERVAL_MS = 5_000;
export const CONNECTION_MONITOR_MISSES_BEFORE_RECOVERY = 3;

export interface DesktopBackgroundServiceState {
  readonly detail: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly platform: NodeJS.Platform;
  readonly running: boolean;
  readonly supported: boolean;
}

export interface DesktopRuntimeCallbacks {
  readonly rebindConnection: (connection: SidecarConnection) => Promise<void>;
  readonly onConnectionActivated: (connection: SidecarConnection) => Promise<void>;
  readonly onRecoveryFailed: (cause: unknown) => Promise<void>;
}

type DesktopRuntimeLogDetails =
  | DesktopRuntimeError
  | ResetStateResult
  | { readonly cleanupFailure: DesktopRuntimeError; readonly rebindFailure: DesktopRuntimeError }
  | {
      readonly attempt: number;
      readonly message?: string;
      readonly phase?: ManagedConnectionTransitionFailure["phase"];
    };

export interface DesktopRuntimeDependencies {
  readonly announceBackup: (backupDir: string) => Promise<void>;
  readonly attachExistingRuntime: () => Promise<SidecarConnection | null>;
  readonly attachSupervisedSidecar: () => Promise<SidecarConnection | null>;
  readonly canManageBackgroundService: boolean;
  readonly configDir: string;
  readonly confirmReset: () => Promise<boolean>;
  readonly fetch: (url: URL, init?: RequestInit) => Promise<Response>;
  readonly getBackgroundStatus: () => Effect.Effect<BackgroundServiceStatus, unknown>;
  readonly installBackgroundService: () => Effect.Effect<void, unknown>;
  readonly installRuntime: () => Effect.Effect<void, unknown>;
  readonly log: (
    level: "error" | "info" | "warn",
    message: string,
    details?: DesktopRuntimeLogDetails,
  ) => void;
  readonly monitorFailureThreshold: number;
  readonly monitorIntervalMs: number | null;
  readonly platform: NodeJS.Platform;
  readonly promptForBackgroundService: () => Promise<boolean>;
  readonly readBackgroundPreference: () => boolean | null;
  readonly resetState: () => ResetStateResult;
  readonly restartBackgroundService: () => Effect.Effect<void, unknown>;
  readonly startSidecar: (signal: AbortSignal) => Promise<SidecarConnection>;
  readonly stopBackgroundService: () => Effect.Effect<void, unknown>;
  readonly stopSidecar: (connection: SidecarConnection) => Promise<void>;
  readonly uninstallBackgroundService: () => Effect.Effect<void, unknown>;
  readonly version: string;
  readonly writeBackgroundPreference: (enabled: boolean) => void;
}

export class DesktopRuntimeError extends Schema.TaggedErrorClass<DesktopRuntimeError>()(
  "DesktopRuntimeError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface DesktopRuntimeService {
  readonly backgroundServiceState: Effect.Effect<DesktopBackgroundServiceState>;
  readonly boot: Effect.Effect<void, DesktopRuntimeError>;
  readonly connection: Effect.Effect<SidecarConnection | null>;
  readonly prepareForUpdate: Effect.Effect<void, DesktopRuntimeError>;
  readonly requestJson: <S extends Schema.Decoder<unknown, never>>(
    pathname: string,
    schema: S,
    init?: RequestInit,
  ) => Effect.Effect<S["Type"], DesktopRuntimeError>;
  readonly resetLocalState: Effect.Effect<boolean, DesktopRuntimeError>;
  readonly restart: Effect.Effect<void, DesktopRuntimeError>;
  readonly setBackgroundServiceEnabled: (
    enabled: boolean,
  ) => Effect.Effect<void, DesktopRuntimeError>;
  readonly shutdown: Effect.Effect<void>;
}

export class DesktopRuntime extends Context.Service<DesktopRuntime, DesktopRuntimeService>()(
  "SelfTune/DesktopRuntime",
) {}

interface RuntimeState {
  readonly backgroundServiceEnabled: boolean;
  readonly connection: SidecarConnection | null;
  readonly generation: number;
  readonly misses: number;
  readonly quitting: boolean;
  readonly recoveringGeneration: number | null;
}

function runtimeError(operation: string, cause: unknown): DesktopRuntimeError {
  return DesktopRuntimeError.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function attempt<A>(
  operation: string,
  task: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, DesktopRuntimeError> {
  return Effect.tryPromise({
    try: task,
    catch: (cause) => runtimeError(operation, cause),
  });
}

function attemptEffect<A, E>(
  operation: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, DesktopRuntimeError> {
  return effect.pipe(Effect.mapError((cause) => runtimeError(operation, cause)));
}

function attemptSync<A>(operation: string, task: () => A): Effect.Effect<A, DesktopRuntimeError> {
  return Effect.try({
    try: task,
    catch: (cause) => runtimeError(operation, cause),
  });
}

const LocalApiTextError = Schema.Struct({ error: Schema.String });
const LocalApiStructuredError = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

function responseError(payload: Schema.Json, status: number): string {
  const text = Option.getOrNull(Schema.decodeUnknownOption(LocalApiTextError)(payload));
  if (text) return text.error;
  const structured = Option.getOrNull(Schema.decodeUnknownOption(LocalApiStructuredError)(payload));
  return structured?.error.message ?? `SelfTune local API request failed (${status}).`;
}

function isCliOwnedStandalone(connection: SidecarConnection | null): boolean {
  return connection?.owner === "cli" && connection.supervision === "none";
}

export function makeDesktopRuntimeLayer(
  dependencies: DesktopRuntimeDependencies,
  callbacks: DesktopRuntimeCallbacks,
) {
  return Layer.effect(
    DesktopRuntime,
    Effect.gen(function* () {
      const state = yield* Ref.make<RuntimeState>({
        backgroundServiceEnabled: false,
        connection: null,
        generation: 0,
        misses: 0,
        quitting: false,
        recoveringGeneration: null,
      });
      const transition = yield* Semaphore.make(1);
      const shutdownRequested = yield* Deferred.make<void>();
      const scope = yield* Effect.scope;
      const startupController = new AbortController();
      const pendingManagedSidecars = new Set<SidecarConnection>();
      const stoppedManagedSidecars = new WeakSet<SidecarConnection>();

      const log = (
        level: "error" | "info" | "warn",
        message: string,
        details?: DesktopRuntimeLogDetails,
      ) => Effect.sync(() => dependencies.log(level, message, details));

      const runMutation = <A>(effect: Effect.Effect<A, DesktopRuntimeError>) =>
        Effect.raceFirst(
          transition.withPermit(
            Ref.get(state).pipe(
              Effect.flatMap((current) =>
                current.quitting
                  ? Effect.fail(
                      runtimeError("run desktop lifecycle operation", "SelfTune is shutting down."),
                    )
                  : effect,
              ),
            ),
          ),
          Deferred.await(shutdownRequested).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                runtimeError("run desktop lifecycle operation", "SelfTune is shutting down."),
              ),
            ),
          ),
        );

      const refreshBackgroundServiceStatus = Effect.fn(
        "SelfTuneDesktop.refreshBackgroundServiceStatus",
      )(function* () {
        const status = yield* attemptEffect(
          "read background service status",
          dependencies.getBackgroundStatus(),
        );
        yield* Ref.update(state, (current) => ({
          ...current,
          backgroundServiceEnabled: backgroundServiceEnabledFromRegistration(status.registered),
        }));
        return status;
      });

      const waitForSupervisedSidecar = Effect.fn("SelfTuneDesktop.waitForSupervisedSidecar")(
        function* (timeoutMs: number) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const attached = yield* attempt(
              "attach to supervised service",
              dependencies.attachSupervisedSidecar,
            );
            if (attached) return attached;
            yield* Effect.sleep(300);
          }
          return yield* attempt(
            "attach to supervised service",
            dependencies.attachSupervisedSidecar,
          );
        },
      );

      const installAndAttachBackgroundService = Effect.fn(
        "SelfTuneDesktop.installAndAttachBackgroundService",
      )(function* () {
        yield* attemptEffect("install background service", dependencies.installBackgroundService());
        const status = yield* refreshBackgroundServiceStatus();
        if (!status.registered) {
          return yield* Effect.fail(
            runtimeError(
              "install background service",
              "The background service was not registered.",
            ),
          );
        }
        const attached = yield* waitForSupervisedSidecar(15_000);
        if (!attached) {
          return yield* Effect.fail(
            runtimeError(
              "install background service",
              "The background service did not become ready.",
            ),
          );
        }
        return attached;
      });

      const detachConnection = (candidate: SidecarConnection) =>
        Ref.update(state, (current) =>
          current.connection === candidate
            ? {
                ...current,
                connection: null,
                generation: current.generation + 1,
                misses: 0,
                recoveringGeneration: null,
              }
            : current,
        );

      const startManagedSidecar = Effect.fn("SelfTuneDesktop.startManagedSidecar")(function* () {
        const candidate = yield* attempt("start local service", (effectSignal) =>
          dependencies.startSidecar(AbortSignal.any([startupController.signal, effectSignal])),
        );
        yield* Effect.sync(() => pendingManagedSidecars.add(candidate));
        const current = yield* Ref.get(state);
        if (current.quitting || startupController.signal.aborted) {
          yield* stopTrackedSidecar(candidate);
          return yield* Effect.fail(
            runtimeError(
              "start local service",
              "SelfTune local server startup was cancelled during shutdown.",
            ),
          );
        }
        return candidate;
      });

      const stopTrackedSidecar = Effect.fn("SelfTuneDesktop.stopTrackedSidecar")(function* (
        candidate: SidecarConnection,
      ) {
        if (yield* Effect.sync(() => stoppedManagedSidecars.has(candidate))) return;
        yield* attempt("stop local service", () => dependencies.stopSidecar(candidate));
        yield* Effect.sync(() => {
          pendingManagedSidecars.delete(candidate);
          stoppedManagedSidecars.add(candidate);
        });
      });

      const probeConnection = (connection: SidecarConnection) =>
        attempt("probe local service", () =>
          dependencies.fetch(new URL("/api/health", connection.baseUrl), {
            headers: { Authorization: `Bearer ${connection.authToken}` },
            signal: AbortSignal.timeout(2_000),
          }),
        ).pipe(
          Effect.map((response) => response.ok),
          Effect.catch(() => Effect.succeed(false)),
        );

      function recoverAfterSignal(generation: number, cause: unknown): Effect.Effect<void, never> {
        return Effect.gen(function* () {
          const claimed = yield* Ref.modify(state, (current) => {
            if (
              current.quitting ||
              current.generation !== generation ||
              current.recoveringGeneration === generation
            ) {
              return [false, current] as const;
            }
            return [true, { ...current, recoveringGeneration: generation }] as const;
          });
          if (!claimed) return;

          const recovery = yield* Effect.result(runMutation(recoverManagedConnection(generation)));
          if (Result.isSuccess(recovery)) return;

          const current = yield* Ref.get(state);
          if (current.quitting || current.generation !== generation) return;
          yield* attempt("show local service recovery", () =>
            callbacks.onRecoveryFailed(recovery.failure ?? cause),
          ).pipe(
            Effect.catch((failure) =>
              log("error", "SelfTune could not show the runtime recovery screen", failure),
            ),
          );
        });
      }

      const monitorManagedConnection = Effect.fn("SelfTuneDesktop.monitorManagedConnection")(
        function* (connection: SidecarConnection, generation: number) {
          const child = connection.child;
          if (!child) return;
          const exit = Effect.callback<{
            readonly code: number | null;
            readonly signal: string | null;
          }>((resume) => {
            const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
              resume(Effect.succeed({ code, signal }));
            };
            child.once("exit", onExit);
            return Effect.sync(() => child.off("exit", onExit));
          });
          yield* Effect.forkIn(
            exit.pipe(
              Effect.flatMap(({ code, signal }) =>
                recoverAfterSignal(
                  generation,
                  new Error(
                    `The local service exited unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"}). ${connection.stderrTail()}`,
                  ),
                ),
              ),
            ),
            scope,
          );
        },
      );

      const activateConnection = Effect.fn("SelfTuneDesktop.activateConnection")(function* (
        nextConnection: SidecarConnection,
      ) {
        const wasPendingManagedSidecar = yield* Effect.sync(() =>
          pendingManagedSidecars.has(nextConnection),
        );
        const before = yield* Ref.get(state);
        if (before.quitting) {
          if (wasPendingManagedSidecar) yield* stopTrackedSidecar(nextConnection);
          return yield* Effect.fail(
            runtimeError(
              "activate local service",
              "SelfTune connection activation was cancelled during shutdown.",
            ),
          );
        }

        const rebound = yield* Effect.result(
          attempt("rebind desktop window", () => callbacks.rebindConnection(nextConnection)),
        );
        if (Result.isFailure(rebound)) {
          if (wasPendingManagedSidecar) {
            yield* stopTrackedSidecar(nextConnection).pipe(
              Effect.catch((cleanupFailure) =>
                log("warn", "SelfTune could not clean up a failed connection candidate", {
                  cleanupFailure,
                  rebindFailure: rebound.failure,
                }),
              ),
            );
          }
          return yield* Effect.fail(rebound.failure);
        }
        const generation = before.generation + 1;
        yield* Ref.set(state, {
          ...before,
          connection: nextConnection,
          generation,
          misses: 0,
          recoveringGeneration: null,
        });
        yield* Effect.sync(() => pendingManagedSidecars.delete(nextConnection));
        yield* monitorManagedConnection(nextConnection, generation);

        const previousConnection = before.connection;
        if (previousConnection && previousConnection !== nextConnection) {
          if (previousConnection.supervision === "desktop-child") {
            yield* Effect.sync(() => pendingManagedSidecars.add(previousConnection));
          }
          yield* stopTrackedSidecar(previousConnection).pipe(
            Effect.catch((failure) =>
              log("warn", "SelfTune could not stop the previous local runtime", failure),
            ),
          );
        }
        yield* attempt("refresh desktop connection state", () =>
          callbacks.onConnectionActivated(nextConnection),
        ).pipe(
          Effect.catch((failure) =>
            log("warn", "SelfTune could not refresh desktop connection state", failure),
          ),
        );
      });

      const attachRegisteredBackgroundService = Effect.fn(
        "SelfTuneDesktop.attachRegisteredBackgroundService",
      )(function* () {
        let attached = yield* attempt(
          "attach to registered service",
          dependencies.attachSupervisedSidecar,
        );
        if (!attached) {
          yield* attemptEffect(
            "restart registered service",
            dependencies.restartBackgroundService(),
          );
          attached = yield* waitForSupervisedSidecar(15_000);
        }
        if (!attached) {
          return yield* Effect.fail(
            runtimeError(
              "attach to registered service",
              "The registered background service could not be reached; preserving its installed owner.",
            ),
          );
        }
        const arbitration = arbitrateRegisteredService(
          {
            owner: attached.owner,
            ownerVersion: attached.ownerVersion,
            supervision: attached.supervision,
          },
          dependencies.version,
        );
        if (arbitration === "attach") return attached;

        const current = yield* Ref.get(state);
        if (current.connection?.supervision === "os-service") {
          yield* detachConnection(current.connection);
        }
        return yield* installAndAttachBackgroundService();
      });

      const ensureBackgroundService = Effect.fn("SelfTuneDesktop.ensureBackgroundService")(
        function* () {
          if (!dependencies.canManageBackgroundService) return null;
          const ensured = yield* Effect.result(
            Effect.gen(function* () {
              const status = yield* refreshBackgroundServiceStatus();
              if (status.registered) {
                const attached = yield* attachRegisteredBackgroundService();
                yield* attemptSync("remember background service preference", () =>
                  dependencies.writeBackgroundPreference(true),
                );
                return attached;
              }

              const existingRuntime = yield* attempt(
                "attach to existing local runtime",
                dependencies.attachExistingRuntime,
              );
              if (existingRuntime) return existingRuntime;

              let preference = yield* attemptSync("read background service preference", () =>
                dependencies.readBackgroundPreference(),
              );
              if (preference === null) {
                preference = yield* attempt(
                  "choose background service preference",
                  dependencies.promptForBackgroundService,
                );
                if (!preference) {
                  yield* attemptSync("remember background service preference", () =>
                    dependencies.writeBackgroundPreference(false),
                  );
                }
              }
              if (!preference) return null;

              const installed = yield* installAndAttachBackgroundService();
              yield* attemptSync("remember background service preference", () =>
                dependencies.writeBackgroundPreference(true),
              );
              return installed;
            }),
          );
          if (Result.isSuccess(ensured)) return ensured.success;

          yield* log("warn", "[service] unavailable; using managed runtime", ensured.failure);
          yield* refreshBackgroundServiceStatus().pipe(
            Effect.catch((failure) =>
              log("warn", "[service] could not refresh registration state", failure),
            ),
          );
          return yield* attempt(
            "attach to existing local runtime",
            dependencies.attachExistingRuntime,
          );
        },
      );

      const replaceManagedSidecar = Effect.fn("SelfTuneDesktop.replaceManagedSidecar")(function* (
        maxAttempts: number,
      ) {
        const result = yield* replaceManagedConnection<SidecarConnection, DesktopRuntimeError>(
          {
            activate: activateConnection,
            current: Ref.get(state).pipe(Effect.map((current) => current.connection)),
            detach: detachConnection,
            onAttemptFailure: (failure: ManagedConnectionTransitionFailure) =>
              log("warn", "SelfTune managed runtime replacement attempt failed", {
                attempt: failure.attempt,
                message: failure.message,
                phase: failure.phase,
              }),
            start: startManagedSidecar,
            stop: stopTrackedSidecar,
          },
          {
            maxAttempts,
            retryDelayMs: (failedAttempt) => failedAttempt * 750,
          },
        ).pipe(Effect.mapError((cause) => runtimeError("replace local service", cause)));
        return result.attempt;
      });

      function recoverManagedConnection(
        failingGeneration: number,
      ): Effect.Effect<void, DesktopRuntimeError> {
        return Effect.gen(function* () {
          const snapshot = yield* Ref.get(state);
          if (
            snapshot.quitting ||
            snapshot.generation !== failingGeneration ||
            snapshot.connection === null
          ) {
            return;
          }
          const activeConnection = snapshot.connection;
          if (isCliOwnedStandalone(activeConnection)) {
            const reattached = yield* attempt(
              "reattach to CLI-owned runtime",
              dependencies.attachExistingRuntime,
            );
            if (reattached) {
              yield* activateConnection(reattached);
              yield* log("info", "SelfTune reattached to the CLI-owned local runtime");
              return;
            }
            const replacement = yield* Effect.result(
              startManagedSidecar().pipe(Effect.flatMap(activateConnection)),
            );
            if (Result.isSuccess(replacement)) {
              yield* log("info", "SelfTune replaced an exited CLI-owned local runtime");
              return;
            }
            return yield* Effect.fail(
              runtimeError(
                "recover CLI-owned runtime",
                "The CLI-owned SelfTune runtime is still holding the singleton but is not healthy. Restart it from the CLI before retrying the desktop connection.",
              ),
            );
          }

          if (
            activeConnection.supervision !== "os-service" ||
            !dependencies.canManageBackgroundService
          ) {
            const attemptNumber = yield* replaceManagedSidecar(3);
            yield* log("info", "SelfTune local runtime recovered", {
              attempt: attemptNumber,
            });
            return;
          }

          const status = yield* refreshBackgroundServiceStatus();
          if (!status.registered) {
            const attemptNumber = yield* replaceManagedSidecar(3);
            yield* log("info", "SelfTune local runtime recovered", {
              attempt: attemptNumber,
            });
            return;
          }

          let lastFailure = runtimeError(
            "recover background service",
            "The local service did not recover.",
          );
          for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
            const recovered = yield* Effect.result(
              Effect.gen(function* () {
                let nextConnection = yield* waitForSupervisedSidecar(2_000);
                if (!nextConnection) {
                  yield* attemptEffect(
                    "restart background service",
                    dependencies.restartBackgroundService(),
                  );
                  nextConnection = yield* waitForSupervisedSidecar(6_000);
                }
                if (!nextConnection) {
                  return yield* Effect.fail(
                    runtimeError(
                      "recover background service",
                      "The supervised service did not become ready.",
                    ),
                  );
                }
                yield* activateConnection(nextConnection);
              }),
            );
            if (Result.isSuccess(recovered)) {
              yield* log("info", "SelfTune local runtime recovered", {
                attempt: attemptNumber,
              });
              return;
            }
            lastFailure = recovered.failure;
            yield* log("warn", "SelfTune local runtime recovery attempt failed", {
              attempt: attemptNumber,
              message: lastFailure.message,
            });
            if (attemptNumber < 3) yield* Effect.sleep(attemptNumber * 750);
          }
          return yield* Effect.fail(lastFailure);
        });
      }

      const restartInternal = Effect.fn("SelfTuneDesktop.restartLocalService")(function* () {
        const current = yield* Ref.get(state);
        if (isCliOwnedStandalone(current.connection)) {
          return yield* Effect.fail(
            runtimeError(
              "restart local service",
              "This SelfTune runtime is owned by the CLI. Stop or restart it from the CLI before starting a desktop-managed runtime.",
            ),
          );
        }
        if (
          current.connection?.supervision === "os-service" &&
          dependencies.canManageBackgroundService
        ) {
          yield* attemptEffect(
            "restart background service",
            dependencies.restartBackgroundService(),
          );
          const nextConnection = yield* waitForSupervisedSidecar(15_000);
          if (!nextConnection) {
            return yield* Effect.fail(
              runtimeError(
                "restart background service",
                "The background service did not become ready.",
              ),
            );
          }
          yield* activateConnection(nextConnection);
          return;
        }
        yield* replaceManagedSidecar(1);
      });

      const setBackgroundServiceEnabledInternal = Effect.fn(
        "SelfTuneDesktop.setBackgroundServiceEnabled",
      )(function* (enabled: boolean) {
        if (!dependencies.canManageBackgroundService) return;
        if (enabled) {
          const status = yield* refreshBackgroundServiceStatus();
          const current = yield* Ref.get(state);
          const previous = current.connection;
          if (previous?.supervision === "desktop-child" || !status.registered) {
            if (previous) {
              yield* stopTrackedSidecar(previous);
              yield* detachConnection(previous);
            }
          }
          if (status.registered) {
            const attached = yield* attachRegisteredBackgroundService();
            yield* activateConnection(attached);
            yield* attemptSync("remember background service preference", () =>
              dependencies.writeBackgroundPreference(true),
            );
            return;
          }

          const installed = yield* Effect.result(
            installAndAttachBackgroundService().pipe(Effect.flatMap(activateConnection)),
          );
          if (Result.isSuccess(installed)) {
            yield* attemptSync("remember background service preference", () =>
              dependencies.writeBackgroundPreference(true),
            );
            return;
          }

          yield* attemptEffect(
            "clean up background service installation",
            dependencies.uninstallBackgroundService(),
          ).pipe(
            Effect.catch((failure) =>
              log("warn", "[service] failed installation cleanup", failure),
            ),
          );
          yield* refreshBackgroundServiceStatus().pipe(
            Effect.catch((failure) =>
              log("warn", "[service] failed cleanup status refresh", failure),
            ),
          );
          const afterCleanup = yield* Ref.get(state);
          if (!afterCleanup.connection) {
            const existingRuntime = yield* attempt(
              "attach to existing local runtime",
              dependencies.attachExistingRuntime,
            );
            const fallback = existingRuntime ?? (yield* startManagedSidecar());
            yield* activateConnection(fallback);
          }
          return yield* Effect.fail(installed.failure);
        }

        yield* attemptEffect(
          "uninstall background service",
          dependencies.uninstallBackgroundService(),
        );
        yield* refreshBackgroundServiceStatus();
        yield* attemptSync("remember background service preference", () =>
          dependencies.writeBackgroundPreference(false),
        );
        const current = yield* Ref.get(state);
        if (current.connection?.supervision === "os-service") {
          yield* activateConnection(yield* startManagedSidecar());
        }
      });

      const backgroundServiceState = Effect.gen(function* () {
        if (!dependencies.canManageBackgroundService) {
          return {
            detail: ["Background service management is available in installed desktop builds."],
            enabled: false,
            platform: dependencies.platform,
            running: false,
            supported: false,
          } satisfies DesktopBackgroundServiceState;
        }
        const status = yield* Effect.result(refreshBackgroundServiceStatus());
        if (Result.isSuccess(status)) {
          return {
            detail: status.success.detail,
            enabled: status.success.registered,
            platform: dependencies.platform,
            running: status.success.running,
            supported: status.success.supported,
          } satisfies DesktopBackgroundServiceState;
        }
        const current = yield* Ref.get(state);
        return {
          detail: [status.failure.message],
          enabled: current.backgroundServiceEnabled,
          platform: dependencies.platform,
          running: false,
          supported: true,
        } satisfies DesktopBackgroundServiceState;
      });

      const resetLocalStateInternal = Effect.fn("SelfTuneDesktop.resetLocalState")(function* () {
        const confirmed = yield* attempt("confirm local state reset", dependencies.confirmReset);
        if (!confirmed) return false;

        const current = yield* Ref.get(state);
        const activeConnection = current.connection;
        if (isCliOwnedStandalone(activeConnection)) {
          return yield* Effect.fail(
            runtimeError(
              "reset local state",
              "The CLI-owned SelfTune runtime must be stopped before the desktop can reset local state.",
            ),
          );
        }
        const useSupervisedService =
          activeConnection?.supervision === "os-service" && dependencies.canManageBackgroundService;
        if (useSupervisedService) {
          yield* attemptEffect("stop background service", dependencies.stopBackgroundService());
        } else if (activeConnection) {
          yield* stopTrackedSidecar(activeConnection);
        }
        if (activeConnection) yield* detachConnection(activeConnection);
        const reset = yield* attemptSync("back up and reset local state", dependencies.resetState);
        yield* log("info", "[reset-state] moved SelfTune state to backup", reset);

        let nextConnection: SidecarConnection;
        if (useSupervisedService) {
          yield* attemptEffect(
            "restart background service",
            dependencies.restartBackgroundService(),
          );
          yield* refreshBackgroundServiceStatus();
          const supervised = yield* waitForSupervisedSidecar(15_000);
          if (!supervised) {
            return yield* Effect.fail(
              runtimeError(
                "reset local state",
                "The background service did not restart after reset.",
              ),
            );
          }
          nextConnection = supervised;
        } else {
          nextConnection = yield* startManagedSidecar();
        }
        yield* activateConnection(nextConnection);
        yield* attempt("announce local state backup", () =>
          dependencies.announceBackup(reset.backupDir),
        );
        return true;
      });

      const prepareForUpdateInternal = Effect.fn("SelfTuneDesktop.prepareForUpdate")(function* () {
        const current = yield* Ref.get(state);
        const activeConnection = current.connection;
        if (
          activeConnection?.supervision === "os-service" &&
          dependencies.canManageBackgroundService
        ) {
          yield* attemptEffect(
            "stop background service for update",
            dependencies.stopBackgroundService(),
          );
        } else if (activeConnection) {
          yield* stopTrackedSidecar(activeConnection);
        }
        if (activeConnection) yield* detachConnection(activeConnection);
      });

      const requestJson = <S extends Schema.Decoder<unknown, never>>(
        pathname: string,
        schema: S,
        init?: RequestInit,
      ): Effect.Effect<S["Type"], DesktopRuntimeError> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const activeConnection = current.connection;
          if (!activeConnection) {
            return yield* Effect.fail(
              runtimeError("request local API", "SelfTune local service is not running."),
            );
          }

          const headers = new Headers(init?.headers);
          headers.set("Authorization", `Bearer ${activeConnection.authToken}`);
          if (init?.body) headers.set("Content-Type", "application/json");
          if (init?.method && init.method !== "GET") {
            headers.set("Origin", new URL(activeConnection.baseUrl).origin);
          }
          const response = yield* attempt("request local API", () =>
            dependencies.fetch(new URL(pathname, activeConnection.baseUrl), {
              ...init,
              headers,
            }),
          );
          const payload = yield* attempt("decode local API response", () => response.json());
          if (!response.ok) {
            return yield* Effect.fail(
              runtimeError("request local API", responseError(payload, response.status)),
            );
          }
          return yield* Schema.decodeUnknownEffect(schema)(payload).pipe(
            Effect.mapError((cause) => runtimeError("decode local API response", cause)),
          );
        });

      const bootInternal = Effect.fn("SelfTuneDesktop.boot")(function* () {
        yield* attemptEffect("install stable desktop runtime", dependencies.installRuntime());
        const initialConnection =
          (yield* ensureBackgroundService()) ?? (yield* startManagedSidecar());
        yield* activateConnection(initialConnection);
      });

      const shutdown = Effect.gen(function* () {
        yield* Ref.update(state, (current) => ({ ...current, quitting: true }));
        yield* Effect.sync(() => startupController.abort());
        yield* Deferred.succeed(shutdownRequested, undefined);
        yield* transition.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const cleanupTargets = new Set(pendingManagedSidecars);
            if (current.connection?.supervision === "desktop-child") {
              cleanupTargets.add(current.connection);
            }
            yield* Ref.set(state, {
              ...current,
              connection: null,
              generation: current.generation + 1,
              misses: 0,
              quitting: true,
              recoveringGeneration: null,
            });
            yield* Effect.all(
              [...cleanupTargets].map((candidate) =>
                stopTrackedSidecar(candidate).pipe(
                  Effect.catch((failure) =>
                    log("warn", "SelfTune could not stop a desktop-owned runtime", failure),
                  ),
                ),
              ),
              { concurrency: "unbounded" },
            );
          }),
        );
      });

      if (dependencies.monitorIntervalMs !== null) {
        const monitorCycle = Effect.gen(function* () {
          yield* Effect.sleep(dependencies.monitorIntervalMs ?? CONNECTION_MONITOR_INTERVAL_MS);
          const snapshot = yield* Ref.get(state);
          if (snapshot.quitting || !snapshot.connection) return;
          const generation = snapshot.generation;
          const connection = snapshot.connection;
          const healthy = yield* probeConnection(connection);
          const shouldRecover = yield* Ref.modify(state, (current) => {
            if (
              current.quitting ||
              current.connection !== connection ||
              current.generation !== generation ||
              current.recoveringGeneration === generation
            ) {
              return [false, current] as const;
            }
            if (healthy) return [false, { ...current, misses: 0 }] as const;
            const misses = current.misses + 1;
            return [
              misses >= dependencies.monitorFailureThreshold,
              { ...current, misses },
            ] as const;
          });
          if (shouldRecover) {
            yield* recoverAfterSignal(
              generation,
              new Error(`The local service stopped responding at ${connection.baseUrl}.`),
            );
          }
        });
        yield* Effect.forkScoped(Effect.forever(monitorCycle));
      }

      const service: DesktopRuntimeService = {
        backgroundServiceState,
        boot: runMutation(bootInternal()),
        connection: Ref.get(state).pipe(Effect.map((current) => current.connection)),
        prepareForUpdate: runMutation(prepareForUpdateInternal()),
        requestJson,
        resetLocalState: runMutation(resetLocalStateInternal()),
        restart: runMutation(restartInternal()),
        setBackgroundServiceEnabled: (enabled) =>
          runMutation(setBackgroundServiceEnabledInternal(enabled)),
        shutdown,
      };

      return yield* Effect.acquireRelease(Effect.succeed(service), () => shutdown);
    }),
  );
}
