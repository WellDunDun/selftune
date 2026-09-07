import { Clock, Effect, Layer, Result } from "effect";

import type { SyncOptions, SyncProgramInput } from "./model.js";
import { buildSyncHeader, buildSyncProgramResult } from "./output.js";
import {
  SyncAudit,
  SyncCore,
  SyncProgress,
  SyncPreferences,
  type LoadedSyncPreferences,
} from "./services.js";

function resolveOptions(input: SyncProgramInput, loaded: LoadedSyncPreferences): SyncOptions {
  const { defaults, importSources } = loaded;
  return {
    projectsDir: input.projectsDir ?? defaults.projectsDir,
    codexHome: input.codexHome ?? defaults.codexHome,
    opencodeDataDir: input.opencodeDataDir ?? defaults.opencodeDataDir,
    openclawAgentsDir: input.openclawAgentsDir ?? defaults.openclawAgentsDir,
    piSessionsDir: input.piSessionsDir ?? defaults.piSessionsDir,
    skillLogPath: input.skillLogPath ?? defaults.skillLogPath,
    repairedSkillLogPath: input.repairedSkillLogPath ?? defaults.repairedSkillLogPath,
    repairedSessionsPath: input.repairedSessionsPath ?? defaults.repairedSessionsPath,
    since: input.since,
    dryRun: input.dryRun,
    force: input.force,
    syncClaude: importSources.claude_code && !input.skipClaude,
    syncCodex: importSources.codex && !input.skipCodex,
    syncOpenCode: importSources.opencode && !input.skipOpenCode,
    syncOpenClaw: importSources.openclaw && !input.skipOpenClaw,
    syncPi: importSources.pi && !input.skipPi,
    rebuildSkillUsage: !input.skipRepair,
  };
}

export const runSyncProgram = Effect.fn("selftune.orchestration.sync.run")(function* (
  input: SyncProgramInput,
) {
  const preferences = yield* SyncPreferences;
  const core = yield* SyncCore;
  const audit = yield* SyncAudit;
  const progress = yield* SyncProgress;
  if (!input.jsonOutput) progress.report(buildSyncHeader(input));
  const startedAtMillis = yield* Clock.currentTimeMillis;
  const startedAt = new Date(startedAtMillis).toISOString();

  const outcome = yield* Effect.gen(function* () {
    const loaded = yield* preferences.load();
    return yield* core.run(
      resolveOptions(input, loaded),
      input.jsonOutput ? undefined : (message) => progress.report(`  ${message}`),
    );
  }).pipe(Effect.result);
  const completedAtMillis = yield* Clock.currentTimeMillis;
  const elapsedMs = Math.max(0, Math.round(completedAtMillis - startedAtMillis));

  if (Result.isFailure(outcome)) {
    yield* audit
      .recordError({ startedAt, elapsedMs, message: outcome.failure.message })
      .pipe(Effect.ignore);
    return yield* Effect.fail(outcome.failure);
  }

  yield* audit.recordSuccess({ startedAt, elapsedMs, result: outcome.success });
  return buildSyncProgramResult(input, outcome.success);
});

export function makeSyncProgressLayer(
  report: (message: string) => void,
): Layer.Layer<SyncProgress> {
  return Layer.succeed(SyncProgress, SyncProgress.of({ report }));
}

export { syncLiveLayer } from "./live.js";
export type { SyncProgramInput, SyncProgramResult } from "./model.js";
export {
  isSyncInternalFailure,
  SyncAudit,
  SyncCore,
  SyncInternalFailure,
  SyncProgress,
  SyncPreferences,
  type SyncProgramRuntime,
  type SyncRuntime,
} from "./services.js";
