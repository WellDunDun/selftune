#!/usr/bin/env bun
/**
 * selftune sync — Source-truth telemetry sync across supported agent CLIs.
 *
 * This command is intentionally source-first:
 * - Claude Code transcripts
 * - Codex rollout logs
 * - OpenCode session history
 * - OpenClaw session history
 * - Pi session history
 *
 * After syncing raw session/query/telemetry records, it rebuilds the repaired
 * skill-usage overlay from Claude transcripts and Codex rollouts so monitoring,
 * grading, and evolution are driven from source truth rather than hooks alone.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import * as Effect from "effect/Effect";

import {
  CLAUDE_CODE_PROJECTS_DIR,
  OPENCLAW_AGENTS_DIR,
  PI_SESSIONS_DIR,
  REPAIRED_SKILL_LOG,
  REPAIRED_SKILL_SESSIONS_MARKER,
  SKILL_LOG,
} from "@selftune/runtime/constants";
import { stageCreatorContributionSignals } from "@selftune/runtime/contribution-staging";
import { findTranscriptFiles } from "@selftune/harness-claude-code/ingestors/claude-replay";
import {
  DEFAULT_CODEX_HOME,
  findRolloutFiles,
} from "@selftune/harness-codex/ingestors/codex-rollout";
import {
  HarnessSourceRegistry,
  HarnessSourceSyncFailure,
  harnessSourceSyncFailure,
} from "@selftune/harness-core/source-adapter";
import type { HarnessSourceSyncResult } from "@selftune/harness-core/source-adapter";
import { getDb } from "@selftune/local-store";
import { querySkillUsageRecords } from "@selftune/runtime/localdb/queries";
import { loadOnboardingPreferences } from "@selftune/runtime/onboarding-preferences";
import {
  persistRepairedSkillUsageToDb,
  rebuildSkillUsageFromCodexRollouts,
  rebuildSkillUsageFromTranscripts,
} from "./repair/skill-usage.js";
import type { SkillUsageRecord } from "@selftune/runtime/types";
import { readJsonl } from "@selftune/runtime/utils/jsonl";
import { writeRepairedSkillUsageRecords } from "@selftune/runtime/utils/skill-log";
import type {
  FileListCache,
  SyncDeps,
  SyncOptions,
  SyncPhaseTiming,
  SyncProgressCallback,
  SyncResult,
  SyncStepResult,
} from "./sync/model.js";
import { SyncInternalFailure, syncInternalFailure } from "./sync/services.js";

const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const DEFAULT_OPENCODE_DATA_DIR = join(XDG_DATA_HOME, "opencode");

interface ConfiguredHarnessSource {
  readonly adapterId: string;
  readonly enabled: (options: SyncOptions) => boolean;
  readonly sourceRoot: (options: SyncOptions) => string;
}

const configuredHarnessSources = {
  claude: {
    adapterId: "claude_code",
    enabled: (options) => options.syncClaude,
    sourceRoot: (options) => options.projectsDir,
  },
  codex: {
    adapterId: "codex",
    enabled: (options) => options.syncCodex,
    sourceRoot: (options) => options.codexHome,
  },
  opencode: {
    adapterId: "opencode",
    enabled: (options) => options.syncOpenCode,
    sourceRoot: (options) => options.opencodeDataDir,
  },
  openclaw: {
    adapterId: "openclaw",
    enabled: (options) => options.syncOpenClaw,
    sourceRoot: (options) => options.openclawAgentsDir,
  },
  pi: {
    adapterId: "pi",
    enabled: (options) => options.syncPi,
    sourceRoot: (options) => options.piSessionsDir,
  },
} satisfies Record<keyof SyncResult["sources"], ConfiguredHarnessSource>;

const disabledSourceResult: SyncStepResult = {
  available: false,
  scanned: 0,
  synced: 0,
  skipped: 0,
};

export type {
  SyncDeps,
  SyncOptions,
  SyncPhaseTiming,
  SyncProgressCallback,
  SyncResult,
  SyncStepResult,
} from "./sync/model.js";

export function createDefaultSyncOptions(overrides: Partial<SyncOptions> = {}): SyncOptions {
  const importSources = loadOnboardingPreferences().import_sources;
  return {
    projectsDir: CLAUDE_CODE_PROJECTS_DIR,
    codexHome: DEFAULT_CODEX_HOME,
    opencodeDataDir: DEFAULT_OPENCODE_DATA_DIR,
    openclawAgentsDir: OPENCLAW_AGENTS_DIR,
    piSessionsDir: PI_SESSIONS_DIR,
    skillLogPath: SKILL_LOG,
    repairedSkillLogPath: REPAIRED_SKILL_LOG,
    repairedSessionsPath: REPAIRED_SKILL_SESSIONS_MARKER,
    dryRun: false,
    force: false,
    syncClaude: importSources.claude_code,
    syncCodex: importSources.codex,
    syncOpenCode: importSources.opencode,
    syncOpenClaw: importSources.openclaw,
    syncPi: importSources.pi,
    rebuildSkillUsage: true,
    ...overrides,
  };
}

function rebuildSkillUsageOverlay(
  options: SyncOptions,
  onProgress?: SyncProgressCallback,
  cache?: FileListCache,
  db: ReturnType<typeof getDb> = getDb(),
): {
  repairedSessions: number;
  repairedRecords: number;
  codexRepairedRecords: number;
} {
  // Reuse cached file lists from ingest phase when available to avoid re-walking the filesystem
  const transcriptPaths = [
    ...(cache?.authoritativeFiles.claude_code ??
      findTranscriptFiles(options.projectsDir, options.since)),
  ];
  const rolloutPaths = [
    ...(cache?.authoritativeFiles.codex ?? findRolloutFiles(options.codexHome, options.since)),
  ];

  const reusedClaude = cache?.authoritativeFiles.claude_code ? " (cached)" : "";
  const reusedCodex = cache?.authoritativeFiles.codex ? " (cached)" : "";
  onProgress?.(
    `repairing from ${transcriptPaths.length} transcripts${reusedClaude}, ${rolloutPaths.length} rollouts${reusedCodex}`,
  );

  let rawSkillRecords: SkillUsageRecord[];
  if (options.skillLogPath === SKILL_LOG) {
    try {
      rawSkillRecords = querySkillUsageRecords(db);
    } catch {
      rawSkillRecords = readJsonl<SkillUsageRecord>(options.skillLogPath);
    }
  } else {
    // Intentional JSONL fallback: custom --skill-log path overrides SQLite reads
    rawSkillRecords = readJsonl<SkillUsageRecord>(options.skillLogPath);
  }
  const { repairedRecords, repairedSessionIds } = rebuildSkillUsageFromTranscripts(
    transcriptPaths,
    rawSkillRecords,
    process.env.HOME ?? "",
    options.codexHome,
  );
  const { records: codexRecords, sessionIds: codexSessionIds } = rebuildSkillUsageFromCodexRollouts(
    rolloutPaths,
    rawSkillRecords,
    process.env.HOME ?? "",
    options.codexHome,
  );

  for (const sessionId of codexSessionIds) repairedSessionIds.add(sessionId);
  repairedRecords.push(...codexRecords);

  if (!options.dryRun) {
    persistRepairedSkillUsageToDb(db, repairedRecords);
    writeRepairedSkillUsageRecords(
      repairedRecords,
      repairedSessionIds,
      options.repairedSkillLogPath,
      options.repairedSessionsPath,
    );
  }

  onProgress?.(
    `repaired ${repairedRecords.length} records across ${repairedSessionIds.size} sessions`,
  );

  return {
    repairedSessions: repairedSessionIds.size,
    repairedRecords: repairedRecords.length,
    codexRepairedRecords: codexRecords.length,
  };
}

function timePhase<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  timings: SyncPhaseTiming[],
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const start = performance.now();
    const result = yield* effect;
    timings.push({
      phase: name,
      elapsed_ms: Math.round(performance.now() - start),
    });
    return result;
  });
}

function publicSourceResult(result: HarnessSourceSyncResult): SyncStepResult {
  return {
    available: result.available,
    scanned: result.scanned,
    synced: result.synced,
    skipped: result.skipped,
  };
}

const syncConfiguredHarnessSource = Effect.fn("selftune.orchestration.sync.source")(function* <R>(
  configured: ConfiguredHarnessSource,
  options: SyncOptions,
  registry: HarnessSourceRegistry<R> | undefined,
  onProgress: SyncProgressCallback | undefined,
  cache: FileListCache,
  timings: SyncPhaseTiming[],
): Effect.fn.Return<SyncStepResult, HarnessSourceSyncFailure, R> {
  if (!configured.enabled(options)) return disabledSourceResult;

  const adapter = registry?.get(configured.adapterId);
  if (adapter === undefined) {
    return yield* Effect.fail(
      harnessSourceSyncFailure(
        configured.adapterId,
        "resolve source adapter",
        new Error(`No source adapter is registered for ${configured.adapterId}.`),
      ),
    );
  }

  return yield* timePhase(
    adapter.phase,
    adapter
      .sync(
        {
          sourceRoot: configured.sourceRoot(options),
          since: options.since,
          dryRun: options.dryRun,
          force: options.force,
          skillLogPath: options.skillLogPath,
        },
        onProgress,
      )
      .pipe(
        Effect.map((result) => {
          if (result.authoritativeFiles !== undefined) {
            cache.authoritativeFiles[adapter.id] = result.authoritativeFiles;
          }
          return publicSourceResult(result);
        }),
      ),
    timings,
  );
});

export const syncSources = Effect.fn("selftune.orchestration.sync.sources")(function* <R>(
  options: SyncOptions,
  deps: SyncDeps<R> = {},
  onProgress?: SyncProgressCallback,
  db?: Database,
): Effect.fn.Return<SyncResult, HarnessSourceSyncFailure | SyncInternalFailure, R> {
  const totalStart = performance.now();
  const timings: SyncPhaseTiming[] = [];
  const cache: FileListCache = { authoritativeFiles: {} };

  const sourceRegistry = deps.sourceRegistry;
  const runRepair = deps.rebuildSkillUsage;
  const runCreatorContributions = deps.stageCreatorContributions;
  const database =
    db ??
    (yield* Effect.try({
      try: getDb,
      catch: (cause) => syncInternalFailure("open source-sync database", cause),
    }));

  yield* Effect.try({
    try: () => onProgress?.("starting sync..."),
    catch: (cause) => syncInternalFailure("report source-sync progress", cause),
  });

  const claude = yield* syncConfiguredHarnessSource(
    configuredHarnessSources.claude,
    options,
    sourceRegistry,
    onProgress,
    cache,
    timings,
  );
  const codex = yield* syncConfiguredHarnessSource(
    configuredHarnessSources.codex,
    options,
    sourceRegistry,
    onProgress,
    cache,
    timings,
  );
  const opencode = yield* syncConfiguredHarnessSource(
    configuredHarnessSources.opencode,
    options,
    sourceRegistry,
    onProgress,
    cache,
    timings,
  );
  const openclaw = yield* syncConfiguredHarnessSource(
    configuredHarnessSources.openclaw,
    options,
    sourceRegistry,
    onProgress,
    cache,
    timings,
  );
  const pi = yield* syncConfiguredHarnessSource(
    configuredHarnessSources.pi,
    options,
    sourceRegistry,
    onProgress,
    cache,
    timings,
  );

  const repair = options.rebuildSkillUsage
    ? yield* timePhase(
        "repair",
        Effect.try({
          try: () =>
            runRepair
              ? runRepair(options)
              : rebuildSkillUsageOverlay(options, onProgress, cache, database),
          catch: (cause) => syncInternalFailure("rebuild skill usage", cause),
        }),
        timings,
      )
    : { repairedSessions: 0, repairedRecords: 0, codexRepairedRecords: 0 };

  const creatorContributions = yield* timePhase(
    "creator_contributions",
    Effect.try({
      try: () => {
        const staged = runCreatorContributions
          ? runCreatorContributions(database, { dryRun: options.dryRun })
          : stageCreatorContributionSignals(database, { dryRun: options.dryRun });
        return {
          ran: true,
          eligible_skills: staged.eligible_skills,
          built_signals: staged.built_signals,
          staged_signals: staged.staged_signals,
        };
      },
      catch: (cause) => syncInternalFailure("stage creator contributions", cause),
    }),
    timings,
  );

  const totalElapsed = Math.round(performance.now() - totalStart);

  const syncResult: SyncResult = {
    since: options.since ? options.since.toISOString() : null,
    dry_run: options.dryRun,
    sources: { claude, codex, opencode, openclaw, pi },
    repair: {
      ran: options.rebuildSkillUsage,
      repaired_sessions: repair.repairedSessions,
      repaired_records: repair.repairedRecords,
      codex_repaired_records: repair.codexRepairedRecords,
    },
    creator_contributions: creatorContributions,
    timings,
    total_elapsed_ms: totalElapsed,
  };

  return syncResult;
});
