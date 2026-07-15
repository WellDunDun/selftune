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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  CLAUDE_CODE_MARKER,
  CLAUDE_CODE_PROJECTS_DIR,
  CODEX_INGEST_MARKER,
  OPENCLAW_AGENTS_DIR,
  OPENCLAW_INGEST_MARKER,
  OPENCODE_INGEST_MARKER,
  PI_INGEST_MARKER,
  PI_SESSIONS_DIR,
  QUERY_LOG,
  REPAIRED_SKILL_LOG,
  REPAIRED_SKILL_SESSIONS_MARKER,
  SKILL_LOG,
  TELEMETRY_LOG,
} from "@selftune/runtime/constants";
import { stageCreatorContributionSignals } from "@selftune/runtime/contribution-staging";
import {
  findTranscriptFiles,
  parseSession,
  writeSession as writeClaudeReplaySession,
} from "@selftune/harness-claude-code/ingestors/claude-replay";
import {
  DEFAULT_CODEX_HOME,
  findSkillNames as findCodexSkillNames,
  findRolloutFiles,
  ingestFile as ingestCodexRollout,
  parseRolloutFile,
} from "@selftune/harness-codex/ingestors/codex-rollout";
import {
  findOpenClawSessions,
  findOpenClawSkillNames,
  parseOpenClawSession,
  writeSession as writeOpenClawSession,
} from "@selftune/harness-openclaw/ingestors/openclaw-ingest";
import {
  findSkillNames as findOpenCodeSkillNames,
  readSessionsFromJsonFiles,
  readSessionsFromSqlite,
  writeSession as writeOpenCodeSession,
} from "@selftune/harness-opencode/ingestors/opencode-ingest";
import {
  findPiSessions,
  findPiSkillNames,
  parsePiSession,
  writeSession as writePiSession,
} from "@selftune/harness-pi/ingestors/pi-ingest";
import { getDb } from "@selftune/runtime/localdb/db";
import { writeCronRunToDb } from "@selftune/runtime/localdb/direct-write";
import { querySkillUsageRecords } from "@selftune/runtime/localdb/queries";
import { loadOnboardingPreferences } from "@selftune/runtime/onboarding-preferences";
import type {
  SourceSyncRequest,
  SyncPhaseTiming,
  SyncResult,
  SyncStepResult,
} from "@selftune/runtime/source-sync";
import {
  persistRepairedSkillUsageToDb,
  rebuildSkillUsageFromCodexRollouts,
  rebuildSkillUsageFromTranscripts,
} from "./repair/skill-usage.js";
import type { SkillUsageRecord } from "@selftune/runtime/types";
import { CLIError, handleCLIError } from "@selftune/runtime/utils/cli-error";
import { loadMarker, readJsonl, saveMarker } from "@selftune/runtime/utils/jsonl";
import { writeRepairedSkillUsageRecords } from "@selftune/runtime/utils/skill-log";

const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const DEFAULT_OPENCODE_DATA_DIR = join(XDG_DATA_HOME, "opencode");

export type { SyncPhaseTiming, SyncResult, SyncStepResult } from "@selftune/runtime/source-sync";

export interface SyncOptions {
  projectsDir: string;
  codexHome: string;
  opencodeDataDir: string;
  openclawAgentsDir: string;
  piSessionsDir: string;
  skillLogPath: string;
  repairedSkillLogPath: string;
  repairedSessionsPath: string;
  since?: Date;
  dryRun: boolean;
  force: boolean;
  syncClaude: boolean;
  syncCodex: boolean;
  syncOpenCode: boolean;
  syncOpenClaw: boolean;
  syncPi: boolean;
  rebuildSkillUsage: boolean;
}

export type SyncProgressCallback = (message: string) => void;

export interface SyncDeps {
  syncClaude?: (options: SyncOptions) => SyncStepResult;
  syncCodex?: (options: SyncOptions) => SyncStepResult;
  syncOpenCode?: (options: SyncOptions) => SyncStepResult;
  syncOpenClaw?: (options: SyncOptions) => SyncStepResult;
  syncPi?: (options: SyncOptions) => SyncStepResult;
  rebuildSkillUsage?: (options: SyncOptions) => {
    repairedSessions: number;
    repairedRecords: number;
    codexRepairedRecords: number;
  };
  stageCreatorContributions?: (
    db: ReturnType<typeof getDb>,
    options: { dryRun: boolean },
  ) => {
    eligible_skills: number;
    built_signals: number;
    staged_signals: number;
  };
}

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

