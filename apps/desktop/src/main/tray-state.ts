import * as Schema from "effect/Schema";

export type TrayHarnessStatus = "connected" | "detected" | "not_detected";
export type TrayScheduleJobId = "selftune-sync" | "selftune-status" | "selftune-orchestrate";

const TrayHarnessStatusSchema = Schema.Literals(["connected", "detected", "not_detected"]);
const TrayScheduleJobIdSchema = Schema.Literals([
  "selftune-sync",
  "selftune-status",
  "selftune-orchestrate",
]);

export const TraySettingsResponseSchema = Schema.Struct({
  harnesses: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: TrayHarnessStatusSchema,
      detected: Schema.Boolean,
      connected: Schema.Boolean,
      hooks_installed: Schema.Boolean,
      detail: Schema.String,
    }),
  ),
  schedule: Schema.Struct({
    supported: Schema.Boolean,
    jobs: Schema.Array(
      Schema.Struct({
        id: TrayScheduleJobIdSchema,
        label: Schema.String,
        schedule: Schema.String,
        default_schedule: Schema.String,
        enabled: Schema.Boolean,
        active: Schema.Boolean,
      }),
    ),
  }),
  remote_library: Schema.Struct({
    configured: Schema.Boolean,
    url: Schema.NullOr(Schema.String),
  }),
});

export const TrayInsightsResponseSchema = Schema.Struct({
  counts: Schema.Struct({
    pending: Schema.Number,
    accepted: Schema.Number,
    drafted: Schema.Number,
    snoozed: Schema.Number,
    completed: Schema.Number,
    stale_reviews: Schema.Number,
    routing_reviews: Schema.Number,
  }),
});

export const TrayOverviewResponseSchema = Schema.Struct({
  autonomy_status: Schema.Struct({
    level: Schema.Literals(["healthy", "watching", "needs_review", "blocked"]),
    skills_observed: Schema.Number,
    pending_reviews: Schema.Number,
    attention_required: Schema.Number,
  }),
});

export const TrayHealthResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.String,
  latest_version: Schema.NullOr(Schema.String),
  update_available: Schema.Boolean,
  log_dir: Schema.String,
});

export interface TrayHarness {
  id: string;
  name: string;
  status: TrayHarnessStatus;
  detected: boolean;
  connected: boolean;
  hooks_installed: boolean;
  detail: string;
}

export interface TrayScheduleJob {
  id: TrayScheduleJobId;
  label: string;
  schedule: string;
  default_schedule: string;
  enabled: boolean;
  active: boolean;
}

export interface TraySettingsResponse {
  harnesses: ReadonlyArray<TrayHarness>;
  schedule: {
    supported: boolean;
    jobs: ReadonlyArray<TrayScheduleJob>;
  };
  remote_library: {
    configured: boolean;
    url: string | null;
  };
}

export interface TrayInsightsResponse {
  counts: {
    pending: number;
    accepted: number;
    drafted: number;
    snoozed: number;
    completed: number;
    stale_reviews: number;
    routing_reviews: number;
  };
}

export interface TrayOverviewResponse {
  autonomy_status: {
    level: "healthy" | "watching" | "needs_review" | "blocked";
    skills_observed: number;
    pending_reviews: number;
    attention_required: number;
  };
}

export interface TrayHealthResponse {
  ok: boolean;
  version: string;
  latest_version: string | null;
  update_available: boolean;
  log_dir: string;
}

export interface TrayRemoteState {
  settings: TraySettingsResponse;
  overview: TrayOverviewResponse;
  health: TrayHealthResponse;
  insights: TrayInsightsResponse;
}

export interface TrayScheduleUpdateRequest {
  jobs: ReadonlyArray<Pick<TrayScheduleJob, "id" | "enabled" | "schedule">>;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function statusLabel(state: TrayRemoteState | null): string {
  if (!state) return "SelfTune: Loading status...";
  if (!state.health.ok) return "SelfTune: Local service unavailable";

  const pendingReviews =
    state.insights.counts.pending + state.insights.counts.accepted + state.insights.counts.drafted;
  if (pendingReviews > 0) return `SelfTune: ${pluralize(pendingReviews, "review")} needed`;
  const status = state.overview.autonomy_status;
  if (status.level === "blocked") {
    return `SelfTune: ${pluralize(status.attention_required, "item")} need attention`;
  }
  if (status.level === "needs_review") {
    return `SelfTune: ${pluralize(status.pending_reviews, "review")} needed`;
  }
  if (status.level === "watching") {
    return `SelfTune: Watching ${pluralize(status.skills_observed, "skill")}`;
  }
  return "SelfTune: Healthy";
}

export function remoteLibrarySummary(settings: TraySettingsResponse | null): string {
  if (!settings) return "Sync & Backup: Loading...";
  if (!settings.remote_library.configured) return "Sync & Backup: Not configured";
  try {
    const hostname = new URL(settings.remote_library.url ?? "").hostname.toLowerCase();
    return hostname === "cloud.selftune.dev" || hostname === "api.selftune.dev"
      ? "Cloud inventory: Connected"
      : "Sync & Backup: Self-hosted";
  } catch {
    return "Sync & Backup: Connected";
  }
}

export function harnessSummary(settings: TraySettingsResponse | null): string {
  if (!settings) return "Harnesses: Loading...";
  const connected = settings.harnesses.filter((harness) => harness.connected).length;
  return `Harnesses: ${pluralize(connected, "connection")}`;
}

export function humanizeSchedule(schedule: string): string {
  const minuteInterval = schedule.match(/^\*\/(\d+) \* \* \* \*$/);
  if (minuteInterval) return `Every ${minuteInterval[1]} minutes`;

  const hourInterval = schedule.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hourInterval) {
    const hours = Number(hourInterval[1]);
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }

  const daily = schedule.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (daily) {
    const minute = Number(daily[1]);
    const hour = Number(daily[2]);
    const displayHour = hour % 12 || 12;
    const period = hour < 12 ? "AM" : "PM";
    return `Daily at ${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
  }

  return "Custom schedule";
}

export function toggleScheduleJob(
  settings: TraySettingsResponse,
  jobId: TrayScheduleJobId,
): TrayScheduleUpdateRequest {
  return {
    jobs: settings.schedule.jobs.map((job) => ({
      id: job.id,
      enabled: job.id === jobId ? !job.enabled : job.enabled,
      schedule: job.schedule,
    })),
  };
}
