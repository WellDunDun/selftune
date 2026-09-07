import type { OrchestrateRunReport } from "@selftune/control-plane/orchestration";
export type {
  OrchestrateRunReport,
  OrchestrateRunSkillAction,
} from "@selftune/control-plane/orchestration";
import type { EvidenceCase, EvidenceValidation } from "@selftune/control-plane/evidence";
export type { EvidenceCase, EvidenceValidation } from "@selftune/control-plane/evidence";

import type {
  CreatePackageBodySummary,
  CreatePackageCandidateAcceptanceDecision,
  CreateCheckReadiness,
  CreatePackageEvaluationEfficiencySummary,
  CreatePackageEvaluationEvidenceSummary,
  CreatePackageEvaluationGradingSummary,
  CreatePackageEvaluationSource,
  CreatePackageReplaySummary,
  CreatePackageEvaluationStatus,
  CreatePackageEvaluationUnitTestSummary,
  CreatePackageEvaluationWatchSummary,
} from "./types.js";
import type { PaginatedResult } from "./dashboard-contract/pagination.js";
import type { CommitSummary, ExecutionMetrics } from "./dashboard-contract/execution.js";

export * from "./dashboard-contract/execution.js";
export * from "./dashboard-contract/health.js";
export * from "./dashboard-contract/local-management.js";
export * from "./dashboard-contract/pagination.js";
export * from "./dashboard-contract/requests.js";
export * from "./dashboard-contract/upstream.js";

// -- Paginated overview payload (returned when cursor params are provided) ----

export interface OverviewPaginatedPayload {
  telemetry_page: PaginatedResult<TelemetryRecord>;
  skills_page: PaginatedResult<SkillUsageRecord>;
  evolution: EvolutionEntry[];
  counts: OverviewPayload["counts"];
  unmatched_queries: UnmatchedQuery[];
  pending_proposals: PendingProposal[];
  active_sessions: number;
  recent_activity: RecentActivityItem[];
}

export interface SkillReportPaginatedPayload extends Omit<
  SkillReportPayload,
  "recent_invocations"
> {
  invocations_page: PaginatedResult<{
    timestamp: string;
    session_id: string;
    query: string;
    triggered: boolean;
    source: string | null;
  }>;
}

// -- Core record types -------------------------------------------------------

export interface TelemetryRecord {
  timestamp: string;
  session_id: string;
  skills_triggered: string[];
  errors_encountered: number;
  total_tool_calls: number;
}

export interface SkillUsageRecord {
  timestamp: string;
  session_id: string;
  skill_name: string;
  skill_path: string;
  query: string;
  triggered: boolean;
  source: string | null;
}

export type EvalSnapshot = EvidenceValidation;

export interface EvolutionEntry {
  timestamp: string;
  proposal_id: string;
  skill_name?: string;
  action: string;
  details: string;
  eval_snapshot?: EvalSnapshot | null;
  validation_mode?: "structural_guard" | "host_replay" | "llm_judge" | null;
  validation_agent?: string | null;
  validation_fixture_id?: string | null;
  validation_evidence_ref?: string | null;
}

export interface UnmatchedQuery {
  timestamp: string;
  session_id: string;
  query: string;
}

export interface PendingProposal {
  proposal_id: string;
  action: string;
  timestamp: string;
  details: string;
  skill_name?: string;
}

export interface RecentActivityItem {
  timestamp: string;
  session_id: string;
  skill_name: string;
  query: string;
  triggered: boolean;
  is_live: boolean;
}

export interface SkillSummary {
  skill_name: string;
  skill_scope: string | null;
  total_checks: number;
  triggered_count: number;
  pass_rate: number;
  unique_sessions: number;
  last_seen: string | null;
  has_evidence: boolean;
  routing_confidence: number | null;
  confidence_coverage: number;
  testing_readiness?: SkillTestingReadiness;
  create_readiness?: CreateCheckReadiness;
}

// -- Autonomy-first overview types -------------------------------------------

export type AutonomyStatusLevel = "healthy" | "watching" | "needs_review" | "blocked";

export interface AutonomyStatus {
  level: AutonomyStatusLevel;
  summary: string;
  last_run: string | null;
  skills_observed: number;
  pending_reviews: number;
  attention_required: number;
}

export type AttentionCategory =
  | "needs_review"
  | "regression"
  | "low_trust"
  | "polluted"
  | "blocked";

export interface AttentionItem {
  skill_name: string;
  category: AttentionCategory;
  severity: "critical" | "warning" | "info";
  reason: string;
  recommended_action: string;
  timestamp: string;
}

