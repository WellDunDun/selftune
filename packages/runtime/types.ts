/**
 * Shared interfaces for selftune telemetry, eval, and grading.
 */

import { Schema } from "effect";
import type {
  EvalEntry,
  InvocationType,
  ReplayStagingMode,
  RoutingReplayEntryResult,
  CreatePackageEvaluationStatus,
  CreatePackageEvaluationSource,
  CreatePackageCandidateAcceptanceDecision,
  CreatePackageEvaluationSummary,
} from "./types/evaluation.js";
export * from "./types/evaluation.js";
import { GraderOutput, type FailureFeedback } from "./types/grading.js";
export * from "./types/grading.js";

export * from "./types/composability.js";
export * from "./types/contributions.js";

// ---------------------------------------------------------------------------
// Config types (written to ~/.selftune/config.json)
// ---------------------------------------------------------------------------

export type { AlphaIdentity, SelftuneConfig } from "@selftune/config";

/**
 * Derive the cloud link readiness state from an AlphaIdentity.
 * Used by status.ts and observability.ts for agent-facing diagnostics.
 */
export type AlphaLinkState =
  | "not_linked"
  | "linked_not_enrolled"
  | "enrolled_no_credential"
  | "ready";

// ---------------------------------------------------------------------------
// Log record types (written to ~/.claude/*.jsonl)
// ---------------------------------------------------------------------------

export interface QueryLogRecord {
  timestamp: string;
  session_id: string;
  query: string;
  source?: string;
}

export interface SkillUsageRecord {
  timestamp: string;
  session_id: string;
  skill_name: string;
  skill_path: string;
  skill_version_hash?: string;
  skill_scope?: "project" | "global" | "admin" | "system" | "unknown";
  skill_project_root?: string;
  skill_registry_dir?: string;
  skill_path_resolution_source?: "raw_log" | "installed_scope" | "launcher_base_dir" | "fallback";
  query: string;
  triggered: boolean;
  /** How the skill was invoked:
   *  explicit   — user typed /skill (slash command)
   *  implicit   — user mentioned skill name, Claude invoked it
   *  inferred   — Claude chose skill autonomously (user never named it)
   *  contextual — SKILL.md was read (Read tool path, not Skill tool)
   */
  invocation_type?: "explicit" | "implicit" | "inferred" | "contextual";
  source?: string;
}

export interface SessionTelemetryRecord {
  timestamp: string;
  session_id: string;
  cwd: string;
  transcript_path: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  skills_invoked?: string[];
  assistant_turns: number;
  errors_encountered: number;
  transcript_chars: number;
  last_user_query: string;
  source?: string;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  cost_usd?: number;
  files_changed?: number;
  lines_added?: number;
  lines_removed?: number;
  lines_modified?: number;
  /** Count of output-producing tool calls (Write, Edit, WebFetch, WebSearch, Skill, Agent). */
  artifact_count?: number;
  /** Inferred session type based on tool distribution. */
  session_type?: SessionType;
  agent_summary?: string;
  rollout_path?: string;
  duration_ms?: number;
}

export interface ImprovementSignalRecord {
  timestamp: string;
  session_id: string;
  query: string;
  signal_type: "correction" | "explicit_request" | "manual_invocation";
  mentioned_skill?: string;
  consumed: boolean;
  consumed_at?: string;
  consumed_by_run?: string;
}

export type {
  CanonicalCaptureMode,
  CanonicalCompletionStatus,
  CanonicalExecutionFactRecord,
  CanonicalInvocationMode,
  CanonicalNormalizationRunRecord,
  CanonicalPlatform,
  CanonicalPromptKind,
  CanonicalPromptRecord,
  CanonicalRawSourceRef,
  CanonicalRecord,
  CanonicalRecordBase,
  CanonicalRecordKind,
  CanonicalSchemaVersion,
  CanonicalSessionRecord,
  CanonicalSessionRecordBase,
  CanonicalSkillInvocationRecord,
  CanonicalSourceSessionKind,
} from "@selftune/telemetry-contract/types";
// ---------------------------------------------------------------------------
// Canonical normalization types (local + cloud projection layer)
// ---------------------------------------------------------------------------
export {
  CANONICAL_CAPTURE_MODES,
  CANONICAL_COMPLETION_STATUSES,
  CANONICAL_INVOCATION_MODES,
  CANONICAL_PLATFORMS,
  CANONICAL_PROMPT_KINDS,
  CANONICAL_RECORD_KINDS,
  CANONICAL_SCHEMA_VERSION,
  CANONICAL_SOURCE_SESSION_KINDS,
} from "@selftune/telemetry-contract/types";

