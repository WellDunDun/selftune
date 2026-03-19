/**
 * Shared interfaces for selftune telemetry, eval, and grading.
 */

// ---------------------------------------------------------------------------
// Config types (written to ~/.selftune/config.json)
// ---------------------------------------------------------------------------

export interface AlphaIdentity {
  enrolled: boolean;
  user_id: string;
  email?: string;
  display_name?: string;
  consent_timestamp: string;
  /** Bearer token for alpha API. Stored in plaintext in config.json with 0o600 perms. */
  api_key?: string;
  /** Cloud-issued user ID. Present when linked to cloud account. */
  cloud_user_id?: string;
}

/**
 * Derive the cloud link readiness state from an AlphaIdentity.
 * Used by status.ts and observability.ts for agent-facing diagnostics.
 */
export type AlphaLinkState =
  | "not_linked"
  | "linked_not_enrolled"
  | "enrolled_no_credential"
  | "ready";

export interface SelftuneConfig {
  agent_type: "claude_code" | "codex" | "opencode" | "openclaw" | "unknown";
  cli_path: string;
  llm_mode: "agent";
  agent_cli: string | null;
  hooks_installed: boolean;
  initialized_at: string;
  analytics_disabled?: boolean;
  alpha?: AlphaIdentity;
}

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
  agent_summary?: string;
  rollout_path?: string;
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
  CanonicalSkillInvocationRecord,
  CanonicalSourceSessionKind,
} from "@selftune/telemetry-contract";
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
} from "@selftune/telemetry-contract";

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

export interface TranscriptMetrics {
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  skills_invoked: string[];
  assistant_turns: number;
  errors_encountered: number;
  transcript_chars: number;
  last_user_query: string;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  model?: string;
  started_at?: string;
  ended_at?: string;
}

// ---------------------------------------------------------------------------
// Hook payloads (received via stdin from Claude Code)
// ---------------------------------------------------------------------------

// Shared base for pre/post tool-use hook payloads
export interface BaseToolUsePayload {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id?: string;
}

export interface PromptSubmitPayload {
  user_prompt: string;
  session_id?: string;
}

export interface PostToolUsePayload extends BaseToolUsePayload {
  transcript_path?: string;
}

export interface StopPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Eval types
// ---------------------------------------------------------------------------

export type InvocationType = "explicit" | "implicit" | "contextual" | "negative";

export interface EvalEntry {
  query: string;
  should_trigger: boolean;
  invocation_type?: InvocationType;
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
}

// ---------------------------------------------------------------------------
// Health check types
// ---------------------------------------------------------------------------

export type HealthStatus = "pass" | "fail" | "warn";

export interface HealthCheck {
  name: string;
  path: string;
  status: HealthStatus;
  message: string;
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
}

export interface EvolutionEvidenceValidation {
  improved?: boolean;
  before_pass_rate?: number;
  after_pass_rate?: number;
  net_change?: number;
  regressions?: EvalEntry[] | string[];
  new_passes?: EvalEntry[];
  per_entry_results?: Array<{ entry: EvalEntry; before_pass: boolean; after_pass: boolean }>;
  gates_passed?: number;
  gates_total?: number;
  gate_results?: Array<{ gate: ValidationGate; passed: boolean; reason: string }>;
}

