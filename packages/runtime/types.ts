/**
 * Shared interfaces for selftune telemetry, eval, and grading.
 */

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
export type SessionType = "dev" | "research" | "content" | "mixed";

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
export interface CommonHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  /** Present when hook fires inside a subagent. */
  agent_id?: string;
  /** Agent name (e.g. "Explore", "Plan", or custom agent name). */
  agent_type?: string;
}

// Shared base for pre/post tool-use hook payloads
export interface BaseToolUsePayload extends CommonHookPayload {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}

export interface PromptSubmitPayload extends CommonHookPayload {
  /** Current field name per Claude Code docs (2025+). */
  prompt?: string;
  /** Legacy field name — kept for backwards compatibility. */
  user_prompt?: string;
}

export interface PostToolUsePayload extends BaseToolUsePayload {
  /** Tool execution result, schema depends on the tool. */
  tool_response?: Record<string, unknown>;
}

export interface StopPayload extends CommonHookPayload {
  /** True when Claude Code is continuing as a result of a stop hook. */
  stop_hook_active?: boolean;
  /** Text content of Claude's final response. */
  last_assistant_message?: string;
}

// ---------------------------------------------------------------------------
// Eval types
// ---------------------------------------------------------------------------

export type InvocationType = "explicit" | "implicit" | "contextual" | "negative";

export interface EvalEntry {
  query: string;
  should_trigger: boolean;
  invocation_type?: InvocationType;
  /** Provenance: where this eval entry originated */
  source?: "synthetic" | "log" | "blended";
  /** ISO timestamp when this eval entry was created */
  created_at?: string;
}

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

export interface GradingExpectation {
  text: string;
  passed: boolean;
  evidence: string;
  score?: number; // 0.0-1.0 graduated confidence
  source?: "pre-gate" | "llm"; // which grading path produced this
}

export interface GradingClaim {
  claim: string;
  type: "factual" | "process" | "quality";
  verified: boolean;
  evidence: string;
}

export interface GradingSummary {
  passed: number;
  failed: number;
  total: number;
  pass_rate: number;
  mean_score?: number; // mean of all expectation scores
  score_std_dev?: number; // standard deviation
}

export interface FailureFeedback {
  query: string;
  failure_reason: string;
  improvement_hint: string;
  invocation_type?: InvocationType;
}

/** Raw output from the LLM grader (before assembly into GradingResult). */
export interface GraderOutput {
  expectations: GradingExpectation[];
  summary: GradingSummary;
  claims: GradingClaim[];
  eval_feedback: EvalFeedback;
  failure_feedback?: FailureFeedback[];
}

export interface EvalFeedback {
  suggestions: Array<{ assertion: string; reason: string }>;
  overall: string;
}

export interface GradingResult {
  session_id: string;
  skill_name: string;
  transcript_path: string;
  graded_at: string;
  expectations: GradingExpectation[];
  summary: GradingSummary;
  execution_metrics: ExecutionMetrics;
  claims: GradingClaim[];
  eval_feedback: EvalFeedback;
  failure_feedback?: FailureFeedback[];
}

export interface ExecutionMetrics {
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  total_steps: number;
  bash_commands_run: number;
  errors_encountered: number;
  skills_triggered: string[];
  transcript_chars: number;
  artifact_count?: number;
  session_type?: SessionType;
}

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
// Monitoring types (v0.4)
// ---------------------------------------------------------------------------