// ---------------------------------------------------------------------------
// Session classification
// ---------------------------------------------------------------------------

/** Inferred session type based on tool distribution. */
export const SessionType = Schema.Literals(["dev", "research", "content", "mixed"]);
export type SessionType = typeof SessionType.Type;

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

export interface TranscriptMetrics {
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  skills_invoked?: string[];
  skill_invocation_events?: TranscriptSkillInvocationEvent[];
  assistant_turns: number;
  errors_encountered: number;
  transcript_chars: number;
  last_user_query: string;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  cost_usd?: number;
  files_changed?: number;
  lines_added?: number;
  lines_removed?: number;
  lines_modified?: number;
  /** Count of output-producing tool calls (Write, Edit, WebFetch, WebSearch, Skill, Agent). */
  artifact_count?: number;
  /** Inferred session type based on tool distribution. */
  session_type?: SessionType;
  duration_ms?: number;
  model?: string;
  started_at?: string;
  ended_at?: string;
}

export interface TranscriptSkillInvocationEvent {
  skill_name: string;
  skill_path?: string;
  occurred_at?: string;
  prompt_index?: number;
  tool_name: "Skill" | "Read";
  tool_call_id?: string;
  source_event_index?: number;
  triggered: boolean;
}

// ---------------------------------------------------------------------------
// Hook payloads (received via stdin from Claude Code)
// ---------------------------------------------------------------------------

/**
 * Common fields present on ALL hook event payloads per Claude Code docs.
 * Individual payloads extend this with event-specific fields.
 */
export const CommonHookPayload = Schema.Struct({
  session_id: Schema.optionalKey(Schema.String),
  transcript_path: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  permission_mode: Schema.optionalKey(Schema.String),
  hook_event_name: Schema.optionalKey(Schema.String),
  /** Present when hook fires inside a subagent. */
  agent_id: Schema.optionalKey(Schema.String),
  /** Agent name (e.g. "Explore", "Plan", or custom agent name). */
  agent_type: Schema.optionalKey(Schema.String),
});
export type CommonHookPayload = typeof CommonHookPayload.Type;

// Shared base for pre/post tool-use hook payloads
export const BaseToolUsePayload = Schema.Struct({
  ...CommonHookPayload.fields,
  tool_name: Schema.String,
  tool_input: Schema.Record(Schema.String, Schema.Json),
  tool_use_id: Schema.optionalKey(Schema.String),
});
export type BaseToolUsePayload = typeof BaseToolUsePayload.Type;

export const PromptSubmitPayload = Schema.Struct({
  ...CommonHookPayload.fields,
  /** Current field name per Claude Code docs (2025+). */
  prompt: Schema.optionalKey(Schema.String),
  /** Legacy field name — kept for backwards compatibility. */
  user_prompt: Schema.optionalKey(Schema.String),
});
export type PromptSubmitPayload = typeof PromptSubmitPayload.Type;