export function runSourceSync(request: SourceSyncRequest = {}): SyncResult {
  return syncSources(
    createDefaultSyncOptions({
      force: request.force ?? false,
      dryRun: request.dryRun ?? false,
    }),
  );
}

/** Shared file-list cache so repair can reuse the ingest-phase scan. */
interface FileListCache {
  claudeTranscripts?: string[];
  codexRollouts?: string[];
}

function syncClaudeSource(
  options: SyncOptions,
  onProgress?: SyncProgressCallback,
  cache?: FileListCache,
): SyncStepResult {
  if (!existsSync(options.projectsDir)) {
    return { available: false, scanned: 0, synced: 0, skipped: 0 };
  }

  onProgress?.("scanning Claude transcripts...");
  const transcriptFiles = findTranscriptFiles(options.projectsDir, options.since);
  if (cache) cache.claudeTranscripts = transcriptFiles;

  const alreadyIngested = options.force ? new Set<string>() : loadMarker(CLAUDE_CODE_MARKER);
  const pending = transcriptFiles.filter((f) => !alreadyIngested.has(f));
  onProgress?.(`found ${transcriptFiles.length} transcripts, ${pending.length} pending`);

  const newIngested = new Set<string>();
  let synced = 0;
  let skipped = 0;

  for (const transcriptFile of pending) {
    const parsed = parseSession(transcriptFile);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    writeClaudeReplaySession(
      parsed,
      options.dryRun,
      QUERY_LOG,
      TELEMETRY_LOG,
      options.skillLogPath,
    );
    newIngested.add(transcriptFile);
    synced += 1;
  }

  if (!options.dryRun && newIngested.size > 0) {
    saveMarker(CLAUDE_CODE_MARKER, new Set([...alreadyIngested, ...newIngested]));
  }

  return {
    available: true,
    scanned: transcriptFiles.length,
    synced,
    skipped,
  };
}

function syncCodexSource(
  options: SyncOptions,
  onProgress?: SyncProgressCallback,
  cache?: FileListCache,
): SyncStepResult {
  onProgress?.("scanning Codex rollouts...");
  const rolloutFiles = findRolloutFiles(options.codexHome, options.since);
  if (cache) cache.codexRollouts = rolloutFiles;

  if (rolloutFiles.length === 0 && !existsSync(join(options.codexHome, "sessions"))) {
    return { available: false, scanned: 0, synced: 0, skipped: 0 };
  }

  const alreadyIngested = options.force ? new Set<string>() : loadMarker(CODEX_INGEST_MARKER);
  const pending = rolloutFiles.filter((f) => !alreadyIngested.has(f));
  onProgress?.(`found ${rolloutFiles.length} rollouts, ${pending.length} pending`);

  const skillNames = findCodexSkillNames();
  const newIngested = new Set<string>();
  let synced = 0;
  let skipped = 0;

  for (const rolloutFile of pending) {
    const parsed = parseRolloutFile(rolloutFile, skillNames);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    ingestCodexRollout(parsed, options.dryRun, QUERY_LOG, TELEMETRY_LOG, options.skillLogPath);
    newIngested.add(rolloutFile);
    synced += 1;
  }

  if (!options.dryRun && newIngested.size > 0) {
    saveMarker(CODEX_INGEST_MARKER, new Set([...alreadyIngested, ...newIngested]));
  }

  return {
    available: true,
    scanned: rolloutFiles.length,
    synced,
    skipped,
  };
}

