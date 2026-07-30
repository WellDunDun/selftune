import { win32 } from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type {
  WindowsAuthenticatedRecoveryRefusal,
  WindowsListenerRecoveryOutcome,
  WindowsListenerRecoveryRefusal,
  WindowsRejectedListenerReason,
  WindowsRuntimeAuthorization,
  WindowsRuntimeReadiness,
  WindowsShutdownRequestOutcome,
} from "./contract.js";

export type WindowsListenerFamily = "ipv4" | "ipv6";

export interface WindowsLoopbackListener {
  readonly address: "127.0.0.1" | "::1";
  readonly family: WindowsListenerFamily;
  readonly pid: number;
  readonly port: number;
}

export interface WindowsRejectedListener {
  readonly address: string;
  readonly family: WindowsListenerFamily;
  readonly pid: number | null;
  readonly port: number;
  readonly reason: WindowsRejectedListenerReason;
}

export interface WindowsListenerScan {
  readonly listeners: ReadonlyArray<WindowsLoopbackListener>;
  readonly port: number;
  readonly rejected: ReadonlyArray<WindowsRejectedListener>;
}

export interface WindowsAuthenticatedHealthEvidence {
  readonly pid: number;
  readonly port: number;
}

export type WindowsListenerRecoveryPlan =
  | {
      readonly decision: "no-listener";
      readonly port: number;
    }
  | {
      readonly decision: "refuse";
      readonly candidatePids: ReadonlyArray<number>;
      readonly port: number;
      readonly reason: WindowsListenerRecoveryRefusal;
    }
  | {
      readonly decision: "authenticate-health";
      readonly families: ReadonlyArray<WindowsListenerFamily>;
      readonly pid: number;
      readonly port: number;
    }
  | {
      readonly decision: "terminate-authenticated-listener";
      readonly families: ReadonlyArray<WindowsListenerFamily>;
      readonly pid: number;
      readonly port: number;
    };

export interface WindowsRecoveryCommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface WindowsListenerRecoveryInput {
  readonly absenceConfirmations?: number;
  readonly configDir: string;
  readonly port: number;
  readonly releasePollIntervalMs?: number;
  readonly releaseTimeoutMs?: number;
}

export interface WindowsListenerRecoveryDependencies<E> {
  readonly makeFailure: (operation: string, cause: unknown) => E;
  readonly readAuthToken: (configDir: string) => Effect.Effect<string | null, E>;
  readonly requestHealth: (port: number, token: string) => Effect.Effect<unknown, E>;
  readonly requestShutdown: (
    port: number,
    token: string,
    runtimeInstanceId: string,
  ) => Effect.Effect<WindowsShutdownRequestOutcome, E>;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<WindowsRecoveryCommandResult, E>;
  readonly sleep: (milliseconds: number) => Effect.Effect<void, E>;
}

type WindowsRuntimeNotReadyReason = WindowsAuthenticatedRecoveryRefusal | "listener-absent";

const WindowsRuntimeHealth = Schema.Struct({
  config_dir: Schema.String,
  host: Schema.String,
  ok: Schema.Boolean,
  owner_executable_path: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pid: Schema.Number,
  port: Schema.Number,
  process_mode: Schema.String,
  runtime_instance_id: Schema.NullOr(Schema.String),
  runtime_owner: Schema.NullOr(Schema.String),
  runtime_supervision: Schema.NullOr(Schema.String),
  service_installation_nonce: Schema.optionalKey(Schema.NullOr(Schema.String)),
  service: Schema.String,
  version: Schema.NonEmptyString,
});

type WindowsRuntimeHealth = typeof WindowsRuntimeHealth.Type;

interface ParsedEndpoint {
  readonly address: string;
  readonly family: WindowsListenerFamily;
  readonly port: number;
}

const WINDOWS_LISTENER_REMOTES = new Set(["0.0.0.0:0", "[::]:0", "*:*"]);

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : null;
}

function parseEndpoint(value: string): ParsedEndpoint | null {
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  if (ipv6) {
    const port = parsePort(ipv6[2]);
    return port === null ? null : { address: ipv6[1], family: "ipv6", port };
  }
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const port = parsePort(value.slice(separator + 1));
  return port === null ? null : { address: value.slice(0, separator), family: "ipv4", port };
}

