import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DaemonFailure, DaemonStatus, RuntimeStopExpectation } from "./daemon.js";
import type { RuntimeOwner } from "./local-runtime.js";
import type {
  WindowsListenerRecoveryOutcome,
  WindowsRuntimeAuthorization,
  WindowsRuntimeReadiness,
} from "./service/windows/runtime/contract.js";
import type { WindowsServiceInstallationEvidence } from "./service/windows/installation/contract.js";
import type { WindowsServiceLockCompatibilityDiagnostic } from "./service/windows/lock-compatibility.js";

export type ServicePlatform = "darwin" | "linux" | "win32" | "unsupported";

export interface ServiceDescriptor {
  readonly boot: boolean;
  readonly configDir: string;
  readonly executableArgsPrefix: ReadonlyArray<string>;
  readonly executablePath: string;
  readonly owner: RuntimeOwner;
  readonly port: number;
  readonly resourceDir?: string;
  readonly version: string;
}

export interface ServiceStatus {
  readonly detail: ReadonlyArray<string>;
  readonly pid: number | null;
  readonly platform: ServicePlatform;
  readonly registered: boolean;
  readonly running: boolean;
}

export interface ServiceBackendBase {
  readonly automated: boolean;
  readonly install: (descriptor: ServiceDescriptor) => Effect.Effect<void, ServiceFailure>;
  readonly restart: (descriptor: ServiceDescriptor) => Effect.Effect<void, ServiceFailure>;
  readonly start: (descriptor: ServiceDescriptor) => Effect.Effect<void, ServiceFailure>;
  readonly status: (descriptor: ServiceDescriptor) => Effect.Effect<ServiceStatus, ServiceFailure>;
  readonly stop: (descriptor: ServiceDescriptor) => Effect.Effect<void, ServiceFailure>;
  readonly uninstall: (descriptor: ServiceDescriptor) => Effect.Effect<void, ServiceFailure>;
}

export interface NonWindowsServiceBackend extends ServiceBackendBase {
  readonly platform: Exclude<ServicePlatform, "win32">;
}

export interface WindowsServiceBackend extends ServiceBackendBase {
  readonly diagnoseMutationLock: () => Effect.Effect<
    WindowsServiceLockCompatibilityDiagnostic,
    ServiceFailure
  >;
  readonly inspectInstallation: (
    descriptor: ServiceDescriptor,
  ) => Effect.Effect<WindowsServiceInstallationEvidence, ServiceFailure>;
  readonly platform: "win32";
  readonly repairMutationLock: () => Effect.Effect<
    WindowsServiceLockCompatibilityDiagnostic,
    ServiceFailure
  >;
  readonly withMutationLock: <A, E, R>(
    descriptor: ServiceDescriptor,
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ServiceFailure, R>;
}

export type ServiceBackend = NonWindowsServiceBackend | WindowsServiceBackend;

export interface LocalRuntimeControl {
  readonly status: (configDir: string) => Effect.Effect<DaemonStatus, DaemonFailure>;
  readonly stop: (
    configDir: string,
    expectation?: RuntimeStopExpectation,
  ) => Effect.Effect<boolean, DaemonFailure>;
}

export interface WindowsRuntimeRecovery {
  readonly recoverAuthorized: (
    authorization: WindowsRuntimeAuthorization,
  ) => Effect.Effect<WindowsListenerRecoveryOutcome, ServiceFailure>;
  readonly verifyAbsent: (
    descriptor: ServiceDescriptor,
  ) => Effect.Effect<WindowsListenerRecoveryOutcome, ServiceFailure>;
  readonly verifyRunning: (
    authorization: WindowsRuntimeAuthorization,
  ) => Effect.Effect<WindowsRuntimeReadiness, ServiceFailure>;
}

export class ServiceFailure extends Schema.TaggedErrorClass<ServiceFailure>()("ServiceFailure", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class ServiceManager extends Context.Service<
  ServiceManager,
  {
    readonly backend: ServiceBackend;
    readonly runtime: LocalRuntimeControl;
    readonly windowsRecovery: WindowsRuntimeRecovery;
  }
>()("@selftune/local/ServiceManager") {}

export interface ServiceCommandResponse {
  readonly action: "install" | "restart" | "start" | "status" | "stop" | "uninstall";
  readonly ok: true;
  readonly status: ServiceStatus;
}

export function serviceFailure(operation: string, cause: unknown): ServiceFailure {
  return ServiceFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}
