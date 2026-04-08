/**
 * Zod validation schemas for all canonical telemetry record types
 * and the PushPayloadV2 envelope.
 *
 * This is the single source of truth -- cloud consumers should import
 * from @selftune/telemetry-contract/schemas instead of maintaining
 * their own copies.
 */

import { z } from "zod";
import {
  CANONICAL_CAPTURE_MODES,
  CANONICAL_COMPLETION_STATUSES,
  CANONICAL_INVOCATION_MODES,
  CANONICAL_PLATFORMS,
  CANONICAL_PROMPT_KINDS,
  CANONICAL_RECORD_KINDS,
  CANONICAL_SCHEMA_VERSION,
  CANONICAL_SOURCE_SESSION_KINDS,
} from "./types.js";

// ---------- Shared enum schemas ----------

export const canonicalPlatformSchema = z.enum(CANONICAL_PLATFORMS);
export const captureModeSchema = z.enum(CANONICAL_CAPTURE_MODES);
export const sourceSessionKindSchema = z.enum(CANONICAL_SOURCE_SESSION_KINDS);
export const promptKindSchema = z.enum(CANONICAL_PROMPT_KINDS);
export const invocationModeSchema = z.enum(CANONICAL_INVOCATION_MODES);
export const completionStatusSchema = z.enum(CANONICAL_COMPLETION_STATUSES);
export const recordKindSchema = z.enum(CANONICAL_RECORD_KINDS);

// ---------- Shared structural schemas ----------