function parsePid(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function listenerKey(listener: WindowsLoopbackListener): string {
  return `${listener.family}:${listener.address}:${listener.port}:${listener.pid}`;
}

function rejectedKey(listener: WindowsRejectedListener): string {
  return `${listener.family}:${listener.address}:${listener.port}:${listener.pid ?? "invalid"}:${listener.reason}`;
}

export function parseWindowsTcpListeningScan(output: string, port: number): WindowsListenerScan {
  const listeners = new Map<string, WindowsLoopbackListener>();
  const rejected = new Map<string, WindowsRejectedListener>();

  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length < 5 ||
      fields[0]?.toUpperCase() !== "TCP" ||
      !WINDOWS_LISTENER_REMOTES.has(fields[2])
    ) {
      continue;
    }
    const endpoint = parseEndpoint(fields[1]);
    if (!endpoint || endpoint.port !== port) continue;
    const pid = parsePid(fields[4]);
    const loopbackAddress =
      endpoint.family === "ipv4" ? endpoint.address === "127.0.0.1" : endpoint.address === "::1";
    if (pid === null) {
      const invalid: WindowsRejectedListener = {
        ...endpoint,
        pid: null,
        reason: "invalid-pid",
      };
      rejected.set(rejectedKey(invalid), invalid);
      continue;
    }
    if (!loopbackAddress) {
      const unsafe: WindowsRejectedListener = {
        ...endpoint,
        pid,
        reason:
          endpoint.address === "0.0.0.0" || endpoint.address === "::"
            ? "wildcard-binding"
            : "non-loopback-binding",
      };
      rejected.set(rejectedKey(unsafe), unsafe);
      continue;
    }
    const listener: WindowsLoopbackListener =
      endpoint.family === "ipv4"
        ? { ...endpoint, address: "127.0.0.1", pid }
        : { ...endpoint, address: "::1", pid };
    listeners.set(listenerKey(listener), listener);
  }

  return { listeners: [...listeners.values()], port, rejected: [...rejected.values()] };
}

function sortedPids(scan: WindowsListenerScan): ReadonlyArray<number> {
  return [...new Set(scan.listeners.map((listener) => listener.pid))].toSorted(
    (left, right) => left - right,
  );
}

function sortedFamilies(scan: WindowsListenerScan): ReadonlyArray<WindowsListenerFamily> {
  const families = new Set(scan.listeners.map((listener) => listener.family));
  const sorted: WindowsListenerFamily[] = [];
  if (families.has("ipv4")) sorted.push("ipv4");
  if (families.has("ipv6")) sorted.push("ipv6");
  return sorted;
}

export function planWindowsListenerRecovery(
  scan: WindowsListenerScan,
  authenticatedHealth?: WindowsAuthenticatedHealthEvidence,
): WindowsListenerRecoveryPlan {
  const candidatePids = sortedPids(scan);
  const rejected = scan.rejected[0];
  if (rejected) {
    return {
      decision: "refuse",
      candidatePids,
      port: scan.port,
      reason: rejected.reason,
    };
  }
  if (candidatePids.length === 0) return { decision: "no-listener", port: scan.port };
  if (candidatePids.length !== 1) {
    return { decision: "refuse", candidatePids, port: scan.port, reason: "ambiguous-pids" };
  }
  const pid = candidatePids[0];
  const families = sortedFamilies(scan);
  if (!authenticatedHealth) {
    return { decision: "authenticate-health", families, pid, port: scan.port };
  }
  if (authenticatedHealth.port !== scan.port) {
    return {
      decision: "refuse",
      candidatePids,
      port: scan.port,
      reason: "authenticated-port-mismatch",
    };
  }
  if (authenticatedHealth.pid !== pid) {
    return {
      decision: "refuse",
      candidatePids,
      port: scan.port,
      reason: "authenticated-pid-mismatch",
    };
  }
  return { decision: "terminate-authenticated-listener", families, pid, port: scan.port };
}

function canonicalWindowsPath(path: string): string | null {
  if (!win32.isAbsolute(path)) return null;
  const normalized = win32.normalize(path);
  const withoutTrailingSeparators =
    normalized.length > 3 ? normalized.replace(/\\+$/, "") : normalized;
  return withoutTrailingSeparators.toLocaleLowerCase("en-US");
}

