import * as Schema from "effect/Schema";

export const HostedDesktopState = Schema.Struct({
  workspaceId: Schema.String,
  plan: Schema.Literals(["free", "pro", "team"]),
  status: Schema.Literals(["none", "trialing", "active", "past_due", "canceled", "unpaid"]),
  currentPeriodEnd: Schema.NullOr(Schema.Number),
});
export type HostedDesktopState = typeof HostedDesktopState.Type;

export const HostedManifestSkill = Schema.Struct({
  identity: Schema.String,
  revision_hash: Schema.String,
  scope: Schema.String,
  connections: Schema.Array(Schema.String),
  update_status: Schema.Literals(["current", "available", "unknown"]),
  usage_status: Schema.Literals(["recent", "stale", "none"]),
});
export type HostedManifestSkill = typeof HostedManifestSkill.Type;

export const HostedManifestRequest = Schema.Struct({
  revision: Schema.String,
  device_name: Schema.String,
  platform: Schema.String,
  skills: Schema.Array(HostedManifestSkill),
});
export type HostedManifestRequest = typeof HostedManifestRequest.Type;

export const HostedManifestReceipt = Schema.Struct({
  uploaded: Schema.Number,
  unchanged: Schema.Number,
});
export type HostedManifestReceipt = typeof HostedManifestReceipt.Type;

export const HostedContributorSignal = Schema.Struct({
  version: Schema.Literal(1),
  signal_type: Schema.Literal("skill_session"),
  source_key: Schema.String,
  skill_name: Schema.optional(Schema.String),
  relay_destination: Schema.String,
  skill_hash: Schema.String,
  user_cohort: Schema.String,
  signals: Schema.Struct({
    triggered: Schema.optional(Schema.Boolean),
    invocation_type: Schema.optional(
      Schema.Literals(["explicit", "implicit", "contextual", "missed"]),
    ),
    execution_grade: Schema.optional(Schema.Literals(["A", "B", "C", "F"])),
    query_bucket: Schema.optional(Schema.String),
    miss_detected: Schema.optional(Schema.Boolean),
  }),
  timestamp_bucket: Schema.String,
  client_version: Schema.String,
});
export type HostedContributorSignal = typeof HostedContributorSignal.Type;

export const HostedContributorAggregate = Schema.Struct({
  observations: Schema.Number,
  cohorts: Schema.Number,
  triggered: Schema.Number,
  missed: Schema.Number,
  grades: Schema.Struct({
    A: Schema.Number,
    B: Schema.Number,
    C: Schema.Number,
    F: Schema.Number,
  }),
});
export type HostedContributorAggregate = typeof HostedContributorAggregate.Type;
