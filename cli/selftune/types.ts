/**
 * Shared interfaces for selftune telemetry, eval, and grading.
 */

// ---------------------------------------------------------------------------
// Config types (written to ~/.selftune/config.json)
// ---------------------------------------------------------------------------

export interface SelftuneConfig {
  agent_type: "claude_code" | "codex" | "opencode" | "unknown";
  cli_path: string;
  llm_mode: "agent";
  agent_cli: string | null;
  hooks_installed: boolean;
  initialized_at: string;
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
  query: string;
  triggered: boolean;
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

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

export interface TranscriptMetrics {
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  assistant_turns: number;
  errors_encountered: number;
  transcript_chars: number;
  last_user_query: string;
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
}

/** Raw output from the LLM grader (before assembly into GradingResult). */
export interface GraderOutput {
  expectations: GradingExpectation[];
  summary: GradingSummary;
  claims: GradingClaim[];
  eval_feedback: EvalFeedback;
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
}

export interface EvolutionConfig {
  min_sessions: number;
  min_improvement: number; // e.g., 0.10 = 10 percentage points
  max_iterations: number;
  confidence_threshold: number; // e.g., 0.60
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
// Monitoring types (v0.4)
// ---------------------------------------------------------------------------

export interface MonitoringSnapshot {
  timestamp: string;
  skill_name: string;
  window_sessions: number;
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
  schema_version: "1.0";
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
}
