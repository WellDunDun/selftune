import { z } from "zod";
import {
  CANONICAL_CAPTURE_MODES,
  CANONICAL_COMPLETION_STATUSES,
  CANONICAL_INVOCATION_MODES,
  CANONICAL_PLATFORMS,
  CANONICAL_PROMPT_KINDS,
  CANONICAL_SCHEMA_VERSION,
  CANONICAL_SOURCE_SESSION_KINDS,
} from "./types";

const NonEmptyText = z.string().min(1);
const RawSourceEvidence = z.looseObject({});
const RecordEvidence = z.looseObject({
  schema_version: z.literal(CANONICAL_SCHEMA_VERSION),
  platform: z.enum(CANONICAL_PLATFORMS),
  capture_mode: z.enum(CANONICAL_CAPTURE_MODES),
  normalizer_version: NonEmptyText,
  normalized_at: NonEmptyText,
  raw_source_ref: RawSourceEvidence,
});
const SessionScope = {
  source_session_kind: z.enum(CANONICAL_SOURCE_SESSION_KINDS),
  session_id: NonEmptyText,
};
const CompletionStatus = z.enum(CANONICAL_COMPLETION_STATUSES).optional();
const SessionEvidence = RecordEvidence.extend({
  ...SessionScope,
  record_kind: z.literal("session"),
  completion_status: CompletionStatus,
});
const PromptEvidence = RecordEvidence.extend({
  ...SessionScope,
  record_kind: z.literal("prompt"),
  prompt_id: NonEmptyText,
  occurred_at: NonEmptyText,
  prompt_text: NonEmptyText,
  prompt_kind: z.enum(CANONICAL_PROMPT_KINDS),
  is_actionable: z.boolean(),
});
const SkillInvocationEvidence = RecordEvidence.extend({
  ...SessionScope,
  record_kind: z.literal("skill_invocation"),
  skill_invocation_id: NonEmptyText,
  occurred_at: NonEmptyText,
  matched_prompt_id: NonEmptyText.optional(),
  skill_name: NonEmptyText,
  invocation_mode: z.enum(CANONICAL_INVOCATION_MODES),
  triggered: z.boolean(),
  confidence: z.number(),
});
const ExecutionFactEvidence = RecordEvidence.extend({
  ...SessionScope,
  record_kind: z.literal("execution_fact"),
  execution_fact_id: NonEmptyText,
  occurred_at: NonEmptyText,
  tool_calls_json: z.record(z.string(), z.number()),
  total_tool_calls: z.number(),
  bash_commands_redacted: z.array(z.string()).optional(),
  assistant_turns: z.number(),
  errors_encountered: z.number(),
  completion_status: CompletionStatus,
});
const NormalizationRunEvidence = RecordEvidence.extend({
  record_kind: z.literal("normalization_run"),
  run_id: NonEmptyText,
  run_at: NonEmptyText,
  raw_records_seen: z.number(),
  canonical_records_written: z.number(),
  repair_applied: z.boolean(),
});
const CanonicalEvidence = z.discriminatedUnion("record_kind", [
  SessionEvidence,
  PromptEvidence,
  SkillInvocationEvidence,
  ExecutionFactEvidence,
  NormalizationRunEvidence,
]);

// Local history validates core evidence without claiming optional metadata is typed.
export type CanonicalRecordEvidence = z.infer<typeof CanonicalEvidence>;
export type CanonicalSessionEvidence = z.infer<typeof SessionEvidence>;
export type CanonicalPromptEvidence = z.infer<typeof PromptEvidence>;
export type CanonicalSkillInvocationEvidence = z.infer<typeof SkillInvocationEvidence>;
export type CanonicalExecutionFactEvidence = z.infer<typeof ExecutionFactEvidence>;
export type CanonicalRawSourceEvidence = z.infer<typeof RawSourceEvidence>;

export function isCanonicalRawSourceRef(value: unknown): value is CanonicalRawSourceEvidence {
  return RawSourceEvidence.safeParse(value).success;
}

export function isCanonicalRecord(value: unknown): value is CanonicalRecordEvidence {
  return CanonicalEvidence.safeParse(value).success;
}
