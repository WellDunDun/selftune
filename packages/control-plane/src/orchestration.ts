import { Schema } from "effect";

export const OrchestrateRunSkillAction = Schema.Struct({
  skill: Schema.mutableKey(Schema.String),
  action: Schema.mutableKey(Schema.Literals(["evolve", "package-search", "watch", "skip"])),
  reason: Schema.mutableKey(Schema.String),
  deployed: Schema.mutableKey(Schema.optionalKey(Schema.Boolean)),
  rolledBack: Schema.mutableKey(Schema.optionalKey(Schema.Boolean)),
  alert: Schema.mutableKey(Schema.optionalKey(Schema.NullOr(Schema.String))),
  elapsed_ms: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
  llm_calls: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
});
export type OrchestrateRunSkillAction = typeof OrchestrateRunSkillAction.Type;

export const OrchestrateRunReport = Schema.Struct({
  run_id: Schema.mutableKey(Schema.String),
  timestamp: Schema.mutableKey(Schema.String),
  elapsed_ms: Schema.mutableKey(Schema.Number),
  dry_run: Schema.mutableKey(Schema.Boolean),
  approval_mode: Schema.mutableKey(Schema.Literals(["auto", "review"])),
  total_skills: Schema.mutableKey(Schema.Number),
  evaluated: Schema.mutableKey(Schema.Number),
  evolved: Schema.mutableKey(Schema.Number),
  deployed: Schema.mutableKey(Schema.Number),
  watched: Schema.mutableKey(Schema.Number),
  skipped: Schema.mutableKey(Schema.Number),
  auto_graded: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
  package_searched: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
  package_improved: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
  skill_actions: Schema.mutableKey(Schema.mutable(Schema.Array(OrchestrateRunSkillAction))),
});
export type OrchestrateRunReport = typeof OrchestrateRunReport.Type;