function refused(
  port: number,
  reason: WindowsAuthenticatedRecoveryRefusal,
  candidatePids: ReadonlyArray<number> = [],
): WindowsListenerRecoveryOutcome {
  return { candidatePids, outcome: "refused", port, reason };
}

function healthRefusalReason(
  health: WindowsRuntimeHealth,
  input: WindowsListenerRecoveryInput,
  candidatePid: number,
  authorization: WindowsRuntimeAuthorization,
): WindowsAuthenticatedRecoveryRefusal | null {
  if (!health.ok || health.service !== "selftune-dashboard") return "health-service-mismatch";
  if (!Number.isSafeInteger(health.pid) || health.pid !== candidatePid) {
    return "health-pid-mismatch";
  }
  if (!Number.isSafeInteger(health.port) || health.port !== input.port) {
    return "health-port-mismatch";
  }
  if (health.process_mode !== "standalone") return "health-mode-mismatch";
  if (health.runtime_supervision !== "os-service") return "health-supervision-mismatch";
  if (health.runtime_owner === null || health.runtime_owner.length === 0) {
    return "health-owner-missing";
  }
  if (health.runtime_owner !== "cli" && health.runtime_owner !== "desktop") {
    return "health-owner-mismatch";
  }
  if (health.runtime_owner !== authorization.owner) {
    return "health-owner-mismatch";
  }
  if (health.host !== "127.0.0.1") return "health-host-mismatch";
  if (health.runtime_instance_id === null || health.runtime_instance_id.length === 0) {
    return "health-instance-id-missing";
  }
  if (
    health.owner_executable_path === undefined ||
    health.owner_executable_path === null ||
    health.owner_executable_path.length === 0
  ) {
    return "health-executable-missing";
  }
  const actualExecutablePath = canonicalWindowsPath(health.owner_executable_path);
  if (actualExecutablePath === null) {
    return "health-executable-mismatch";
  }
  if (actualExecutablePath !== canonicalWindowsPath(authorization.executablePath)) {
    return "health-executable-mismatch";
  }
  if (
    authorization._tag === "NonceBound" &&
    (health.service_installation_nonce === undefined ||
      health.service_installation_nonce === null ||
      health.service_installation_nonce.length === 0)
  ) {
    return "health-installation-nonce-missing";
  }
  if (
    authorization._tag === "NonceBound" &&
    health.service_installation_nonce !== authorization.installationNonce
  ) {
    return "health-installation-nonce-mismatch";
  }
  if (
    authorization._tag === "ExactLegacy" &&
    health.service_installation_nonce !== undefined &&
    health.service_installation_nonce !== null &&
    health.service_installation_nonce.length > 0
  ) {
    return "health-installation-nonce-unexpected";
  }
  const actualConfigDir = canonicalWindowsPath(health.config_dir);
  const expectedConfigDir = canonicalWindowsPath(input.configDir);
  return actualConfigDir === null || actualConfigDir !== expectedConfigDir
    ? "health-config-mismatch"
    : null;
}

function authorizationInput(
  authorization: WindowsRuntimeAuthorization,
): WindowsListenerRecoveryInput {
  return { configDir: authorization.configDir, port: authorization.port };
}

function notReady(
  port: number,
  reason: WindowsRuntimeNotReadyReason,
  candidatePids: ReadonlyArray<number> = [],
): WindowsRuntimeReadiness {
  return { _tag: "NotReady", candidatePids, port, reason };
}

function observedPids(scan: WindowsListenerScan): ReadonlyArray<number> {
  return [
    ...new Set([
      ...scan.listeners.map((listener) => listener.pid),
      ...scan.rejected.flatMap((listener) => (listener.pid === null ? [] : [listener.pid])),
    ]),
  ].toSorted((left, right) => left - right);
}

function scanWindowsListener<E>(
  input: WindowsListenerRecoveryInput,
  dependencies: Pick<WindowsListenerRecoveryDependencies<E>, "makeFailure" | "run">,
): Effect.Effect<WindowsListenerScan, E> {
  return Effect.gen(function* () {
    const command = yield* dependencies.run("netstat.exe", ["-ano", "-p", "tcp"]);
    if (command.code !== 0) {
      return yield* Effect.fail(
        dependencies.makeFailure(
          "netstat",
          command.stderr.trim() || command.stdout.trim() || "netstat failed",
        ),
      );
    }
    return parseWindowsTcpListeningScan(command.stdout, input.port);
  });
}