export interface EvolutionEvidenceEntry {
  timestamp: string;
  proposal_id: string;
  skill_name: string;
  skill_path: string;
  target: EvolutionTarget;
  stage: "created" | "validated" | "deployed" | "rejected" | "rolled_back";
  rationale?: string;
  confidence?: number;
  details?: string;
  original_text?: string;
  proposed_text?: string;
  eval_set?: EvalEntry[];
  validation?: EvolutionEvidenceValidation;
  /** Client-generated deterministic dedup key for cloud upload. */
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
  per_entry_results?: Array<{ entry: EvalEntry; before_pass: boolean; after_pass: boolean }>;
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
// Contribution types (contribute command)
// ---------------------------------------------------------------------------

export interface ContributionQuery {
  query: string;
  invocation_type: InvocationType;
  source: string;
}

export interface ContributionEvalEntry {
  query: string;
  should_trigger: boolean;
  invocation_type?: InvocationType;
}

export interface ContributionGradingSummary {
  total_sessions: number;
  graded_sessions: number;
  average_pass_rate: number;
  expectation_count: number;
}

export interface ContributionEvolutionSummary {
  total_proposals: number;
  deployed_proposals: number;
  rolled_back_proposals: number;
  average_improvement: number;
}

export interface ContributionSessionMetrics {
  total_sessions: number;
  avg_assistant_turns: number;
  avg_tool_calls: number;
  avg_errors: number;
  top_tools: Array<{ tool: string; count: number }>;
}

export interface ContributionBundle {
  schema_version: "1.0" | "1.1" | "1.2";
  skill_name?: string;
  contributor_id: string;
  created_at: string;
  selftune_version: string;
  agent_type: string;
  sanitization_level: "conservative" | "aggressive";
  positive_queries: ContributionQuery[];
  eval_entries: ContributionEvalEntry[];
  grading_summary: ContributionGradingSummary | null;
  evolution_summary: ContributionEvolutionSummary | null;
  session_metrics: ContributionSessionMetrics;
  unmatched_queries?: Array<{ query: string; timestamp: string }>;
  pending_proposals?: Array<{
    proposal_id: string;
    skill_name?: string;
    action: string;
    timestamp: string;
    details: string;
  }>;
}

// ---------------------------------------------------------------------------
// Evolution target types (v0.6 — body + routing evolution)
// ---------------------------------------------------------------------------

/** Which part of a skill is being evolved. */
export type EvolutionTarget = "description" | "routing" | "body";

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

/** Result of validating a body evolution proposal. */
export interface BodyValidationResult {
  proposal_id: string;
  gates_passed: number;
  gates_total: number;
  gate_results: Array<{ gate: ValidationGate; passed: boolean; reason: string }>;
  improved: boolean;
  regressions: string[];
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
  latency_ms?: number;
  tokens?: TokenUsageMetrics;
  measured_at: string;
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
  assertion_results: Array<{ assertion: SkillAssertion; passed: boolean; actual?: string }>;
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

// ---------------------------------------------------------------------------
// Composability types
// ---------------------------------------------------------------------------

/** A pair of skills that co-occur in sessions. */
export interface CoOccurrencePair {
  skill_a: string;
  skill_b: string;
  co_occurrence_count: number;
  conflict_detected: boolean;
  conflict_reason?: string;
}

/** Report on skill composability / conflicts. */
export interface ComposabilityReport {
  pairs: CoOccurrencePair[];
  total_sessions_analyzed: number;
  conflict_count: number;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// SkillsBench types
// ---------------------------------------------------------------------------

/** A task from the SkillsBench benchmark suite. */
export interface SkillsBenchTask {
  task_id: string;
  category: string;
  query: string;
  expected_skill?: string;
  expected_tools?: string[];
  difficulty: "easy" | "medium" | "hard";
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Composability V2 types (synergy + sequence detection)
// ---------------------------------------------------------------------------

/** Extended pair with synergy detection */
export interface CoOccurrencePairV2 extends CoOccurrencePair {
  synergy_score: number;
  avg_errors_together: number;
  avg_errors_alone: number;
  workflow_candidate: boolean;
}

/** Ordered skill sequence detected from timestamps */
export interface SkillSequence {
  skills: string[];
  occurrence_count: number;
  synergy_score: number;
  representative_query: string;
  sequence_consistency: number;
}

/** Extended report with synergy and sequence detection */
export interface ComposabilityReportV2 extends ComposabilityReport {
  pairs: CoOccurrencePairV2[];
  sequences: SkillSequence[];
  workflow_candidates: CoOccurrencePairV2[];
  synergy_count: number;
}

// ---------------------------------------------------------------------------
// Workflow Support types
// ---------------------------------------------------------------------------

export interface DiscoveredWorkflow {
  workflow_id: string; // deterministic hash: skills.join("→")
  skills: string[]; // ordered skill sequence
  occurrence_count: number;
  avg_errors: number;
  avg_errors_individual: number;
  synergy_score: number; // clamp((individual - together) / (individual + 1), -1, 1)
  representative_query: string;
  sequence_consistency: number; // [0,1]
  completion_rate: number; // % sessions where all skills fired
  first_seen: string;
  last_seen: string;
  session_ids: string[]; // sessions that contributed to this workflow
}

export interface CodifiedWorkflow {
  name: string;
  skills: string[];
  description?: string;
  source: "discovered" | "authored";
  discovered_from?: {
    workflow_id: string;
    occurrence_count: number;
    synergy_score: number;
  };
}

export interface WorkflowDiscoveryReport {
  workflows: DiscoveredWorkflow[];
  total_sessions_analyzed: number;
  generated_at: string;
}
