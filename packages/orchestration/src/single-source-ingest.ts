import { homedir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { DEFAULT_CODEX_HOME } from "@selftune/harness-codex/ingestors/codex-rollout";
import {
  CLAUDE_CODE_PROJECTS_DIR,
  OPENCLAW_AGENTS_DIR,
  PI_SESSIONS_DIR,
  REPAIRED_SKILL_LOG,
  REPAIRED_SKILL_SESSIONS_MARKER,
  SKILL_LOG,
} from "@selftune/runtime/constants";

import { syncSourcesLive } from "./sync/live-source.js";
import type {
  SyncOptions,
  SyncProgressCallback,
  SyncResult,
  SyncStepResult,
} from "./sync/model.js";

export const singleSourceIngestSources = ["claude_code", "codex", "opencode", "pi"] as const;

export type SingleSourceIngestSource = (typeof singleSourceIngestSources)[number];

export interface SingleSourceIngestRequest {
  readonly sourceRoot?: string;
  readonly since?: Date;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly skillLogPath?: string;
}

const defaultOpenCodeDataDirectory = () =>
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");

/**
 * Builds a deterministic source-sync request for an explicit ingest command.
 * This deliberately bypasses onboarding preferences: choosing an ingest source
 * on the command line is itself the enablement decision.
 */
export function createSingleSourceIngestOptions(
  source: SingleSourceIngestSource,
  request: SingleSourceIngestRequest,
): SyncOptions {
  const sourceRoot = request.sourceRoot;
  const hasSourceRoot = sourceRoot !== undefined;
  return {
    projectsDir: source === "claude_code" && hasSourceRoot ? sourceRoot : CLAUDE_CODE_PROJECTS_DIR,
    codexHome: source === "codex" && hasSourceRoot ? sourceRoot : DEFAULT_CODEX_HOME,
    opencodeDataDir:
      source === "opencode" && hasSourceRoot ? sourceRoot : defaultOpenCodeDataDirectory(),
    openclawAgentsDir: OPENCLAW_AGENTS_DIR,
    piSessionsDir: source === "pi" && hasSourceRoot ? sourceRoot : PI_SESSIONS_DIR,
    skillLogPath: request.skillLogPath ?? SKILL_LOG,
    repairedSkillLogPath: REPAIRED_SKILL_LOG,
    repairedSessionsPath: REPAIRED_SKILL_SESSIONS_MARKER,
    since: request.since,
    dryRun: request.dryRun,
    force: request.force,
    syncClaude: source === "claude_code",
    syncCodex: source === "codex",
    syncOpenCode: source === "opencode",
    syncOpenClaw: false,
    syncPi: source === "pi",
    rebuildSkillUsage: false,
  };
}

const resultForSource = (
  source: SingleSourceIngestSource,
  sources: SyncResult["sources"],
): SyncStepResult => {
  switch (source) {
    case "claude_code":
      return sources.claude;
    case "codex":
      return sources.codex;
    case "opencode":
      return sources.opencode;
    case "pi":
      return sources.pi;
  }
};

/** Runs one explicitly selected source through the shared source-sync pipeline. */
export const ingestSingleSourceLive = Effect.fn("selftune.orchestration.ingest.singleSource")(
  function* (
    source: SingleSourceIngestSource,
    request: SingleSourceIngestRequest,
    onProgress?: SyncProgressCallback,
  ) {
    const result = yield* syncSourcesLive(
      createSingleSourceIngestOptions(source, request),
      {},
      onProgress,
    );
    return resultForSource(source, result.sources);
  },
);