export function verifyWindowsListenerAbsent<E>(
  input: WindowsListenerRecoveryInput,
  dependencies: Pick<WindowsListenerRecoveryDependencies<E>, "makeFailure" | "run" | "sleep">,
): Effect.Effect<WindowsListenerRecoveryOutcome, E> {
  return Effect.gen(function* () {
    const confirmations = input.absenceConfirmations ?? 3;
    const intervalMs = input.releasePollIntervalMs ?? 100;
    if (!Number.isSafeInteger(confirmations) || confirmations < 1 || intervalMs <= 0) {
      return yield* Effect.fail(
        dependencies.makeFailure("validate", "Invalid Windows listener absence timing."),
      );
    }
    for (let index = 0; index < confirmations; index += 1) {
      const scan = yield* scanWindowsListener(input, dependencies);
      if (scan.listeners.length > 0 || scan.rejected.length > 0) {
        return refused(input.port, "listener-still-present", observedPids(scan));
      }
      if (index + 1 < confirmations) yield* dependencies.sleep(intervalMs);
    }
    return { outcome: "absent", port: input.port };
  });
}

export function verifyAuthorizedWindowsListenerRunning<E>(
  authorization: WindowsRuntimeAuthorization,
  dependencies: Pick<
    WindowsListenerRecoveryDependencies<E>,
    "makeFailure" | "readAuthToken" | "requestHealth" | "run"
  >,
): Effect.Effect<WindowsRuntimeReadiness, E> {
  const input = authorizationInput(authorization);
  const scan = Effect.fn("SelfTuneService.windows.verifyRunning.scan")(() =>
    scanWindowsListener(input, dependencies),
  );

  return Effect.gen(function* () {
    const initialScan = yield* scan();
    const initialPlan = planWindowsListenerRecovery(initialScan);
    if (initialPlan.decision === "no-listener") {
      return notReady(input.port, "listener-absent");
    }
    if (initialPlan.decision === "refuse") {
      return notReady(input.port, initialPlan.reason, initialPlan.candidatePids);
    }

    const token = yield* dependencies.readAuthToken(input.configDir);
    if (!token) return notReady(input.port, "missing-auth-token", [initialPlan.pid]);

    const healthRequest = yield* Effect.result(dependencies.requestHealth(input.port, token));
    if (Result.isFailure(healthRequest)) {
      return notReady(input.port, "health-unavailable", [initialPlan.pid]);
    }
    const decodedHealth = yield* Effect.result(
      Schema.decodeUnknownEffect(WindowsRuntimeHealth)(healthRequest.success),
    );
    if (Result.isFailure(decodedHealth)) {
      return notReady(input.port, "health-invalid", [initialPlan.pid]);
    }
    const identityRefusal = healthRefusalReason(
      decodedHealth.success,
      input,
      initialPlan.pid,
      authorization,
    );
    if (identityRefusal) {
      return notReady(input.port, identityRefusal, [initialPlan.pid]);
    }
    const instanceId = decodedHealth.success.runtime_instance_id;
    if (instanceId === null || instanceId.length === 0) {
      return notReady(input.port, "health-instance-id-missing", [initialPlan.pid]);
    }

    const verifiedScan = yield* scan();
    const verifiedPlan = planWindowsListenerRecovery(verifiedScan, {
      pid: decodedHealth.success.pid,
      port: decodedHealth.success.port,
    });
    if (verifiedPlan.decision !== "terminate-authenticated-listener") {
      return notReady(
        input.port,
        "listener-changed-during-verification",
        observedPids(verifiedScan),
      );
    }

    const freshHealthRequest = yield* Effect.result(dependencies.requestHealth(input.port, token));
    if (Result.isFailure(freshHealthRequest)) {
      return notReady(input.port, "health-unavailable", [verifiedPlan.pid]);
    }
    const freshHealth = yield* Effect.result(
      Schema.decodeUnknownEffect(WindowsRuntimeHealth)(freshHealthRequest.success),
    );
    if (Result.isFailure(freshHealth)) {
      return notReady(input.port, "health-invalid", [verifiedPlan.pid]);
    }
    const freshIdentityRefusal = healthRefusalReason(
      freshHealth.success,
      input,
      verifiedPlan.pid,
      authorization,
    );
    if (freshIdentityRefusal) {
      return notReady(input.port, freshIdentityRefusal, [verifiedPlan.pid]);
    }
    if (freshHealth.success.runtime_instance_id !== instanceId) {
      return notReady(input.port, "health-instance-id-mismatch", [verifiedPlan.pid]);
    }
    const owner = freshHealth.success.runtime_owner;
    if (owner !== "cli" && owner !== "desktop") {
      return notReady(input.port, "health-owner-mismatch", [verifiedPlan.pid]);
    }
    const ownerExecutablePath = freshHealth.success.owner_executable_path;
    if (ownerExecutablePath === undefined || ownerExecutablePath === null) {
      return notReady(input.port, "health-executable-missing", [verifiedPlan.pid]);
    }

    return {
      _tag: "Ready",
      instanceId,
      owner,
      ownerExecutablePath,
      ownerVersion: freshHealth.success.version,
      pid: verifiedPlan.pid,
      port: input.port,
    };
  });
}