export type TrustBucket = "at_risk" | "improving" | "uncertain" | "stable";

export interface TrustWatchlistEntry {
  skill_name: string;
  bucket: TrustBucket;
  trust_state: TrustState;
  reason: string;
  pass_rate: number | null;
  checks: number;
  last_seen: string | null;
}

export type DecisionKind =
  | "proposal_created"
  | "proposal_rejected"
  | "validation_failed"
  | "proposal_deployed"
  | "rollback_triggered"
  | "regression_found";

export interface AutonomousDecision {
  timestamp: string;
  kind: DecisionKind;
  skill_name: string;
  proposal_id?: string;
  summary: string;
}

export interface OverviewPayload {
  telemetry: TelemetryRecord[];
  skills: SkillUsageRecord[];
  evolution: EvolutionEntry[];
  counts: {
    telemetry: number;
    skills: number;
    evolution: number;
    evidence: number;
    sessions: number;
    prompts: number;
  };
  unmatched_queries: UnmatchedQuery[];
  pending_proposals: PendingProposal[];
  active_sessions: number;
  recent_activity: RecentActivityItem[];
}

export interface OverviewResponse {
  overview: OverviewPayload;
  skills: SkillSummary[];
  version?: string;
  watched_skills: string[];
  autonomy_status: AutonomyStatus;
  attention_queue: AttentionItem[];
  trust_watchlist: TrustWatchlistEntry[];
  recent_decisions: AutonomousDecision[];
  creator_testing?: CreatorTestingOverview;
}

export interface DashboardShellResponse {
  version?: string;
  skills: SkillSummary[];
  latest_evolutions: Array<{
    timestamp: string;
    skill_name: string;
  }>;
  pending_proposals: Array<{
    proposal_id: string;
    action: string;
    skill_name?: string;
  }>;
}

export interface EvidenceEntry {
  proposal_id: string;
  target: string;
  stage: string;
  timestamp: string;
  rationale: string | null;
  confidence: number | null;
  original_text: string | null;
  proposed_text: string | null;
  validation: EvidenceValidation | null;
  evidence_error?: string;
  details: string | null;
  eval_set: readonly EvidenceCase[];
}

export interface CanonicalInvocation {
  timestamp: string;
  occurred_at?: string;
  session_id: string;
  skill_name: string;
  invocation_mode: string | null;
  triggered: boolean;
  confidence: number | null;
  tool_name: string | null;
  agent_type?: string | null;
  query?: string | null;
  source?: string | null;
  skill_path?: string | null;
  skill_scope?: string | null;
  observation_kind?: ObservationKind;
  historical_context?: HistoricalContext | null;
}

export interface PromptSample {
  prompt_text: string;
  prompt_kind: string | null;
  is_actionable: boolean;
  occurred_at: string;
  session_id: string;
}

export interface SessionMeta {
  session_id: string;
  platform: string | null;
  model: string | null;
  agent_cli: string | null;
  branch: string | null;
  workspace_path: string | null;
  started_at: string | null;
  ended_at: string | null;
  completion_status: string | null;
}

export interface SkillReportPayload {
  skill_name: string;
  usage: {
    total_checks: number;
    triggered_count: number;
    pass_rate: number;
  };
  /**
   * @deprecated Use `canonical_invocations` from SkillReportResponse instead.
   * Retained for backward compatibility; the backend now returns unified data
   * in `canonical_invocations` from the consolidated `skill_invocations` table.
   */
  recent_invocations: Array<{
    timestamp: string;
    session_id: string;
    query: string;
    triggered: boolean;
    source: string | null;
  }>;
  evidence: EvidenceEntry[];
  sessions_with_skill: number;
}

export type SkillEvalReadiness = "log_ready" | "cold_start_ready" | "telemetry_only";

export type CreatorLoopNextStep =
  | "generate_evals"
  | "run_unit_tests"
  | "run_replay_dry_run"
  | "measure_baseline"
  | "deploy_candidate"
  | "watch_deployment";

export type DeploymentReadiness = "blocked" | "ready_to_deploy" | "watching" | "rolled_back";

