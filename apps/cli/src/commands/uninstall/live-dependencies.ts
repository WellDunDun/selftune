import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { removeInstalledAgentFiles } from "@selftune/runtime/claude-agents";
import {
  CANONICAL_LOG,
  CLAUDE_CODE_MARKER,
  CLAUDE_SETTINGS_PATH,
  CODEX_INGEST_MARKER,
  EVOLUTION_AUDIT_LOG,
  EVOLUTION_EVIDENCE_LOG,
  OPENCODE_INGEST_MARKER,
  OPENCLAW_INGEST_MARKER,
  ORCHESTRATE_LOCK,
  ORCHESTRATE_RUN_LOG,
  QUERY_LOG,
  REPAIRED_SKILL_LOG,
  REPAIRED_SKILL_SESSIONS_MARKER,
  SELFTUNE_CONFIG_DIR,
  SIGNAL_LOG,
  SKILL_LOG,
  TELEMETRY_LOG,
} from "@selftune/runtime/constants";
import { CredentialStore } from "@selftune/runtime/credential-store";
import { stopDaemon } from "@selftune/local/daemon";
import {
  DEFAULT_DAEMON_PORT,
  readServerManifest,
  type ServerManifest,
} from "@selftune/local/local-runtime";
import { storedRemoteLibraryCredential } from "@selftune/runtime/remote-library-config";
import {
  getServiceBackend,
  runServiceCommand,
  type ServiceBackend,
  type ServiceDescriptor,
  type ServiceFailure,
  ServiceManagerLive,
} from "@selftune/local/service";
import {
  ClaudeCodeSettings,
  type ClaudeCodeHookEntry,
  isSelftuneCommand,
} from "@selftune/runtime/utils/hooks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { UninstallDependencies } from "./dependencies.js";
import { uninstallCleanupFailure } from "./errors.js";
import type {
  ConfigRemovalResult,
  FileRemovalResult,
  HookRemovalResult,
  NpmRemovalResult,
  ScheduleRemovalResult,
} from "./types.js";

export interface RuntimeServiceRemovalDependencies {
  readonly backend?: ServiceBackend;
  readonly configDir?: string;
  readonly runServiceUninstall?: (
    descriptor: ServiceDescriptor,
  ) => Effect.Effect<void, ServiceFailure>;
  readonly stopRuntime?: typeof stopDaemon;
}

function manifestDescription(manifest: ServerManifest): string {
  if (manifest.supervision === "desktop-child") return "desktop runtime";
  if (manifest.supervision === "os-service") return `${manifest.owner}-owned service runtime`;
  return "CLI runtime";
}

function serviceDescriptor(configDir: string): ServiceDescriptor {
  return {
    boot: false,
    configDir,
    executableArgsPrefix: [],
    executablePath: process.execPath,
    owner: "cli",
    port: DEFAULT_DAEMON_PORT,
    version: "uninstall",
  };
}

export const removeRuntimeService = Effect.fn("SelfTuneUninstall.removeRuntimeService")(function* (
  dryRun: boolean,
  dependencies: RuntimeServiceRemovalDependencies = {},
) {
  const backend = dependencies.backend ?? getServiceBackend();
  const configDir = dependencies.configDir ?? SELFTUNE_CONFIG_DIR;
  const runServiceUninstall =
    dependencies.runServiceUninstall ??
    ((descriptor: ServiceDescriptor) =>
      runServiceCommand("uninstall", descriptor).pipe(
        Effect.provide(ServiceManagerLive),
        Effect.asVoid,
      ));
  const stopRuntime = dependencies.stopRuntime ?? stopDaemon;
  const manifest = readServerManifest(configDir);
  if (dryRun) {
    const actions: string[] = [];
    if (manifest) actions.push(`Would stop the ${manifestDescription(manifest)}.`);
    if (backend.automated) actions.push(`Would unregister the ${backend.platform} service.`);
    return {
      removed: false,
      details: actions.join(" ") || "No local runtime or supported OS service was found.",
    };
  }

  if (backend.automated) {
    yield* runServiceUninstall(serviceDescriptor(configDir));
    return {
      removed: true,
      details: `Unregistered the ${backend.platform} service.`,
    };
  }

  const stoppedRuntime = yield* stopRuntime(configDir);
  return {
    removed: stoppedRuntime,
    details: stoppedRuntime
      ? "Stopped the manifest-owned local runtime."
      : "No local runtime or supported OS service was found.",
  };
});

