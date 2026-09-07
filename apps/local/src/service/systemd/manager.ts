import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { ServiceFailure } from "../../service-contract.js";

import type { ServiceProcessResult } from "../../service-process.js";

export interface SystemdManagerState {
  readonly loaded: boolean;
  readonly mainPid: number | null;
  readonly running: boolean;
  readonly unitFileState: string;
}

export interface SystemdManager<E> {
  readonly inspect: () => Effect.Effect<SystemdManagerState, E>;
  readonly stop: () => Effect.Effect<void, E>;
  readonly uninstall: (unitFileExists: boolean) => Effect.Effect<void, E>;
}

export interface SystemdManagerDependencies<E> {
  readonly failure: (operation: string, cause: unknown) => E;
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<ServiceProcessResult, E>;
  readonly unitName: string;
}

const ABSENT_STATE: SystemdManagerState = {
  loaded: false,
  mainPid: null,
  running: false,
  unitFileState: "not-found",
};

const ENABLED_UNIT_FILE_STATES: ReadonlySet<string> = new Set([
  "alias",
  "enabled",
  "enabled-runtime",
  "linked",
  "linked-runtime",
]);

function resultMessage(result: ServiceProcessResult): string {
  return result.stderr.trim() || result.stdout.trim() || "systemctl failed";
}

function unitIsAbsent(result: ServiceProcessResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return (
    /LoadState=not-found/i.test(output) ||
    /unit(?: file)? .* (?:could not be found|does not exist|not found|not loaded)/i.test(output)
  );
}

function parseProperties(output: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return properties;
}

function parseManagerState<E>(
  result: ServiceProcessResult,
  failure: SystemdManagerDependencies<E>["failure"],
): Effect.Effect<SystemdManagerState, E> {
  if (result.code !== 0) {
    return unitIsAbsent(result)
      ? Effect.succeed(ABSENT_STATE)
      : Effect.fail(failure("status", resultMessage(result)));
  }
  const properties = parseProperties(result.stdout);
  const loadState = properties.get("LoadState");
  const activeState = properties.get("ActiveState");
  const mainPidValue = properties.get("MainPID");
  if (loadState === undefined || activeState === undefined || mainPidValue === undefined) {
    return Effect.fail(failure("status", "systemctl returned incomplete manager state."));
  }
  if (loadState === "not-found") return Effect.succeed(ABSENT_STATE);
  const mainPid = Number(mainPidValue);
  if (!Number.isSafeInteger(mainPid) || mainPid < 0) {
    return Effect.fail(failure("status", `systemctl returned invalid MainPID: ${mainPidValue}`));
  }
  return Effect.succeed({
    loaded: true,
    mainPid: mainPid > 0 ? mainPid : null,
    running: activeState === "active",
    unitFileState: properties.get("UnitFileState") ?? "unknown",
  });
}

export class SystemdManagerService extends Context.Service<
  SystemdManagerService,
  SystemdManager<ServiceFailure>
>()("SelfTune/SystemdManager") {}

export function makeSystemdManagerLayer(dependencies: SystemdManagerDependencies<ServiceFailure>) {
  return Layer.sync(SystemdManagerService)(() => makeSystemdManager(dependencies));
}

export function makeSystemdManager<E>(
  dependencies: SystemdManagerDependencies<E>,
): SystemdManager<E> {
  const inspect = Effect.fn("SelfTuneService.systemd.inspect")(function* () {
    const result = yield* dependencies.run([
      "show",
      dependencies.unitName,
      "--property=LoadState",
      "--property=ActiveState",
      "--property=MainPID",
      "--property=UnitFileState",
    ]);
    return yield* parseManagerState(result, dependencies.failure);
  });

  const checked = Effect.fn("SelfTuneService.systemd.checked")(function* (
    operation: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* dependencies.run(args);
    if (result.code !== 0 && !unitIsAbsent(result)) {
      return yield* Effect.fail(dependencies.failure(operation, resultMessage(result)));
    }
  });

  const stopLoadedUnit = Effect.fn("SelfTuneService.systemd.stopLoaded")(function* () {
    yield* checked("stop", ["stop", dependencies.unitName]);
  });

  const stop = Effect.fn("SelfTuneService.systemd.stop")(function* () {
    const state = yield* inspect();
    if (!state.loaded || !state.running) return;
    yield* stopLoadedUnit();
  });

  const uninstall = Effect.fn("SelfTuneService.systemd.uninstall")(function* (
    unitFileExists: boolean,
  ) {
    const state = yield* inspect();
    if (unitFileExists) {
      yield* checked("uninstall", ["disable", "--now", dependencies.unitName]);
      return;
    }
    if (state.loaded && state.running) yield* stopLoadedUnit();
    if (ENABLED_UNIT_FILE_STATES.has(state.unitFileState)) {
      yield* checked("uninstall", ["disable", dependencies.unitName]);
    }
  });

  return { inspect, stop, uninstall };
}
