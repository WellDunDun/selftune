import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface SyncStepResult {
  available: boolean;
  scanned: number;
  synced: number;
  skipped: number;
}

export interface SyncPhaseTiming {
  phase: string;
  elapsed_ms: number;
}

export interface SyncResult {
  since: string | null;
  dry_run: boolean;
  sources: {
    claude: SyncStepResult;
    codex: SyncStepResult;
    opencode: SyncStepResult;
    openclaw: SyncStepResult;
    pi: SyncStepResult;
  };
  repair: {
    ran: boolean;
    repaired_sessions: number;
    repaired_records: number;
    codex_repaired_records: number;
  };
  creator_contributions: {
    ran: boolean;
    eligible_skills: number;
    built_signals: number;
    staged_signals: number;
  };
  timings: SyncPhaseTiming[];
  total_elapsed_ms: number;
}

export interface SourceSyncRequest {
  force?: boolean;
  dryRun?: boolean;
}

export class SourceSyncUnavailable extends Schema.TaggedErrorClass<SourceSyncUnavailable>()(
  "SourceSyncUnavailable",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class SourceSync extends Context.Service<
  SourceSync,
  {
    readonly run: (request: SourceSyncRequest) => Effect.Effect<SyncResult, SourceSyncUnavailable>;
  }
>()("@selftune/runtime/SourceSync") {}

export type SourceSyncRunner = (request?: SourceSyncRequest) => SyncResult;