export interface MonitoringSnapshot {
  timestamp: string;
  skill_name: string;
  window_sessions: number;
  skill_checks: number;
  pass_rate: number;
  false_negative_rate: number;
  by_invocation_type: Record<InvocationType, { passed: number; total: number }>;
  regression_detected: boolean;
  baseline_pass_rate: number;
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

export interface SessionState {
  session_id: string;
  suggestions_shown: string[]; // rule IDs already fired this session
  updated_at: string;
}

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
export type ReplayStagingMode = "routing" | "package";

export interface RoutingReplayFixture {
  fixture_id: string;
  platform: "claude_code" | "codex" | "opencode";
  target_skill_name: string;
  target_skill_path: string;
  competing_skill_paths: string[];
  workspace_root?: string;
  skill_staging_mode?: ReplayStagingMode;
}

export interface RoutingReplayEntryResult {
  query: string;
  should_trigger: boolean;
  triggered: boolean;
  passed: boolean;
  evidence?: string;
  runtime_metrics?: RuntimeReplayEntryMetrics;
}

export interface RuntimeReplayEntryMetrics {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_cost_usd: number | null;
  duration_ms: number | null;
  num_turns: number | null;
}

export interface RuntimeReplayAggregateMetrics {
  eval_runs: number;
  usage_observations: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cache_creation_input_tokens: number | null;
  total_cache_read_input_tokens: number | null;
  total_cost_usd: number | null;
  total_turns: number | null;
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

/** Token usage metrics for a session or eval run. */
export interface TokenUsageMetrics {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd?: number;
}

// ---------------------------------------------------------------------------
// Baseline comparison types
// ---------------------------------------------------------------------------

/** Result of a no-skill baseline measurement. */
export interface BaselineResult {
  skill_name: string;
  query: string;
  with_skill: boolean;
  triggered: boolean;
  pass: boolean;
  evidence?: string;
  latency_ms?: number;
  tokens?: TokenUsageMetrics;
  measured_at: string;
}

export type CreatePackageEvaluationStatus = "passed" | "replay_failed" | "baseline_failed";

export interface CreatePackageReplaySummary {
  mode: ReplayStagingMode;
  validation_mode: "host_replay";
  agent: string;
  proposal_id: string;
  fixture_id: string;
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
  runtime_metrics?: RuntimeReplayAggregateMetrics;
}

export interface CreatePackageBaselineSummary {
  mode: ReplayStagingMode;
  baseline_pass_rate: number;
  with_skill_pass_rate: number;
  lift: number;
  adds_value: boolean;
  measured_at: string;
  sample_size?: number;
  runtime_metrics?: {
    with_skill: RuntimeReplayAggregateMetrics;
    without_skill: RuntimeReplayAggregateMetrics;
  };
}

export interface CreatePackageEvaluationEvidenceSample {
  query: string;
  evidence: string | null;
}

export interface CreatePackageEvaluationEvidenceSummary {
  replay_failures: number;
  baseline_wins: number;
  baseline_regressions: number;
  replay_failure_samples: CreatePackageEvaluationEvidenceSample[];
  baseline_win_samples: CreatePackageEvaluationEvidenceSample[];
  baseline_regression_samples: CreatePackageEvaluationEvidenceSample[];
}

export interface CreatePackageEvaluationEfficiencySummary {
  with_skill: RuntimeReplayAggregateMetrics;
  without_skill: RuntimeReplayAggregateMetrics;
}

export interface CreatePackageEvaluationWatchEfficiencyRegressionSummary {
  sample_size: number;
  baseline_avg_duration_ms: number | null;
  observed_avg_duration_ms: number | null;
  duration_delta_ratio: number | null;
  baseline_avg_input_tokens: number | null;
  observed_avg_input_tokens: number | null;
  input_tokens_delta_ratio: number | null;
  baseline_avg_output_tokens: number | null;
  observed_avg_output_tokens: number | null;
  output_tokens_delta_ratio: number | null;
  baseline_avg_turns: number | null;
  observed_avg_turns: number | null;
  turns_delta_ratio: number | null;
}

export interface CreatePackageEvaluationWatchSummary {
  snapshot: MonitoringSnapshot;
  alert: string | null;
  rolled_back: boolean;
  recommendation: string;
  recommended_command: string | null;
  grade_alert: string | null;
  grade_regression: { before: number; after: number; delta: number } | null;
  efficiency_alert?: string | null;
  efficiency_regression?: CreatePackageEvaluationWatchEfficiencyRegressionSummary | null;
}

export interface CreatePackageEvaluationGradingBaselineSummary {
  proposal_id: string | null;
  measured_at: string;
  pass_rate: number;
  mean_score: number | null;
  sample_size: number;
}

export interface CreatePackageEvaluationGradingRecentSummary {
  sample_size: number;
  average_pass_rate: number | null;
  average_mean_score: number | null;
  newest_graded_at: string | null;
  oldest_graded_at: string | null;
}

export interface CreatePackageEvaluationGradingSummary {
  baseline: CreatePackageEvaluationGradingBaselineSummary | null;
  recent: CreatePackageEvaluationGradingRecentSummary | null;
  pass_rate_delta: number | null;
  mean_score_delta: number | null;
  regressed: boolean | null;
}

export interface CreatePackageEvaluationUnitTestFailureSummary {
  test_id: string;
  error: string | null;
  failed_assertions: string[];
}

export interface CreatePackageEvaluationUnitTestSummary {
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
  run_at: string;
  failing_tests: CreatePackageEvaluationUnitTestFailureSummary[];
}

export interface CreatePackageBodySummary {
  structural_valid: boolean;
  structural_reason: string;
  quality_score: number | null;
  quality_reason: string | null;
  quality_threshold: number;
  quality_passed: boolean | null;
  valid: boolean;
}

export type CreatePackageEvaluationSource = "fresh" | "artifact_cache" | "candidate_cache";
export type CreatePackageCandidateAcceptanceDecision = "root" | "accepted" | "rejected";

export interface CreatePackageCandidateAcceptanceSummary {
  decision: CreatePackageCandidateAcceptanceDecision;
  compared_to_candidate_id: string | null;
  decided_at: string;
  rationale: string;
  replay_pass_rate_delta: number | null;
  routing_pass_rate_delta: number | null;
  baseline_lift_delta: number | null;
  body_quality_delta: number | null;
  unit_test_pass_rate_delta: number | null;
}

export interface CreatePackageEvaluationSummary {
  skill_name: string;
  skill_path: string;
  mode: ReplayStagingMode;
  package_fingerprint?: string;
  candidate_id?: string;
  parent_candidate_id?: string | null;
  candidate_generation?: number | null;
  evaluation_source?: CreatePackageEvaluationSource;
  status: CreatePackageEvaluationStatus;
  evaluation_passed: boolean;
  next_command: string | null;
  replay: CreatePackageReplaySummary;
  routing?: CreatePackageReplaySummary;
  baseline: CreatePackageBaselineSummary;
  evidence?: CreatePackageEvaluationEvidenceSummary;
  efficiency?: CreatePackageEvaluationEfficiencySummary;
  grading?: CreatePackageEvaluationGradingSummary;
  body?: CreatePackageBodySummary;
  unit_tests?: CreatePackageEvaluationUnitTestSummary;
  watch?: CreatePackageEvaluationWatchSummary;
  candidate_acceptance?: CreatePackageCandidateAcceptanceSummary;
}

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

/** Type of assertion for a skill unit test. */
export type AssertionType =
  | "contains"
  | "not_contains"
  | "regex"
  | "json_path"
  | "tool_called"
  | "tool_not_called";

/** A single assertion within a skill unit test. */
export interface SkillAssertion {
  type: AssertionType;
  value: string;
  description?: string;
}

/** A skill unit test case. */
export interface SkillUnitTest {
  id: string;
  skill_name: string;
  query: string;
  assertions: SkillAssertion[];
  timeout_ms?: number;
  tags?: string[];
}

/** Result of running a single skill unit test. */
export interface UnitTestResult {
  test_id: string;
  passed: boolean;
  assertion_results: Array<{
    assertion: SkillAssertion;
    passed: boolean;
    actual?: string;
  }>;
  duration_ms: number;
  error?: string;
}

/** Aggregated result of a skill unit test suite. */
export interface UnitTestSuiteResult {
  skill_name: string;
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
  results: UnitTestResult[];
  run_at: string;
}

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
