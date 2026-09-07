import * as Schema from "effect/Schema";

export const SUPPORTED_CONTRIBUTION_SIGNALS = ["trigger", "grade", "miss_category"] as const;
export const ContributionSignal = Schema.Literals(SUPPORTED_CONTRIBUTION_SIGNALS);
export type ContributionSignal = typeof ContributionSignal.Type;

export const CreatorContributionRelayPayload = Schema.Struct({
  version: Schema.Literal(1),
  signal_type: Schema.Literal("skill_session"),
  source_key: Schema.String,
  skill_name: Schema.optionalKey(Schema.String),
  relay_destination: Schema.String,
  skill_hash: Schema.String,
  user_cohort: Schema.String,
  signals: Schema.Struct({
    triggered: Schema.mutableKey(Schema.optionalKey(Schema.Boolean)),
    invocation_type: Schema.mutableKey(
      Schema.optionalKey(Schema.Literals(["explicit", "implicit", "contextual", "missed"])),
    ),
    execution_grade: Schema.mutableKey(Schema.optionalKey(Schema.Literals(["A", "B", "C", "F"]))),
    query_bucket: Schema.mutableKey(Schema.optionalKey(Schema.String)),
    miss_detected: Schema.mutableKey(Schema.optionalKey(Schema.Boolean)),
  }),
  timestamp_bucket: Schema.String,
  client_version: Schema.String,
});
export type CreatorContributionRelayPayload = typeof CreatorContributionRelayPayload.Type;