export interface SkillTestingReadiness {
  skill_name: string;
  eval_readiness: SkillEvalReadiness;
  next_step: CreatorLoopNextStep;
  summary: string;
  recommended_command: string;
  skill_path: string | null;
  trusted_trigger_count: number;
  trusted_session_count: number;
  eval_set_entries: number;
  latest_eval_at: string | null;
  unit_test_cases: number;
  unit_test_pass_rate: number | null;
  unit_test_ran_at: string | null;
  replay_check_count: number;
  latest_validation_mode: "structural_guard" | "host_replay" | "llm_judge" | null;
  baseline_sample_size: number;
  baseline_pass_rate: number | null;
  latest_baseline_at: string | null;
  package_evaluation_status?: CreatePackageEvaluationStatus | null;
  package_evaluation_passed?: boolean | null;
  latest_package_evaluation_at?: string | null;
  deployment_readiness: DeploymentReadiness;
  deployment_summary: string;
  deployment_command: string | null;
  latest_evolution_action: string | null;
  latest_evolution_at: string | null;
}

import type { DashboardActionName } from "./dashboard-contract/action-name.js";
export type { DashboardActionName } from "./dashboard-contract/action-name.js";

export type DashboardActionEventStage =
  | "started"
  | "progress"
  | "stdout"
  | "stderr"
  | "metrics"
  | "finished";

export interface DashboardActionResultSummary {
  reason: string | null;
  improved: boolean | null;
  deployed: boolean | null;
  before_pass_rate: number | null;
  before_label?: string | null;
  after_pass_rate: number | null;
  after_label?: string | null;
  net_change: number | null;
  net_change_label?: string | null;
  validation_mode: string | null;
  validation_label?: string | null;
  recommended_command?: string | null;
  package_evaluation_source?: CreatePackageEvaluationSource | null;
  package_candidate_id?: string | null;
  package_parent_candidate_id?: string | null;
  package_candidate_generation?: number | null;
  package_candidate_acceptance_decision?: CreatePackageCandidateAcceptanceDecision | null;
  package_candidate_acceptance_rationale?: string | null;
  package_evidence?: CreatePackageEvaluationEvidenceSummary | null;
  package_efficiency?: CreatePackageEvaluationEfficiencySummary | null;
  package_routing?: CreatePackageReplaySummary | null;
  package_body?: CreatePackageBodySummary | null;
  package_grading?: CreatePackageEvaluationGradingSummary | null;
  package_unit_tests?: CreatePackageEvaluationUnitTestSummary | null;
  package_watch?: CreatePackageEvaluationWatchSummary | null;
  /** Search run provenance — populated only for search-run actions. */
  search_run?: DashboardSearchRunSummary | null;
  /** Whether the watch gate passed for publish actions (null for non-publish actions). */
  watch_gate_passed?: boolean | null;
}

/** Compact search run result surfaced in the action result summary. */
export interface DashboardSearchRunSummary {
  search_id: string;
  parent_candidate_id: string | null;
  winner_candidate_id: string | null;
  winner_rationale: string | null;
  candidates_evaluated: number;
  frontier_size: number;
  parent_selection_method: string;
  surface_plan?: {
    routing_count: number;
    body_count: number;
    weakness_source: string;
    routing_weakness: number | null;
    body_weakness: number | null;
  } | null;
}

export interface DashboardActionMetrics {
  platform: string | null;
  model: string | null;
  session_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_cost_usd: number | null;
  duration_ms: number | null;
  num_turns: number | null;
}

export type DashboardActionProgressUnit = "eval" | "llm_call" | "step";

export interface DashboardActionProgress {
  current: number;
  total: number;
  status: "started" | "finished";
  unit?: DashboardActionProgressUnit | null;
  phase?: string | null;
  label?: string | null;
  query: string | null;
  passed: boolean | null;
  evidence: string | null;
}

export interface DashboardActionEvent {
  event_id: string;
  action: DashboardActionName;
  stage: DashboardActionEventStage;
  skill_name: string | null;
  skill_path: string | null;
  ts: number;
  chunk?: string;
  success?: boolean;
  exit_code?: number | null;
  error?: string | null;
  summary?: DashboardActionResultSummary | null;
  metrics?: DashboardActionMetrics | null;
  progress?: DashboardActionProgress | null;
}

export type CreatorOverviewStep =
  | "run_create_check"
  | "finish_package"
  | "generate_evals"
  | "run_unit_tests"
  | "run_replay_dry_run"
  | "measure_baseline"
  | "deploy_candidate"
  | "watch_deployment";

export interface CreatorTestingOverview {
  summary: string;
  counts: {
    run_create_check: number;
    finish_package: number;
    generate_evals: number;
    run_unit_tests: number;
    run_replay_dry_run: number;
    measure_baseline: number;
    deploy_candidate: number;
    watch_deployment: number;
  };
  priorities: Array<{
    skill_name: string;
    step: CreatorOverviewStep;
    summary: string;
    recommended_command: string;
  }>;
}

