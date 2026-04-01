// -- Cursor-based pagination types -------------------------------------------

export interface PaginationCursor {
  timestamp: string;
  id: number | string;
}

export interface PaginatedResult<T> {
  items: T[];
  next_cursor: PaginationCursor | null;
  has_more: boolean;
}

/** Parse a JSON cursor param from a URL search string. Returns null on invalid input. */
export function parseCursorParam(value: string | null | undefined): PaginationCursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && "timestamp" in parsed && "id" in parsed) {
      const { timestamp, id } = parsed as { timestamp: unknown; id: unknown };
      if (
        typeof timestamp === "string" &&
        (typeof id === "string" || (typeof id === "number" && Number.isFinite(id)))
      ) {
        return { timestamp, id };
      }
    }
  } catch {
    // Invalid cursor JSON — treat as no cursor
  }
  return null;
}

/** Parse an integer query param with bounds clamping. */
export function parseIntParam(value: string | null | undefined, defaultValue: number): number {
  if (value == null) return defaultValue;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? defaultValue : Math.max(1, Math.min(n, 10000));
}

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

export interface EvalSnapshot {
  before_pass_rate?: number;
  after_pass_rate?: number;
  net_change?: number;
  improved?: boolean;
  regressions?: Array<Record<string, unknown>>;
  new_passes?: Array<Record<string, unknown>>;
}

export interface EvolutionEntry {
  timestamp: string;
  proposal_id: string;
  skill_name?: string;
  action: string;
  details: string;
  eval_snapshot?: EvalSnapshot | null;
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
  autonomy_status: AutonomyStatus;
  attention_queue: AttentionItem[];
  trust_watchlist: TrustWatchlistEntry[];
  recent_decisions: AutonomousDecision[];
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
  validation: Record<string, unknown> | null;
  details: string | null;
  eval_set: Array<Record<string, unknown>>;
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

// -- Orchestrate run report types --------------------------------------------

export interface OrchestrateRunSkillAction {
  skill: string;
  action: "evolve" | "watch" | "skip";
  reason: string;
  deployed?: boolean;
  rolledBack?: boolean;
  alert?: string | null;
  elapsed_ms?: number;
  llm_calls?: number;
}

export interface OrchestrateRunReport {
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
  auto_graded?: number;
  skill_actions: OrchestrateRunSkillAction[];
}

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

// -- Health endpoint response -------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  spa: boolean;
  v2_data_available: boolean;
  workspace_root: string;
  git_sha: string;
  db_path: string;
  log_dir: string;
  config_dir: string;
  watcher_mode: "wal" | "jsonl" | "none";
  process_mode: "standalone" | "dev-server" | "test";
  host: string;
  port: number;
}

// -- Doctor / health check types ----------------------------------------------
export type { DoctorResult, HealthCheck, HealthStatus } from "./types.js";

// -- Execution metrics (aggregated from execution_facts enrichment columns) ---

export interface ExecutionMetrics {
  avg_files_changed: number;
  total_lines_added: number;
  total_lines_removed: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  cached_input_tokens_total: number;
  reasoning_output_tokens_total: number;
  artifact_count: number;
  session_type_distribution: Record<string, number>;
}

// -- Commit summary (aggregated from commit_tracking table) -------------------

export interface CommitRecord {
  commit_sha: string;
  commit_title: string | null;
  branch: string | null;
  repo_remote: string | null;
  timestamp: string;
}

export interface CommitSummary {
  total_commits: number;
  unique_branches: number;
  recent_commits: Array<{ sha: string; title: string; branch: string; timestamp: string }>;
}

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
}