export const rawSourceRefSchema = z.object({
  path: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  event_type: z.string().optional(),
  raw_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const canonicalRecordBaseSchema = z.object({
  record_kind: recordKindSchema,
  schema_version: z.literal(CANONICAL_SCHEMA_VERSION),
  normalizer_version: z.string().min(1),
  normalized_at: z.string().datetime(),
  platform: canonicalPlatformSchema,
  capture_mode: captureModeSchema,
  raw_source_ref: rawSourceRefSchema,
});

export const canonicalSessionRecordBaseSchema = canonicalRecordBaseSchema.extend({
  source_session_kind: sourceSessionKindSchema,
  session_id: z.string().min(1),
});

// ---------- Canonical record schemas ----------

export const CanonicalSessionRecordSchema = canonicalSessionRecordBaseSchema.extend({
  record_kind: z.literal("session"),
  external_session_id: z.string().optional(),
  parent_session_id: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  agent_cli: z.string().optional(),
  session_key: z.string().optional(),
  channel: z.string().optional(),
  workspace_path: z.string().optional(),
  repo_root: z.string().optional(),
  repo_remote: z.string().optional(),
  branch: z.string().optional(),
  commit_sha: z.string().optional(),
  permission_mode: z.string().optional(),
  approval_policy: z.string().optional(),
  sandbox_policy: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  started_at: z.string().datetime().optional(),
  ended_at: z.string().datetime().optional(),
  completion_status: completionStatusSchema.optional(),
  end_reason: z.string().optional(),
});

export const CanonicalPromptRecordSchema = canonicalSessionRecordBaseSchema.extend({
  record_kind: z.literal("prompt"),
  prompt_id: z.string().min(1),
  occurred_at: z.string().datetime(),
  prompt_text: z.string().min(1),
  prompt_hash: z.string().optional(),
  prompt_kind: promptKindSchema,
  is_actionable: z.boolean(),
  prompt_index: z.number().int().nonnegative().optional(),
  parent_prompt_id: z.string().optional(),
  source_message_id: z.string().optional(),
});

export const CanonicalSkillInvocationRecordSchema = canonicalSessionRecordBaseSchema.extend({
  record_kind: z.literal("skill_invocation"),
  skill_invocation_id: z.string().min(1),
  occurred_at: z.string().datetime(),
  matched_prompt_id: z.string().min(1).optional(),
  skill_name: z.string().min(1),
  skill_path: z.string().optional(),
  skill_version_hash: z.string().optional(),
  invocation_mode: invocationModeSchema,
  triggered: z.boolean(),
  confidence: z.number().min(0).max(1),
  tool_name: z.string().optional(),
  tool_call_id: z.string().optional(),
  agent_type: z.string().optional(),
});

export const CanonicalExecutionFactRecordSchema = canonicalSessionRecordBaseSchema.extend({
  record_kind: z.literal("execution_fact"),
  execution_fact_id: z.string().min(1),
  occurred_at: z.string().datetime(),
  prompt_id: z.string().optional(),
  tool_calls_json: z.record(z.string(), z.number().finite()),
  total_tool_calls: z.number().int().nonnegative(),
  bash_commands_redacted: z.array(z.string()).optional(),
  assistant_turns: z.number().int().nonnegative(),
  errors_encountered: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  duration_ms: z.number().nonnegative().optional(),
  completion_status: completionStatusSchema.optional(),
  end_reason: z.string().optional(),
});

export const CanonicalNormalizationRunRecordSchema = canonicalRecordBaseSchema.extend({
  record_kind: z.literal("normalization_run"),
  run_id: z.string().min(1),
  run_at: z.string().datetime(),
  raw_records_seen: z.number().int().nonnegative(),
  canonical_records_written: z.number().int().nonnegative(),
  repair_applied: z.boolean(),
});

export const CanonicalEvolutionEvidenceRecordSchema = z.object({
  evidence_id: z.string().min(1),
  skill_name: z.string().min(1),
  proposal_id: z.string().optional(),
  target: z.string().min(1),
  stage: z.string().min(1),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  original_text: z.string().optional(),
  proposed_text: z.string().optional(),
  eval_set_json: z.unknown().optional(),
  validation_json: z.unknown().optional(),
  raw_source_ref: rawSourceRefSchema.optional(),
});

// ---------- Orchestrate run schemas ----------

export const OrchestrateRunSkillActionSchema = z.object({
  skill: z.string().min(1),
  action: z.enum(["evolve", "watch", "skip"]),
  reason: z.string(),
  deployed: z.boolean().optional(),
  rolledBack: z.boolean().optional(),
  alert: z.string().nullable().optional(),
  elapsed_ms: z.number().nonnegative().optional(),
  llm_calls: z.number().int().nonnegative().optional(),
});

export const PushOrchestrateRunRecordSchema = z.object({
  run_id: z.string().min(1),
  timestamp: z.string().datetime(),
  elapsed_ms: z.number().int().nonnegative(),
  dry_run: z.boolean(),
  approval_mode: z.enum(["auto", "review"]),
  total_skills: z.number().int().nonnegative(),
  evaluated: z.number().int().nonnegative(),
  evolved: z.number().int().nonnegative(),
  deployed: z.number().int().nonnegative(),
  watched: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  skill_actions: z.array(OrchestrateRunSkillActionSchema),
});

// ---------- Push V2 envelope ----------

export const PushPayloadV2Schema = z.object({
  schema_version: z.literal("2.0"),
  client_version: z.string().min(1),
  push_id: z.string().uuid(),
  normalizer_version: z.string().min(1),
  canonical: z.object({
    sessions: z.array(CanonicalSessionRecordSchema).min(0),
    prompts: z.array(CanonicalPromptRecordSchema).min(0),
    skill_invocations: z.array(CanonicalSkillInvocationRecordSchema).min(0),
    execution_facts: z.array(CanonicalExecutionFactRecordSchema).min(0),
    normalization_runs: z.array(CanonicalNormalizationRunRecordSchema).min(0),
    evolution_evidence: z.array(CanonicalEvolutionEvidenceRecordSchema).optional(),
    orchestrate_runs: z.array(PushOrchestrateRunRecordSchema).optional(),
  }),
});

// ---------- Inferred types from Zod schemas ----------

export type PushPayloadV2 = z.infer<typeof PushPayloadV2Schema>;
export type ZodCanonicalSessionRecord = z.infer<typeof CanonicalSessionRecordSchema>;
export type ZodCanonicalPromptRecord = z.infer<typeof CanonicalPromptRecordSchema>;
export type ZodCanonicalSkillInvocationRecord = z.infer<
  typeof CanonicalSkillInvocationRecordSchema
>;
export type ZodCanonicalExecutionFactRecord = z.infer<typeof CanonicalExecutionFactRecordSchema>;
export type ZodCanonicalNormalizationRunRecord = z.infer<
  typeof CanonicalNormalizationRunRecordSchema
>;
export type ZodCanonicalEvolutionEvidenceRecord = z.infer<
  typeof CanonicalEvolutionEvidenceRecordSchema
>;
export type ZodPushOrchestrateRunRecord = z.infer<typeof PushOrchestrateRunRecordSchema>;
