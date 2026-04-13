export const CANONICAL_SCHEMA_VERSION = "2.0" as const;
export type CanonicalSchemaVersion = typeof CANONICAL_SCHEMA_VERSION;

export const CANONICAL_PLATFORMS = ["claude_code", "codex", "opencode", "openclaw", "pi"] as const;
export type CanonicalPlatform = (typeof CANONICAL_PLATFORMS)[number];

export const CANONICAL_CAPTURE_MODES = [
  "hook",
  "replay",
  "wrapper",
  "batch_ingest",
  "repair",
] as const;
export type CanonicalCaptureMode = (typeof CANONICAL_CAPTURE_MODES)[number];

export const CANONICAL_SOURCE_SESSION_KINDS = [
  "interactive",
  "replayed",
  "synthetic",
  "repaired",
] as const;
export type CanonicalSourceSessionKind = (typeof CANONICAL_SOURCE_SESSION_KINDS)[number];

export const CANONICAL_PROMPT_KINDS = [
  "user",
  "continuation",
  "task_notification",
  "teammate_message",
  "system_instruction",
  "tool_output",
  "meta",
  "unknown",
] as const;
export type CanonicalPromptKind = (typeof CANONICAL_PROMPT_KINDS)[number];

export const CANONICAL_INVOCATION_MODES = ["explicit", "implicit", "inferred", "repaired"] as const;
export type CanonicalInvocationMode = (typeof CANONICAL_INVOCATION_MODES)[number];

export const CANONICAL_COMPLETION_STATUSES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "unknown",
] as const;
export type CanonicalCompletionStatus = (typeof CANONICAL_COMPLETION_STATUSES)[number];

export const CANONICAL_RECORD_KINDS = [
  "session",
  "prompt",
  "skill_invocation",
  "execution_fact",
  "normalization_run",
] as const;
export type CanonicalRecordKind = (typeof CANONICAL_RECORD_KINDS)[number];