export function recoverAuthorizedWindowsListener<E>(
  authorization: WindowsRuntimeAuthorization,
  dependencies: WindowsListenerRecoveryDependencies<E>,
  timing: Pick<WindowsListenerRecoveryInput, "releasePollIntervalMs" | "releaseTimeoutMs"> = {},
): Effect.Effect<WindowsListenerRecoveryOutcome, E> {
  const input = { ...authorizationInput(authorization), ...timing };
  const scan = Effect.fn("SelfTuneService.windows.recoverAuthorized.scan")(() =>
    scanWindowsListener(input, dependencies),
  );

  return Effect.gen(function* () {
    const releaseTimeoutMs = input.releaseTimeoutMs ?? 5_000;
    const releasePollIntervalMs = input.releasePollIntervalMs ?? 100;
    if (
      !Number.isFinite(releaseTimeoutMs) ||
      releaseTimeoutMs < 0 ||
      !Number.isFinite(releasePollIntervalMs) ||
      releasePollIntervalMs <= 0
    ) {
      return yield* Effect.fail(
        dependencies.makeFailure("validate", "Invalid Windows listener release timing."),
      );
    }

    const readiness = yield* verifyAuthorizedWindowsListenerRunning(authorization, dependencies);
    if (readiness._tag === "NotReady") {
      if (readiness.reason === "listener-absent") {
        return { outcome: "absent", port: input.port };
      }
      return refused(input.port, readiness.reason, readiness.candidatePids);
    }

    const token = yield* dependencies.readAuthToken(input.configDir);
    if (!token) return refused(input.port, "missing-auth-token", [readiness.pid]);
    const shutdownResult = yield* Effect.result(
      dependencies.requestShutdown(input.port, token, readiness.instanceId),
    );
    const shutdown = Result.isFailure(shutdownResult)
      ? "transport-ambiguous"
      : shutdownResult.success;
    if (shutdown === "instance-mismatch" || shutdown === "rejected") {
      return refused(input.port, "shutdown-refused", [readiness.pid]);
    }

    let elapsedMs = 0;
    while (true) {
      const releaseScan = yield* scan();
      if (releaseScan.listeners.length === 0 && releaseScan.rejected.length === 0) {
        return {
          instanceId: readiness.instanceId,
          outcome: "stopped",
          pid: readiness.pid,
          port: input.port,
        };
      }
      const originalLoopbackListenerStillOwnsPort =
        releaseScan.rejected.length === 0 &&
        releaseScan.listeners.every((listener) => listener.pid === readiness.pid);
      if (!originalLoopbackListenerStillOwnsPort) {
        return refused(input.port, "listener-changed-after-termination", observedPids(releaseScan));
      }
      if (elapsedMs >= releaseTimeoutMs) {
        return refused(
          input.port,
          shutdown === "transport-ambiguous" ? "shutdown-refused" : "listener-release-timeout",
          [readiness.pid],
        );
      }
      const delayMs = Math.min(releasePollIntervalMs, releaseTimeoutMs - elapsedMs);
      yield* dependencies.sleep(delayMs);
      elapsedMs += delayMs;
    }
  });
}