// -- Orchestrate run report types --------------------------------------------

export interface OrchestrateRunsResponse {
  runs: OrchestrateRunReport[];
}

// -- Performance analytics response -------------------------------------------

export interface AnalyticsResponse {
  /** Daily pass rate trend (last 90 days, bucketed by day) */
  pass_rate_trend: Array<{
    date: string;
    pass_rate: number;
    total_checks: number;
  }>;

  /** Skills ranked by pass rate with trend direction */
  skill_rankings: Array<{
    skill_name: string;
    pass_rate: number;
    total_checks: number;
    triggered_count: number;
  }>;

  /** Daily successful trigger counts by skill (last 30 days). */
  skill_trigger_trends?: Array<{
    skill_name: string;
    points: Array<{ date: string; count: number }>;
  }>;

  /** Daily check counts for heatmap (last 84 days / 12 weeks) */
  daily_activity: Array<{
    date: string;
    checks: number;
  }>;

  /** Evolution impact — before/after pass rates for deployed evolutions */
  evolution_impact: Array<{
    skill_name: string;
    proposal_id: string;
    deployed_at: string;
    pass_rate_before: number;
    pass_rate_after: number;
  }>;

  /** Aggregate summary */
  summary: {
    total_evolutions: number;
    avg_improvement: number;
    total_checks_30d: number;
    active_skills: number;
  };
}

// -- Replay entry result types ------------------------------------------------

export interface ReplayEntryResult {
  proposal_id: string;
  skill_name: string;
  validation_mode: string;
  phase: string;
  query: string;
  should_trigger: boolean;
  triggered: boolean;
  passed: boolean;
  evidence: string | null;
}

// -- Package search / frontier types (bounded package evolution) ---------------

/**
 * Dashboard-facing view of a package search run result.
 * References `PackageSearchRunResult` from types.ts — does not redefine search
 * semantics, only surfaces what the search runner provides.
 */
export interface DashboardSearchRunView {
  search_id: string;
  skill_name: string;
  parent_candidate_id: string | null;
  candidates_evaluated: number;
  winner_candidate_id: string | null;
  winner_rationale: string | null;
  started_at: string;
  completed_at: string;
  provenance: DashboardSearchProvenance;
}

/** Provenance detail surfaced in the dashboard for a search run. */
export interface DashboardSearchProvenance {
  frontier_size: number;
  parent_selection_method: string;
  candidate_fingerprints: string[];
  surface_plan?: {
    routing_count: number;
    body_count: number;
    weakness_source: string;
    routing_weakness: number | null;
    body_weakness: number | null;
  } | null;
  evaluation_summaries: Array<{
    candidate_id: string;
    decision: string;
    rationale: string;
  }>;
}

/** A frontier member shown in the skill report's frontier state panel. */
export interface DashboardFrontierMember {
  candidate_id: string;
  skill_name: string;
  fingerprint: string;
  decision: "accepted" | "rejected" | "pending";
  measured_delta: number | null;
  created_at: string;
  parent_candidate_id: string | null;
  /** True when this candidate was demoted by watch-fed evidence. */
  watch_demoted?: boolean;
  /** Evidence rank within the accepted frontier (1 = best). */
  evidence_rank?: number | null;
}

/** Frontier state summary surfaced in the skill report. */
export interface DashboardFrontierState {
  skill_name: string;
  accepted_count: number;
  rejected_count: number;
  pending_count: number;
  members: DashboardFrontierMember[];
  latest_search_run: DashboardSearchRunView | null;
}

// -- Doctor / health check types ----------------------------------------------
export type { DoctorResult, HealthCheck, HealthStatus } from "./types.js";

// -- Trust-oriented types for skill report ------------------------------------

export type TrustState =
  | "low_sample"
  | "observed"
  | "watch"
  | "validated"
  | "deployed"
  | "rolled_back";

export type ObservationKind =
  | "canonical"
  | "repaired_trigger"
  | "repaired_contextual_miss"
  | "legacy_materialized";

export type HistoricalContext = "previously_missed";

export interface ExampleRow {
  timestamp: string | null;
  session_id: string;
  query_text: string;
  triggered: boolean;
  confidence: number | null;
  invocation_mode: string | null;
  prompt_kind: string | null;
  source: string | null;
  platform: string | null;
  workspace_path: string | null;
  query_origin: "inline_query" | "matched_prompt" | "missing";
  is_system_like: boolean;
  observation_kind: ObservationKind;
  historical_context?: HistoricalContext | null;
}

