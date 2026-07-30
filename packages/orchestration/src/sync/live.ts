import { homedir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { closeSingleton, getDb, getDrizzleDb, LocalDatabaseService } from "@selftune/local-store";
import { DEFAULT_CODEX_HOME } from "@selftune/harness-codex/ingestors/codex-rollout";
import {
  CLAUDE_CODE_PROJECTS_DIR,
  OPENCLAW_AGENTS_DIR,
  PI_SESSIONS_DIR,
  REPAIRED_SKILL_LOG,
  REPAIRED_SKILL_SESSIONS_MARKER,
  SKILL_LOG,
} from "@selftune/runtime/constants";
import { writeCronRunToDb } from "@selftune/runtime/localdb/direct-write";
import { loadOnboardingPreferences } from "@selftune/runtime/onboarding-preferences";

import { syncSourcesLive } from "./live-source.js";
import type { SyncDeps } from "./model.js";
import {
  SyncAlphaUpload,
  SyncAudit,
  SyncCore,
  isSyncInternalFailure,
  syncInternalFailure,
  SyncPreferences,
  type LoadedSyncPreferences,
  type SyncRuntime,
} from "./services.js";

function defaultOpenCodeDataDirectory(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode");
}

function makePreferencesLayer(override?: LoadedSyncPreferences) {
  return Layer.succeed(SyncPreferences, {
    load: Effect.fn("selftune.orchestration.sync.preferences.load")(function* () {
      return yield* Effect.try({
        try: () => {
          if (override) return override;
          const importSources = loadOnboardingPreferences().import_sources;
          return {
            importSources: {
              claude_code: importSources.claude_code,
              codex: importSources.codex,
              opencode: importSources.opencode,
              openclaw: importSources.openclaw,
              pi: importSources.pi,
            },
            defaults: {
              projectsDir: CLAUDE_CODE_PROJECTS_DIR,
              codexHome: DEFAULT_CODEX_HOME,
              opencodeDataDir: defaultOpenCodeDataDirectory(),
              openclawAgentsDir: OPENCLAW_AGENTS_DIR,
              piSessionsDir: PI_SESSIONS_DIR,
              skillLogPath: SKILL_LOG,
              repairedSkillLogPath: REPAIRED_SKILL_LOG,
              repairedSessionsPath: REPAIRED_SKILL_SESSIONS_MARKER,
            },
          };
        },
        catch: (cause) => syncInternalFailure("load-preferences", cause),
      });
    }),
  });
}

function makeCoreLayer(deps: SyncDeps) {
  return Layer.effect(
    SyncCore,
    Effect.gen(function* () {
      const database = yield* LocalDatabaseService;
      return {
        run: Effect.fn("selftune.orchestration.sync.core.run")(function* (options, onProgress) {
          return yield* syncSourcesLive(options, deps, onProgress, database.sqlite).pipe(
            Effect.mapError((cause) =>
              isSyncInternalFailure(cause) ? cause : syncInternalFailure("sync", cause),
            ),
          );
        }),
      };
    }),
  );
}

const auditLayer = Layer.effect(
  SyncAudit,
  Effect.gen(function* () {
    const database = yield* LocalDatabaseService;
    return {
      recordSuccess: Effect.fn("selftune.orchestration.sync.audit.success")(function* (audit) {
        const sources = audit.result.sources;
        yield* Effect.sync(() =>
          writeCronRunToDb(database.sqlite, {
            jobName: "sync",
            startedAt: audit.startedAt,
            elapsedMs: audit.elapsedMs,
            status: "success",
            metrics: {
              total_synced:
                sources.claude.synced +
                sources.codex.synced +
                sources.opencode.synced +
                sources.openclaw.synced +
                sources.pi.synced,
              claude_synced: sources.claude.synced,
              codex_synced: sources.codex.synced,
              opencode_synced: sources.opencode.synced,
              openclaw_synced: sources.openclaw.synced,
              pi_synced: sources.pi.synced,
            },
          }),
        );
      }),
      recordError: Effect.fn("selftune.orchestration.sync.audit.error")(function* (audit) {
        yield* Effect.sync(() =>
          writeCronRunToDb(database.sqlite, {
            jobName: "sync",
            startedAt: audit.startedAt,
            elapsedMs: audit.elapsedMs,
            status: "error",
            error: audit.message,
          }),
        );
      }),
    };
  }),
);

const alphaUploadLayer = Layer.effect(
  SyncAlphaUpload,
  Effect.gen(function* () {
    const database = yield* LocalDatabaseService;
    return {
      run: Effect.fn("selftune.orchestration.sync.alphaUpload")(function* () {
        return yield* Effect.tryPromise({
          try: async () => {
            const [{ loadConfigSync }, { SELFTUNE_CONFIG_PATH }] = await Promise.all([
              import("@selftune/config"),
              import("@selftune/runtime/constants"),
            ]);
            const config = loadConfigSync(SELFTUNE_CONFIG_PATH);
            const identity = config?.alpha;
            if (!identity?.enrolled) return undefined;
            const { prepareCompatibilityExport } =
              await import("@selftune/runtime/alpha-upload/index");
            const prepared = prepareCompatibilityExport(database.sqlite, {
              enrolled: true,
            });
            return {
              enrolled: true,
              prepared: prepared.enqueued,
              sent: 0,
              failed: 0,
              skipped: 0,
            };
          },
          catch: (cause) => syncInternalFailure("alpha-upload", cause),
        });
      }),
    };
  }),
);

const databaseLayer = Layer.effect(
  LocalDatabaseService,
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const sqlite = getDb();
        return { sqlite, drizzle: getDrizzleDb(sqlite) };
      },
      catch: (cause) => syncInternalFailure("database", cause),
    }),
    () => Effect.sync(closeSingleton),
  ),
);

export function makeSyncLiveLayer(
  deps: SyncDeps = {},
  preferences?: LoadedSyncPreferences,
): Layer.Layer<SyncRuntime, ReturnType<typeof syncInternalFailure>> {
  const databaseServicesLayer = Layer.mergeAll(
    makeCoreLayer(deps),
    auditLayer,
    alphaUploadLayer,
  ).pipe(Layer.provide(databaseLayer));
  return Layer.merge(makePreferencesLayer(preferences), databaseServicesLayer);
}

export const syncLiveLayer = makeSyncLiveLayer();