function syncOpenCodeSource(
  options: SyncOptions,
  onProgress?: SyncProgressCallback,
): SyncStepResult {
  if (!existsSync(options.opencodeDataDir)) {
    return { available: false, scanned: 0, synced: 0, skipped: 0 };
  }

  onProgress?.("scanning OpenCode sessions...");
  const dbPath = join(options.opencodeDataDir, "opencode.db");
  const storageDir = join(options.opencodeDataDir, "storage");
  const skillNames = findOpenCodeSkillNames();
  const sinceTs = options.since ? options.since.getTime() / 1000 : null;
  const allSessions = existsSync(dbPath)
    ? readSessionsFromSqlite(dbPath, sinceTs, skillNames)
    : existsSync(storageDir)
      ? readSessionsFromJsonFiles(storageDir, sinceTs, skillNames)
      : [];

  if (allSessions.length === 0 && !existsSync(dbPath) && !existsSync(storageDir)) {
    return { available: false, scanned: 0, synced: 0, skipped: 0 };
  }

  const alreadyIngested = options.force ? new Set<string>() : loadMarker(OPENCODE_INGEST_MARKER);
  const pending = allSessions.filter((session) => !alreadyIngested.has(session.session_id));
  onProgress?.(`found ${allSessions.length} sessions, ${pending.length} pending`);
  const newIngested = new Set<string>();

  for (const session of pending) {
    writeOpenCodeSession(session, options.dryRun, QUERY_LOG, TELEMETRY_LOG, options.skillLogPath);
    newIngested.add(session.session_id);
  }

  if (!options.dryRun && newIngested.size > 0) {
    saveMarker(OPENCODE_INGEST_MARKER, new Set([...alreadyIngested, ...newIngested]));
  }

  return {
    available: true,
    scanned: allSessions.length,
    synced: pending.length,
    skipped: 0,
  };
}

function syncOpenClawSource(
  options: SyncOptions,
  onProgress?: SyncProgressCallback,
): SyncStepResult {
  if (!existsSync(options.openclawAgentsDir)) {
    return { available: false, scanned: 0, synced: 0, skipped: 0 };
  }

  onProgress?.("scanning OpenClaw sessions...");
  const sinceTs = options.since ? options.since.getTime() : null;
  const allSessions = findOpenClawSessions(options.openclawAgentsDir, sinceTs);
  const skillNames = findOpenClawSkillNames(options.openclawAgentsDir);
  const alreadyIngested = options.force ? new Set<string>() : loadMarker(OPENCLAW_INGEST_MARKER);
  const pending = allSessions.filter((session) => !alreadyIngested.has(session.sessionId));
  onProgress?.(`found ${allSessions.length} sessions, ${pending.length} pending`);
  const newIngested = new Set<string>();
  let synced = 0;
  let skipped = 0;

  for (const sessionFile of pending) {
    const session = parseOpenClawSession(sessionFile.filePath, skillNames);
    if (!session.session_id || !session.timestamp) {
      skipped += 1;
      continue;
    }
    writeOpenClawSession(session, options.dryRun, QUERY_LOG, TELEMETRY_LOG, options.skillLogPath);
    newIngested.add(sessionFile.sessionId);
    synced += 1;
  }

  if (!options.dryRun && newIngested.size > 0) {
    saveMarker(OPENCLAW_INGEST_MARKER, new Set([...alreadyIngested, ...newIngested]));
  }

  return {
    available: true,
    scanned: allSessions.length,
    synced,
    skipped,
  };
}