export const PostToolUsePayload = Schema.Struct({
  ...BaseToolUsePayload.fields,
  /** Tool execution result, schema depends on the tool. */
  tool_response: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type PostToolUsePayload = typeof PostToolUsePayload.Type;

export interface StopPayload extends CommonHookPayload {
  /** True when Claude Code is continuing as a result of a stop hook. */
  stop_hook_active?: boolean;
  /** Text content of Claude's final response. */
  last_assistant_message?: string;
}

// ---------------------------------------------------------------------------
// Eval types
// ---------------------------------------------------------------------------

/** Experimental execution eval entry — extends trigger evals with assertion-based validation. */
export interface ExecutionEvalEntry extends EvalEntry {
  /** Assertions to verify against the execution result */
  assertions: ExecutionAssertion[];
  /** Whether this entry requires a staged workspace */
  requires_workspace?: boolean;
  /** Experimental flag — must be explicitly opted into */
  experimental: true;
}

export interface ExecutionAssertion {
  /** What to check: file existence, content match, command output, etc. */
  type: "file_exists" | "file_contains" | "command_output" | "skill_triggered" | "custom";
  /** Target path, command, or skill name depending on type */
  target: string;
  /** Expected value or pattern (regex for content/output checks) */
  expected?: string;
  /** Whether the assertion is negated (must NOT match) */
  negated?: boolean;
}

export interface EvalSourceStats {
  total: number;
  synthetic: number;
  log: number;
  blended: number;
  oldest?: string;
  newest?: string;
}

// ---------------------------------------------------------------------------
// Grading types
// ---------------------------------------------------------------------------

export const ExecutionMetrics = Schema.Struct({
  tool_calls: Schema.mutableKey(Schema.Record(Schema.String, Schema.Number)),
  total_tool_calls: Schema.mutableKey(Schema.Number),
  total_steps: Schema.mutableKey(Schema.Number),
  bash_commands_run: Schema.mutableKey(Schema.Number),
  errors_encountered: Schema.mutableKey(Schema.Number),
  skills_triggered: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  transcript_chars: Schema.mutableKey(Schema.Number),
  artifact_count: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
  session_type: Schema.mutableKey(Schema.optionalKey(SessionType)),
});
export type ExecutionMetrics = typeof ExecutionMetrics.Type;

export const GradingResult = Schema.Struct({
  ...GraderOutput.fields,
  session_id: Schema.mutableKey(Schema.String),
  skill_name: Schema.mutableKey(Schema.String),
  transcript_path: Schema.mutableKey(Schema.String),
  graded_at: Schema.mutableKey(Schema.String),
  execution_metrics: Schema.mutableKey(ExecutionMetrics),
});
export type GradingResult = typeof GradingResult.Type;

// ---------------------------------------------------------------------------
// Health check types
// ---------------------------------------------------------------------------

export type HealthStatus = "pass" | "fail" | "warn";

export interface AgentCommandGuidance {
  code: string;
  message: string;
  next_command: string;
  suggested_commands: string[];
  blocking: boolean;
}

export interface HealthCheck {
  name: string;
  path: string;
  status: HealthStatus;
  message: string;
  guidance?: AgentCommandGuidance;
}

export interface DoctorResult {
  command: string;
  timestamp: string;
  checks: HealthCheck[];
  summary: { pass: number; fail: number; warn: number; total: number };
  healthy: boolean;
}

// ---------------------------------------------------------------------------
// Evolution types (v0.3)
// ---------------------------------------------------------------------------

export interface FailurePattern {
  pattern_id: string;
  skill_name: string;
  invocation_type: InvocationType;
  missed_queries: string[];
  frequency: number;
  sample_sessions: string[];
  extracted_at: string;
  feedback?: FailureFeedback[];
}

export interface EvolutionProposal {
  proposal_id: string;
  skill_name: string;
  skill_path: string;
  original_description: string;
  proposed_description: string;
  rationale: string;
  failure_patterns: string[]; // pattern_ids
  eval_results: {
    before: EvalPassRate;
    after: EvalPassRate;
  };
  confidence: number; // 0.0 - 1.0
  created_at: string;
  status: "pending" | "validated" | "deployed" | "rolled_back";
}

export interface EvalPassRate {
  total: number;
  passed: number;
  failed: number;
  pass_rate: number; // 0.0 to 1.0
}

export interface EvolutionAuditEntry {
  timestamp: string;
  proposal_id: string;
  skill_name?: string;
  action: "created" | "validated" | "deployed" | "rolled_back" | "rejected";
  details: string;
  eval_snapshot?: EvalPassRate;
  iterations_used?: number;
  validation_mode?: ValidationMode;
  validation_agent?: string;
  validation_fixture_id?: string;
  validation_evidence_ref?: string;
}

export interface EvolutionEvidenceValidation {
  improved?: boolean;
  before_pass_rate?: number;
  after_pass_rate?: number;
  net_change?: number;
  regressions?: EvalEntry[] | string[];
  new_passes?: EvalEntry[];
  per_entry_results?: Array<{
    entry: EvalEntry;
    before_pass: boolean;
    after_pass: boolean;
  }>;
  before_entry_results?: Array<{
    entry: EvalEntry;
    before_pass: boolean;
    after_pass: boolean;
  }>;
  gates_passed?: number;
  gates_total?: number;
  gate_results?: Array<{
    gate: ValidationGate;
    passed: boolean;
    reason: string;
  }>;
  validation_mode?: ValidationMode;
  validation_agent?: string;
  validation_fixture_id?: string;
  validation_fallback_reason?: string;
  validation_evidence_ref?: string;
}

export interface EvolutionEvidenceEntry {
  timestamp: string;
  proposal_id: string;
  skill_name: string;
  skill_path: string;
  target: EvolutionTarget;
  stage: "proposed" | "created" | "validated" | "deployed" | "rejected" | "rolled_back";
  rationale?: string;
  confidence?: number;
  details?: string;
  original_text?: string;
  proposed_text?: string;
  eval_set?: EvalEntry[];
  validation?: EvolutionEvidenceValidation;
  /** Deterministic evidence ID, generated during staging (ev_ prefix + hash). */
  evidence_id?: string;
}

export interface EvolutionConfig {
  min_sessions: number;
  min_improvement: number; // e.g., 0.10 = 10 percentage points
  max_iterations: number;
  confidence_threshold: number; // e.g., 0.60
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
// Validation result base (self-contained for Pareto types)
// ---------------------------------------------------------------------------

/** Heuristic quality score for a skill description (no LLM, pure function). */
export interface DescriptionQualityScore {
  composite: number; // 0.0-1.0 weighted aggregate
  criteria: {
    length: number; // description length in optimal range
    trigger_context: number; // includes when/if/before/after context
    vagueness: number; // absence of vague words
    specificity: number; // concrete action verbs present
    not_just_name: number; // not just restating the skill name
  };
}

/** Compact summary of an evolve run, used for CLI JSON output. */
export interface EvolveResultSummary {
  skill: string;
  deployed: boolean;
  reason: string;
  before: number;
  after: number;
  net_change: number;
  improved: boolean;
  regressions: number;
  new_passes: number;
  confidence: number;
  llm_calls: number;
  elapsed_s: number;
  proposal_id: string;
  rationale: string;
  version?: string;
  dashboard_url: string;
  description_quality_before?: number;
  description_quality_after?: number;
  suggestions?: string[];
}

export interface ValidationResultBase {
  proposal_id: string;
  before_pass_rate: number;
  after_pass_rate: number;
  improved: boolean;
  regressions: EvalEntry[];
  new_passes: EvalEntry[];
  net_change: number;
  by_invocation_type?: InvocationTypeScores;
  per_entry_results?: Array<{
    entry: EvalEntry;
    before_pass: boolean;
    after_pass: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Pareto types (multi-dimensional evolution selection)
// ---------------------------------------------------------------------------

export interface InvocationTypeScores {
  explicit: { passed: number; total: number; pass_rate: number };
  implicit: { passed: number; total: number; pass_rate: number };
  contextual: { passed: number; total: number; pass_rate: number };
  negative: { passed: number; total: number; pass_rate: number };
}

export interface ParetoCandidate {
  proposal: EvolutionProposal;
  validation: ValidationResultBase;
  invocation_scores: InvocationTypeScores;
  dominates_on: InvocationType[];
  token_efficiency_score?: number;
}

export interface ParetoSelectionResult {
  selected_proposal: EvolutionProposal;
  frontier: ParetoCandidate[];
  merge_applied: boolean;
  merge_sources: string[];
}

// ---------------------------------------------------------------------------
// Activation rule types (v0.5 — auto-activate hooks)
// ---------------------------------------------------------------------------

export interface ActivationRule {
  id: string;
  description: string;
  /** Evaluate whether this rule fires. Returns a suggestion string or null. */
  evaluate: (ctx: ActivationContext) => string | null;
}

export interface ActivationContext {
  session_id: string;
  query_log_path: string;
  telemetry_log_path: string;
  evolution_audit_log_path: string;
  selftune_dir: string;
  settings_path: string;
}

export const SessionState = Schema.Struct({
  session_id: Schema.mutableKey(Schema.String),
  suggestions_shown: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  updated_at: Schema.mutableKey(Schema.String),
});
export type SessionState = typeof SessionState.Type;

// ---------------------------------------------------------------------------
// PreToolUse hook payloads
// ---------------------------------------------------------------------------

export interface PreToolUsePayload extends BaseToolUsePayload {}

// ---------------------------------------------------------------------------
// Evolution memory types (session context persistence)
// ---------------------------------------------------------------------------

export interface EvolutionMemory {
  context: MemoryContext;
  plan: MemoryPlan;
  decisions: DecisionRecord[];
}

export interface MemoryContext {
  activeEvolutions: Array<{
    skillName: string;
    status: string;
    description: string;
  }>;
  knownIssues: string[];
  lastUpdated: string;
}

export interface MemoryPlan {
  currentPriorities: string[];
  strategy: string;
  lastUpdated: string;
}

export interface DecisionRecord {
  timestamp: string;
  /** Imperative verb for markdown headings (e.g. "evolve", "rollback", "watch"). */
  actionType: string;
  skillName: string;
  /** Past-tense result state used programmatically. */
  action: "evolved" | "rolled-back" | "watched";
  rationale: string;
  result: string;
}

// ---------------------------------------------------------------------------
// Evolution target types (v0.6 — body + routing evolution)
// ---------------------------------------------------------------------------

/** Which part of a skill is being evolved. */
export type EvolutionTarget = "description" | "routing" | "body" | "new_skill";

/** Parsed sections of a SKILL.md file. */
export interface SkillSections {
  frontmatter: string;
  title: string;
  description: string;
  sections: Record<string, string>;
}

/** Proposal for evolving the full body of a SKILL.md. */
export interface BodyEvolutionProposal {
  proposal_id: string;
  skill_name: string;
  skill_path: string;
  original_body: string;
  proposed_body: string;
  rationale: string;
  target: EvolutionTarget;
  failure_patterns: string[];
  confidence: number;
  created_at: string;
  status: "pending" | "validated" | "deployed" | "rolled_back";
}

/** Closed union of gate names used in the validation pipeline. */
export type ValidationGate = "structural" | "trigger_accuracy" | "quality";

export type ValidationMode = "structural_guard" | "host_replay" | "llm_judge";

export interface RoutingReplayFixture {
  fixture_id: string;
  platform: "claude_code" | "codex" | "opencode";
  target_skill_name: string;
  target_skill_path: string;
  competing_skill_paths: string[];
  workspace_root?: string;
  skill_staging_mode?: ReplayStagingMode;
}

/** Result of validating a body evolution proposal. */
export interface BodyValidationResult {
  proposal_id: string;
  gates_passed: number;
  gates_total: number;
  gate_results: Array<{
    gate: ValidationGate;
    passed: boolean;
    reason: string;
  }>;
  improved: boolean;
  regressions: string[];
  validation_mode?: ValidationMode;
  validation_agent?: string;
  validation_fixture_id?: string;
  validation_fallback_reason?: string;
  before_pass_rate?: number;
  after_pass_rate?: number;
  per_entry_results?: RoutingReplayEntryResult[];
  before_entry_results?: RoutingReplayEntryResult[];
}

/** Configuration for which LLM model a role should use. */
export interface LlmRoleConfig {
  role: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
}

// ---------------------------------------------------------------------------
// Package candidate types
// ---------------------------------------------------------------------------

export interface CreatePackageCandidateRecord {
  candidate_id: string;
  skill_name: string;
  skill_path: string;
  package_fingerprint: string;
  parent_candidate_id: string | null;
  candidate_generation: number;
  evaluation_count: number;
  first_evaluated_at: string;
  last_evaluated_at: string;
  latest_status: CreatePackageEvaluationStatus;
  latest_evaluation_source: CreatePackageEvaluationSource | null;
  latest_acceptance_decision: CreatePackageCandidateAcceptanceDecision | null;
  artifact_path: string | null;
  summary: CreatePackageEvaluationSummary;
}

// ---------------------------------------------------------------------------
// Skill unit test types
// ---------------------------------------------------------------------------

export interface AgentSkillValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface AgentSkillValidationResult {
  ok: boolean;
  issues: AgentSkillValidationIssue[];
  raw_stdout: string;
  raw_stderr: string;
  exit_code: number | null;
  validator: "skills-ref";
  command: string | null;
}

export type CreateCheckState =
  | "blocked_spec_validation"
  | "needs_spec_validation"
  | "needs_package_resources"
  | "needs_evals"
  | "needs_unit_tests"
  | "needs_routing_replay"
  | "needs_baseline"
  | "ready_to_publish";

export interface CreateCheckChecks {
  skill_md: boolean;
  frontmatter_present: boolean;
  skill_name_matches_dir: boolean;
  description_present: boolean;
  description_within_budget: boolean;
  skill_md_within_line_budget: boolean;
  manifest_present: boolean;
  workflow_entry: boolean;
  references_present: boolean;
  scripts_present: boolean;
  assets_present: boolean;
  evals_present: boolean;
  unit_tests_present: boolean;
  routing_replay_ready: boolean;
  routing_replay_recorded: boolean;
  package_replay_ready: boolean;
  baseline_present: boolean;
}

export interface CreateCheckReadiness {
  ok: boolean;
  state: CreateCheckState;
  summary: string;
  next_command: string | null;
  checks: CreateCheckChecks;
  skill_name: string;
  skill_dir: string;
  skill_path: string;
  entry_workflow: string;
  manifest_present: boolean;
  description_quality: DescriptionQualityScore;
}

export interface CreateCheckResult {
  skill: string;
  skill_dir: string;
  skill_path: string;
  ok: boolean;
  state: CreateCheckState;
  next_command: string | null;
  spec_validation: AgentSkillValidationResult;
  readiness: CreateCheckReadiness;
}