export interface CanonicalRawSourceRef extends Record<string, unknown> {
  path?: string;
  line?: number;
  event_type?: string;
  raw_id?: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalRecordBase extends Record<string, unknown> {
  record_kind: CanonicalRecordKind;
  schema_version: CanonicalSchemaVersion;
  normalizer_version: string;
  normalized_at: string;
  platform: CanonicalPlatform;
  capture_mode: CanonicalCaptureMode;
  raw_source_ref: CanonicalRawSourceRef;
}

export interface CanonicalSessionRecordBase extends CanonicalRecordBase {
  source_session_kind: CanonicalSourceSessionKind;
  session_id: string;
}

export interface CanonicalSessionRecord extends CanonicalSessionRecordBase {
  record_kind: "session";
  started_at?: string;
  ended_at?: string;
  external_session_id?: string;
  parent_session_id?: string;
  agent_id?: string;
  agent_type?: string;
  agent_cli?: string;
  session_key?: string;
  channel?: string;
  workspace_path?: string;
  repo_root?: string;
  repo_remote?: string;
  branch?: string;
  commit_sha?: string;
  permission_mode?: string;
  approval_policy?: string;
  sandbox_policy?: string;
  provider?: string;
  model?: string;
  completion_status?: CanonicalCompletionStatus;
  end_reason?: string;
}

export interface CanonicalPromptRecord extends CanonicalSessionRecordBase {
  record_kind: "prompt";
  prompt_id: string;
  occurred_at: string;
  prompt_text: string;
  prompt_hash?: string;
  prompt_kind: CanonicalPromptKind;
  is_actionable: boolean;
  prompt_index?: number;
  parent_prompt_id?: string;
  source_message_id?: string;
}

export interface CanonicalSkillInvocationRecord extends CanonicalSessionRecordBase {
  record_kind: "skill_invocation";
  skill_invocation_id: string;
  occurred_at: string;
  matched_prompt_id?: string;
  skill_name: string;
  skill_path?: string;
  skill_version_hash?: string;
  invocation_mode: CanonicalInvocationMode;
  triggered: boolean;
  confidence: number;
  tool_name?: string;
  tool_call_id?: string;
  agent_type?: string;
}

export interface CanonicalExecutionFactRecord extends CanonicalSessionRecordBase {
  record_kind: "execution_fact";
  execution_fact_id: string;
  occurred_at: string;
  prompt_id?: string;
  tool_calls_json: Record<string, number>;
  total_tool_calls: number;
  bash_commands_redacted?: string[];
  assistant_turns: number;
  errors_encountered: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  cost_usd?: number;
  files_changed?: number;
  lines_added?: number;
  lines_removed?: number;
  lines_modified?: number;
  artifact_count?: number;
  session_type?: string;
  agent_summary?: string;
  duration_ms?: number;
  completion_status?: CanonicalCompletionStatus;
  end_reason?: string;
}

export interface CanonicalNormalizationRunRecord extends CanonicalRecordBase {
  record_kind: "normalization_run";
  run_id: string;
  run_at: string;
  raw_records_seen: number;
  canonical_records_written: number;
  repair_applied: boolean;
}

export interface CanonicalEvolutionEvidenceRecord {
  evidence_id?: string;
  timestamp?: string;
  proposal_id?: string;
  skill_name: string;
  skill_path?: string;
  target: string;
  stage: string;
  rationale?: string;
  confidence?: number;
  details?: string;
  original_text?: string;
  proposed_text?: string;
  eval_set_json?: unknown;
  validation_json?: unknown;
  raw_source_ref?: CanonicalRawSourceRef;
}

export interface CanonicalGradingResultRecord {
  grading_id: string;
  session_id: string;
  skill_name: string;
  transcript_path?: string | null;
  graded_at: string;
  pass_rate?: number | null;
  mean_score?: number | null;
  score_std_dev?: number | null;
  passed_count?: number | null;
  failed_count?: number | null;
  total_count?: number | null;
  expectations_json?: string | null;
  claims_json?: string | null;
  eval_feedback_json?: string | null;
  failure_feedback_json?: string | null;
  execution_metrics_json?: string | null;
}

export interface CanonicalImprovementSignalRecord {
  signal_id: string;
  timestamp: string;
  session_id: string;
  query: string;
  signal_type: string;
  mentioned_skill?: string | null;
  consumed: boolean;
  consumed_at?: string | null;
  consumed_by_run?: string | null;
}

export type CanonicalRecord =
  | CanonicalSessionRecord
  | CanonicalPromptRecord
  | CanonicalSkillInvocationRecord
  | CanonicalExecutionFactRecord
  | CanonicalNormalizationRunRecord;

export interface PushOrchestrateRunRecord {
  run_id: string;
  timestamp: string;
  elapsed_ms: number;
  dry_run: boolean;
  approval_mode: "auto" | "review";
  total_skills: number;
  evaluated: number;
  evolved: number;
  deployed: number;
  watched: number;
  skipped: number;
  skill_actions: Array<{
    skill: string;
    action: "evolve" | "watch" | "skip";
    reason: string;
    deployed?: boolean;
    rolledBack?: boolean;
    alert?: string | null;
    elapsed_ms?: number;
    llm_calls?: number;
  }>;
}

export interface PushPayloadV2 {
  schema_version: CanonicalSchemaVersion;
  client_version: string;
  push_id: string;
  normalizer_version: string;
  canonical: {
    sessions: CanonicalSessionRecord[];
    prompts: CanonicalPromptRecord[];
    skill_invocations: CanonicalSkillInvocationRecord[];
    execution_facts: CanonicalExecutionFactRecord[];
    normalization_runs: CanonicalNormalizationRunRecord[];
    evolution_evidence?: CanonicalEvolutionEvidenceRecord[];
    orchestrate_runs?: PushOrchestrateRunRecord[];
    grading_results?: CanonicalGradingResultRecord[];
    improvement_signals?: CanonicalImprovementSignalRecord[];
  };
}