function syncPiSource(options: SyncOptions, onProgress?: SyncProgressCallback): SyncStepResult {
  if (!existsSync(options.piSessionsDir)) {
    return { available: false, scanned: 0, synced: 0, skipped: 0 };
  }

  onProgress?.("scanning Pi sessions...");
  const sinceTs = options.since ? options.since.getTime() : null;
  const allSessions = findPiSessions(options.piSessionsDir, sinceTs);
  const skillNames = findPiSkillNames();
  const alreadyIngested = options.force ? new Set<string>() : loadMarker(PI_INGEST_MARKER);
  const pending = allSessions.filter((session) => !alreadyIngested.has(session.sessionId));
  onProgress?.(`found ${allSessions.length} sessions, ${pending.length} pending`);
  const newIngested = new Set<string>();
  let synced = 0;
  let skipped = 0;

  for (const sessionFile of pending) {
    const session = parsePiSession(sessionFile.filePath, skillNames);
    if (!session.session_id || !session.timestamp) {
      skipped += 1;
      continue;
    }
    writePiSession(session, options.dryRun);
    newIngested.add(sessionFile.sessionId);
    synced += 1;
  }

  if (!options.dryRun && newIngested.size > 0) {
    saveMarker(PI_INGEST_MARKER, new Set([...alreadyIngested, ...newIngested]));
  }

  return {
    available: true,
    scanned: allSessions.length,
    synced,
    skipped,
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
  const transcriptPaths =
    cache?.claudeTranscripts ?? findTranscriptFiles(options.projectsDir, options.since);
  const rolloutPaths = cache?.codexRollouts ?? findRolloutFiles(options.codexHome, options.since);

  const reusedClaude = cache?.claudeTranscripts ? " (cached)" : "";
  const reusedCodex = cache?.codexRollouts ? " (cached)" : "";
  onProgress?.(
    `repairing from ${transcriptPaths.length} transcripts${reusedClaude}, ${rolloutPaths.length} rollouts${reusedCodex}`,
  );

  let rawSkillRecords: SkillUsageRecord[];
  if (options.skillLogPath === SKILL_LOG) {
    try {
      rawSkillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
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

function timePhase<T>(name: string, fn: () => T, timings: SyncPhaseTiming[]): T {
  const start = performance.now();
  const result = fn();
  timings.push({
    phase: name,
    elapsed_ms: Math.round(performance.now() - start),
  });
  return result;
}

export function syncSources(
  options: SyncOptions,
  deps: SyncDeps = {},
  onProgress?: SyncProgressCallback,
): SyncResult {
  const totalStart = performance.now();
  const timings: SyncPhaseTiming[] = [];
  const cache: FileListCache = {};

  const runClaude = deps.syncClaude;
  const runCodex = deps.syncCodex;
  const runOpenCode = deps.syncOpenCode;
  const runOpenClaw = deps.syncOpenClaw;
  const runPi = deps.syncPi;
  const runRepair = deps.rebuildSkillUsage;
  const runCreatorContributions = deps.stageCreatorContributions;
  const db = getDb();

  const disabledStep: SyncStepResult = {
    available: false,
    scanned: 0,
    synced: 0,
    skipped: 0,
  };

  onProgress?.("starting sync...");

  const claude = options.syncClaude
    ? timePhase(
        "claude",
        () => (runClaude ? runClaude(options) : syncClaudeSource(options, onProgress, cache)),
        timings,
      )
    : disabledStep;

  const codex = options.syncCodex
    ? timePhase(
        "codex",
        () => (runCodex ? runCodex(options) : syncCodexSource(options, onProgress, cache)),
        timings,
      )
    : disabledStep;

  const opencode = options.syncOpenCode
    ? timePhase(
        "opencode",
        () => (runOpenCode ? runOpenCode(options) : syncOpenCodeSource(options, onProgress)),
        timings,
      )
    : disabledStep;

  const openclaw = options.syncOpenClaw
    ? timePhase(
        "openclaw",
        () => (runOpenClaw ? runOpenClaw(options) : syncOpenClawSource(options, onProgress)),
        timings,
      )
    : disabledStep;

  const pi = options.syncPi
    ? timePhase("pi", () => (runPi ? runPi(options) : syncPiSource(options, onProgress)), timings)
    : disabledStep;

  const repair = options.rebuildSkillUsage
    ? timePhase(
        "repair",
        () =>
          runRepair ? runRepair(options) : rebuildSkillUsageOverlay(options, onProgress, cache, db),
        timings,
      )
    : { repairedSessions: 0, repairedRecords: 0, codexRepairedRecords: 0 };

  const creatorContributions = timePhase(
    "creator_contributions",
    () => {
      const staged = runCreatorContributions
        ? runCreatorContributions(db, { dryRun: options.dryRun })
        : stageCreatorContributionSignals(db, { dryRun: options.dryRun });
      return {
        ran: true,
        eligible_skills: staged.eligible_skills,
        built_signals: staged.built_signals,
        staged_signals: staged.staged_signals,
      };
    },
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
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatStepLine(label: string, step: SyncStepResult, timing?: SyncPhaseTiming): string {
  if (!step.available) return `  ${label}: not available`;
  const parts = [`scanned ${step.scanned}`];
  if (step.synced > 0) parts.push(`synced ${step.synced}`);
  if (step.skipped > 0) parts.push(`skipped ${step.skipped}`);
  const time = timing ? ` (${formatMs(timing.elapsed_ms)})` : "";
  return `  ${label}: ${parts.join(", ")}${time}`;
}

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "projects-dir": { type: "string", default: CLAUDE_CODE_PROJECTS_DIR },
      "codex-home": { type: "string", default: DEFAULT_CODEX_HOME },
      "opencode-data-dir": {
        type: "string",
        default: DEFAULT_OPENCODE_DATA_DIR,
      },
      "openclaw-agents-dir": { type: "string", default: OPENCLAW_AGENTS_DIR },
      "pi-sessions-dir": { type: "string", default: PI_SESSIONS_DIR },
      "skill-log": { type: "string", default: SKILL_LOG },
      "repaired-skill-log": { type: "string", default: REPAIRED_SKILL_LOG },
      "repaired-sessions-marker": {
        type: "string",
        default: REPAIRED_SKILL_SESSIONS_MARKER,
      },
      since: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "no-claude": { type: "boolean", default: false },
      "no-codex": { type: "boolean", default: false },
      "no-opencode": { type: "boolean", default: false },
      "no-openclaw": { type: "boolean", default: false },
      "no-pi": { type: "boolean", default: false },
      "no-repair": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune sync — Source-truth telemetry sync

Usage:
  selftune sync [options]

Options:
  --projects-dir <dir>             Claude transcript directory (default: ~/.claude/projects)
  --codex-home <dir>               Codex home directory (default: ~/.codex)
  --opencode-data-dir <dir>        OpenCode data directory
  --openclaw-agents-dir <dir>      OpenClaw agents directory
  --pi-sessions-dir <dir>          Pi sessions directory
  --skill-log <path>               Raw skill usage log path
  --repaired-skill-log <path>      Repaired overlay log path
  --repaired-sessions-marker <p>   Repaired session marker path
  --since <date>                   Only sync sessions modified on/after date
  --dry-run                        Show summary without writing files
  --force                          Ignore per-source markers and rescan everything
  --no-claude                      Skip Claude transcript replay
  --no-codex                       Skip Codex rollout ingest
  --no-opencode                    Skip OpenCode ingest
  --no-openclaw                    Skip OpenClaw ingest
  --no-pi                          Skip Pi ingest
  --no-repair                      Skip rebuilt skill-usage overlay
  --json                           Output raw JSON instead of human-readable summary
  -h, --help                       Show this help`);
    process.exit(0);
  }

  let since: Date | undefined;
  if (values.since) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) {
      throw new CLIError(
        `Invalid --since date: ${values.since}`,
        "INVALID_FLAG",
        "selftune sync --since 2026-01-01",
      );
    }
  }

  // JSON output: explicit --json flag, or auto when stdout is not a TTY (preserves contract for automation)
  const jsonOutput = (values.json ?? false) || !process.stdout.isTTY;

  const onProgress: SyncProgressCallback | undefined = jsonOutput
    ? undefined
    : (msg) => {
        process.stderr.write(`  ${msg}\n`);
      };

  if (!jsonOutput) {
    const flags: string[] = [];
    if (values.force) flags.push("--force");
    if (values["dry-run"]) flags.push("--dry-run");
    if (since) flags.push(`--since ${values.since}`);
    process.stderr.write(`selftune sync${flags.length ? ` ${flags.join(" ")}` : ""}\n`);
  }

  const syncStartedAt = new Date();
  const syncStart = performance.now();
  let result: SyncResult;
  try {
    const importSources = loadOnboardingPreferences().import_sources;
    result = syncSources(
      createDefaultSyncOptions({
        projectsDir: values["projects-dir"] ?? CLAUDE_CODE_PROJECTS_DIR,
        codexHome: values["codex-home"] ?? DEFAULT_CODEX_HOME,
        opencodeDataDir: values["opencode-data-dir"] ?? DEFAULT_OPENCODE_DATA_DIR,
        openclawAgentsDir: values["openclaw-agents-dir"] ?? OPENCLAW_AGENTS_DIR,
        piSessionsDir: values["pi-sessions-dir"] ?? PI_SESSIONS_DIR,
        skillLogPath: values["skill-log"] ?? SKILL_LOG,
        repairedSkillLogPath: values["repaired-skill-log"] ?? REPAIRED_SKILL_LOG,
        repairedSessionsPath: values["repaired-sessions-marker"] ?? REPAIRED_SKILL_SESSIONS_MARKER,
        since,
        dryRun: values["dry-run"] ?? false,
        force: values.force ?? false,
        syncClaude: importSources.claude_code && !(values["no-claude"] ?? false),
        syncCodex: importSources.codex && !(values["no-codex"] ?? false),
        syncOpenCode: importSources.opencode && !(values["no-opencode"] ?? false),
        syncOpenClaw: importSources.openclaw && !(values["no-openclaw"] ?? false),
        syncPi: importSources.pi && !(values["no-pi"] ?? false),
        rebuildSkillUsage: !(values["no-repair"] ?? false),
      }),
      {},
      onProgress,
    );
  } catch (err) {
    const syncElapsed = Math.round(performance.now() - syncStart);
    const message = err instanceof Error ? err.message : String(err);
    writeCronRunToDb(getDb(), {
      jobName: "sync",
      startedAt: syncStartedAt.toISOString(),
      elapsedMs: syncElapsed,
      status: "error",
      error: message,
    });
    throw err;
  }

  // Log successful sync run to unified cron_runs timeline
  const syncElapsed = Math.round(performance.now() - syncStart);
  const s = result.sources;
  writeCronRunToDb(getDb(), {
    jobName: "sync",
    startedAt: syncStartedAt.toISOString(),
    elapsedMs: syncElapsed,
    status: "success",
    metrics: {
      total_synced:
        s.claude.synced + s.codex.synced + s.opencode.synced + s.openclaw.synced + s.pi.synced,
      claude_synced: s.claude.synced,
      codex_synced: s.codex.synced,
      opencode_synced: s.opencode.synced,
      openclaw_synced: s.openclaw.synced,
      pi_synced: s.pi.synced,
    },
  });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const timingMap = new Map(result.timings.map((t) => [t.phase, t]));

    process.stderr.write("\nSources:\n");
    process.stderr.write(
      `${formatStepLine("Claude", result.sources.claude, timingMap.get("claude"))}\n`,
    );
    process.stderr.write(
      `${formatStepLine("Codex", result.sources.codex, timingMap.get("codex"))}\n`,
    );
    process.stderr.write(
      `${formatStepLine("OpenCode", result.sources.opencode, timingMap.get("opencode"))}\n`,
    );
    process.stderr.write(
      `${formatStepLine("OpenClaw", result.sources.openclaw, timingMap.get("openclaw"))}\n`,
    );
    process.stderr.write(`${formatStepLine("Pi", result.sources.pi, timingMap.get("pi"))}\n`);

    if (result.repair.ran) {
      const repairTiming = timingMap.get("repair");
      const repairTime = repairTiming ? ` (${formatMs(repairTiming.elapsed_ms)})` : "";
      process.stderr.write(
        `\nRepair: ${result.repair.repaired_records} records, ` +
          `${result.repair.repaired_sessions} sessions${repairTime}\n`,
      );
    }

    if (
      result.creator_contributions.eligible_skills > 0 ||
      result.creator_contributions.built_signals > 0
    ) {
      const contributionTiming = timingMap.get("creator_contributions");
      const contributionTime = contributionTiming
        ? ` (${formatMs(contributionTiming.elapsed_ms)})`
        : "";
      process.stderr.write(
        `Creator contributions: ${result.creator_contributions.built_signals} signals from ` +
          `${result.creator_contributions.eligible_skills} skills` +
          (result.dry_run
            ? " ready to stage"
            : ` staged=${result.creator_contributions.staged_signals}`) +
          `${contributionTime}\n`,
      );
    }

    process.stderr.write(`\nDone in ${formatMs(result.total_elapsed_ms)}\n`);
  }

  // Trigger alpha upload if enrolled — pushes freshly synced data to cloud
  if (!result.dry_run) {
    try {
      const { readAlphaIdentity } = await import("@selftune/runtime/alpha-identity");
      const { SELFTUNE_CONFIG_PATH } = await import("@selftune/runtime/constants");
      const identity = readAlphaIdentity(SELFTUNE_CONFIG_PATH);
      if (identity?.enrolled && identity.api_key) {
        const { runUploadCycle } = await import("@selftune/runtime/alpha-upload/index");
        const { getDb } = await import("@selftune/runtime/localdb/db");
        const db = getDb();
        const uploadSummary = await runUploadCycle(db, {
          enrolled: true,
          userId: identity.user_id,
          apiKey: identity.api_key,
        });
        if (!jsonOutput) {
          process.stderr.write(
            `\nAlpha upload: prepared=${uploadSummary.prepared}, sent=${uploadSummary.sent}, failed=${uploadSummary.failed}\n`,
          );
        } else {
          console.log(JSON.stringify({ code: "alpha_upload", ...uploadSummary }));
        }
      }
    } catch {
      // fail-open: upload failure should not break sync
    }
  }
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