const removeRemoteCredential = Effect.fn("SelfTuneUninstall.removeRemoteCredential")(function* (
  dryRun: boolean,
  credentialStore: CredentialStore["Service"],
  configDir: string,
) {
  const credential = storedRemoteLibraryCredential(configDir);
  if (!credential) return { removed: false, details: "No Sync & Backup credential found." };
  if (dryRun) {
    return {
      removed: false,
      details: `Would remove the Sync & Backup credential from ${credential.provider}.`,
    };
  }
  yield* credentialStore.delete(credential, configDir);
  return {
    removed: true,
    details: `Removed the Sync & Backup credential from ${credential.provider}.`,
  };
});

async function removeScheduling(dryRun: boolean): Promise<ScheduleRemovalResult> {
  const label = "dev.selftune.orchestrate";
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

  if (existsSync(plistPath)) {
    if (dryRun) {
      return { removed: false, details: `Would remove launchd plist: ${plistPath}` };
    }
    try {
      Bun.spawnSync(["launchctl", "unload", plistPath], { stderr: "pipe" });
      unlinkSync(plistPath);
      return { removed: true, details: `Removed launchd plist: ${plistPath}` };
    } catch (error) {
      return {
        removed: false,
        details: `Failed to remove launchd plist: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (dryRun) {
    return { removed: false, details: "Would remove cron jobs via selftune cron remove" };
  }
  try {
    const process = Bun.spawnSync(["selftune", "cron", "remove"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (process.exitCode === 0) {
      return { removed: true, details: "Removed cron jobs via selftune cron remove" };
    }
  } catch {
    // Scheduling cleanup is best effort when the installed CLI is unavailable.
  }

  return { removed: false, details: "No scheduling artifacts found" };
}

function withoutSelftuneHooks(entry: ClaudeCodeHookEntry): ClaudeCodeHookEntry | null {
  const ownCommand = entry.command !== undefined && isSelftuneCommand(entry.command);
  const hooks = entry.hooks?.filter(
    (hook) => hook.command === undefined || !isSelftuneCommand(hook.command),
  );
  const nestedChanged = hooks !== undefined && hooks.length !== entry.hooks?.length;
  if (!ownCommand && !nestedChanged) return entry;
  const { command, ...withoutCommand } = entry;
  const retained = ownCommand ? withoutCommand : entry;
  if (nestedChanged && hooks) {
    if (hooks.length === 0 && (command === undefined || ownCommand)) return null;
    return { ...retained, hooks };
  }
  return ownCommand && !hooks?.length ? null : retained;
}

export function removeHooksFromSettings(dryRun: boolean, settingsPath?: string): HookRemovalResult {
  const path = settingsPath ?? CLAUDE_SETTINGS_PATH;
  if (!existsSync(path)) return { removed: 0, details: "No settings.json found" };

  let settings: ClaudeCodeSettings;
  try {
    settings = Schema.decodeUnknownSync(Schema.fromJsonString(ClaudeCodeSettings))(
      readFileSync(path, "utf-8"),
    );
  } catch {
    return { removed: 0, details: "Failed to parse settings.json" };
  }

  const hooks = settings.hooks;
  if (!hooks) {
    return { removed: 0, details: "No hooks section in settings.json" };
  }

  let totalRemoved = 0;
  for (const key of Object.keys(hooks)) {
    const entries = hooks[key];
    const filtered: ClaudeCodeHookEntry[] = [];
    let changed = 0;
    for (const entry of entries) {
      const retained = withoutSelftuneHooks(entry);
      if (retained !== entry) changed += 1;
      if (retained) filtered.push(retained);
    }
    if (changed === 0) continue;
    hooks[key] = filtered;
    totalRemoved += changed;
    if (filtered.length === 0) delete hooks[key];
  }

  if (Object.keys(hooks).length === 0) delete settings.hooks;
  if (totalRemoved > 0 && !dryRun) {
    writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
  }

  return {
    removed: totalRemoved,
    details: dryRun
      ? `Would remove ${totalRemoved} selftune hook entries from ${path}`
      : `Removed ${totalRemoved} selftune hook entries from ${path}`,
  };
}

const LOG_FILES = [
  TELEMETRY_LOG,
  SKILL_LOG,
  REPAIRED_SKILL_LOG,
  CANONICAL_LOG,
  QUERY_LOG,
  EVOLUTION_AUDIT_LOG,
  EVOLUTION_EVIDENCE_LOG,
  ORCHESTRATE_RUN_LOG,
  SIGNAL_LOG,
  ORCHESTRATE_LOCK,
];

const MARKER_FILES = [
  CLAUDE_CODE_MARKER,
  CODEX_INGEST_MARKER,
  OPENCODE_INGEST_MARKER,
  OPENCLAW_INGEST_MARKER,
  REPAIRED_SKILL_SESSIONS_MARKER,
];

function removeFiles(paths: ReadonlyArray<string>, dryRun: boolean): FileRemovalResult {
  const removed: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    if (dryRun) {
      removed.push(path);
      continue;
    }
    try {
      unlinkSync(path);
      removed.push(path);
    } catch {
      // Individual stale files must not prevent the remaining cleanup.
    }
  }
  return { removed: removed.length, files: removed };
}

function removeConfig(dryRun: boolean): ConfigRemovalResult {
  if (!existsSync(SELFTUNE_CONFIG_DIR)) {
    return { removed: false, path: SELFTUNE_CONFIG_DIR };
  }
  if (dryRun) return { removed: false, path: SELFTUNE_CONFIG_DIR };
  try {
    rmSync(SELFTUNE_CONFIG_DIR, { recursive: true, force: true });
    return { removed: true, path: SELFTUNE_CONFIG_DIR };
  } catch {
    return { removed: false, path: SELFTUNE_CONFIG_DIR };
  }
}

async function npmUninstall(dryRun: boolean): Promise<NpmRemovalResult> {
  if (dryRun) return { uninstalled: false };
  try {
    const process = Bun.spawnSync(["npm", "uninstall", "-g", "selftune"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return { uninstalled: process.exitCode === 0 };
  } catch {
    return { uninstalled: false };
  }
}

const makeUninstallDependencies = (credentialConfigDir: string) =>
  Effect.gen(function* () {
    const credentialStore = yield* CredentialStore;

    return {
      removeRuntimeService,
      removeRemoteCredential: (dryRun: boolean) =>
        removeRemoteCredential(dryRun, credentialStore, credentialConfigDir),
      removeScheduling: (dryRun: boolean) => Effect.promise(() => removeScheduling(dryRun)),
      removeHooks: (dryRun: boolean, settingsPath?: string) =>
        Effect.try({
          try: () => removeHooksFromSettings(dryRun, settingsPath),
          catch: (cause) => uninstallCleanupFailure("remove-hooks", cause),
        }),
      removeAgents: (dryRun: boolean) =>
        Effect.try({
          try: () => removeInstalledAgentFiles({ dryRun }),
          catch: (cause) => uninstallCleanupFailure("remove-agents", cause),
        }),
      // These steps intentionally retain their legacy best-effort contract: they
      // catch operational failures internally and describe the outcome as data.
      removeLogs: (dryRun: boolean) => Effect.sync(() => removeFiles(LOG_FILES, dryRun)),
      removeConfig: (dryRun: boolean) => Effect.sync(() => removeConfig(dryRun)),
      removeMarkers: (dryRun: boolean) => Effect.sync(() => removeFiles(MARKER_FILES, dryRun)),
      uninstallNpm: (dryRun: boolean) => Effect.promise(() => npmUninstall(dryRun)),
    };
  });

export function makeUninstallDependenciesLive(credentialConfigDir = SELFTUNE_CONFIG_DIR) {
  return Layer.effect(UninstallDependencies)(makeUninstallDependencies(credentialConfigDir));
}

export const UninstallDependenciesLive = makeUninstallDependenciesLive();
