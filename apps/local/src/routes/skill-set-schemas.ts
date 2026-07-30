import * as Schema from "effect/Schema";

export const ReviewSkillSetSuggestionBody = Schema.Struct({
  suggestion_id: Schema.String,
  evidence_fingerprint: Schema.String,
  decision: Schema.Literals(["accepted", "edited", "dismissed"]),
  reason_code: Schema.Literals([
    "accepted_as_suggested",
    "edited_before_creation",
    "not_relevant_now",
    "skills_should_remain_separate",
    "not_a_real_pattern",
    "already_have_workflow",
    "other",
  ]),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  resulting_set_id: Schema.optional(Schema.NullOr(Schema.String)),
  resulting_set_revision_hash: Schema.optional(Schema.NullOr(Schema.String)),
  edited_fields: Schema.optional(Schema.Array(Schema.String)),
  result: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      harnesses: Schema.Array(Schema.String),
      skills: Schema.Array(Schema.String),
    }),
  ),
});