export interface TrustFields {
  trust: {
    state: TrustState;
    summary: string;
  };
  coverage: {
    checks: number;
    sessions: number;
    workspaces: number;
    first_seen: string | null;
    last_seen: string | null;
  };
  evidence_quality: {
    prompt_link_rate: number;
    inline_query_rate: number;
    user_prompt_rate: number;
    meta_prompt_rate: number;
    internal_prompt_rate: number;
    no_prompt_rate: number;
    system_like_rate: number;
    invocation_mode_coverage: number;
    confidence_coverage: number;
    source_coverage: number;
    scope_coverage: number;
  };
  routing_quality: {
    missed_triggers: number;
    miss_rate: number;
    avg_confidence: number | null;
    confidence_coverage: number;
    low_confidence_rate: number | null;
  };
  evolution_state: {
    has_evidence: boolean;
    has_pending_proposals: boolean;
    latest_action: string | null;
    latest_timestamp: string | null;
    evidence_rows: number;
    evolution_rows: number;
  };
  data_hygiene: {
    naming_variants: string[];
    source_breakdown: Array<{ source: string; count: number }>;
    prompt_kind_breakdown: Array<{ kind: string; count: number }>;
    observation_breakdown: Array<{ kind: ObservationKind; count: number }>;
    raw_checks: number;
    operational_checks: number;
    internal_prompt_rows: number;
    internal_prompt_rate: number;
    legacy_rows: number;
    legacy_rate: number;
    repaired_rows: number;
    repaired_rate: number;
  };
  examples: {
    good: ExampleRow[];
    missed: ExampleRow[];
    noisy: ExampleRow[];
  };
}

export interface SkillReportResponse extends SkillReportPayload, TrustFields {
  /** Watch trust score (0-1) from the most recent watch cycle, null if never watched. */
  watch_trust_score: number | null;
  evolution: EvolutionEntry[];
  pending_proposals: PendingProposal[];
  token_usage: {
    total_input_tokens: number;
    total_output_tokens: number;
  };
  canonical_invocations: CanonicalInvocation[];
  duration_stats: {
    avg_duration_ms: number;
    total_duration_ms: number;
    execution_count: number;
    missed_triggers: number;
  };
  selftune_stats: {
    total_llm_calls: number;
    total_elapsed_ms: number;
    avg_elapsed_ms: number;
    run_count: number;
  };
  prompt_samples: PromptSample[];
  session_metadata: SessionMeta[];
  execution_metrics?: ExecutionMetrics | null;
  commit_summary?: CommitSummary | null;
  description_quality?: {
    composite: number;
    criteria: {
      length: number;
      trigger_context: number;
      vagueness: number;
      specificity: number;
      not_just_name: number;
    };
  } | null;
  testing_readiness?: SkillTestingReadiness;
  create_readiness?: CreateCheckReadiness;
  /** Package frontier state — populated when bounded package evolution data exists. */
  frontier_state?: DashboardFrontierState | null;
}
export type { LibrarySnapshot, SyncPreferences } from "@selftune/control-plane";

/** A renderer-safe projection of the Cloud billing API response. */
export interface DesktopBillingPlan {
  readonly id: "free" | "pro" | "team" | "enterprise";
  readonly name: string;
  readonly price: string | null;
  readonly period: string | null;
  readonly description: string;
  readonly features: readonly string[];
  readonly highlighted: boolean;
  readonly seats?: { readonly minimum: number; readonly label: string | null } | null;
}

export interface DesktopBillingStatus {
  readonly plan: DesktopBillingPlan["id"];
  readonly subscriptionStatus:
    | "none"
    | "active"
    | "canceled"
    | "incomplete"
    | "incomplete_expired"
    | "past_due"
    | "paused"
    | "trialing"
    | "unpaid";
  readonly currentPeriodEnd: string | null;
  readonly trialEnd: string | null;
  readonly seatCount: number;
  readonly hasStripeCustomer: boolean;
  readonly canManageBilling: boolean;
  readonly availablePlans: readonly DesktopBillingPlan[];
}

export interface DesktopBillingCheckoutRequest {
  readonly plan: "pro" | "team";
  readonly seats?: number;
}

export interface DesktopBillingSession {
  readonly url: string;
}

export interface DesktopBillingCheckoutFinalizeRequest {
  readonly sessionId: string;
}

export interface DesktopBillingCheckoutFinalizeResult {
  readonly finalized: boolean;
  readonly billing: DesktopBillingStatus | null;
  readonly sessionStatus: string | null;
  readonly paymentStatus: string | null;
}
