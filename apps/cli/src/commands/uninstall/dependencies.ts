import type { DaemonFailure } from "@selftune/local/daemon";
import type { ServiceFailure } from "@selftune/local/service";
import type { CredentialStoreFailure } from "@selftune/runtime/credential-store";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  AgentRemovalResult,
  ConfigRemovalResult,
  CredentialRemovalResult,
  FileRemovalResult,
  HookRemovalResult,
  NpmRemovalResult,
  ScheduleRemovalResult,
  ServiceRemovalResult,
} from "./types.js";
import type { UninstallCleanupFailure } from "./errors.js";

export interface UninstallDependencyService {
  readonly removeRuntimeService: (
    dryRun: boolean,
  ) => Effect.Effect<ServiceRemovalResult, DaemonFailure | ServiceFailure>;
  readonly removeRemoteCredential: (
    dryRun: boolean,
  ) => Effect.Effect<CredentialRemovalResult, CredentialStoreFailure>;
  readonly removeScheduling: (dryRun: boolean) => Effect.Effect<ScheduleRemovalResult>;
  readonly removeHooks: (
    dryRun: boolean,
    settingsPath?: string,
  ) => Effect.Effect<HookRemovalResult, UninstallCleanupFailure>;
  readonly removeAgents: (
    dryRun: boolean,
  ) => Effect.Effect<AgentRemovalResult, UninstallCleanupFailure>;
  readonly removeLogs: (dryRun: boolean) => Effect.Effect<FileRemovalResult>;
  readonly removeConfig: (dryRun: boolean) => Effect.Effect<ConfigRemovalResult>;
  readonly removeMarkers: (dryRun: boolean) => Effect.Effect<FileRemovalResult>;
  readonly uninstallNpm: (dryRun: boolean) => Effect.Effect<NpmRemovalResult>;
}

export class UninstallDependencies extends Context.Service<
  UninstallDependencies,
  UninstallDependencyService
>()("@selftune/cli/UninstallDependencies") {}
