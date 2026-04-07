// -- UI-only types -----------------------------------------------------------

export type SkillHealthStatus = "HEALTHY" | "WARNING" | "CRITICAL" | "UNGRADED" | "UNKNOWN";

export interface SkillCard {
  name: string;
  scope: string | null;
  passRate: number | null;
  checks: number;
  status: SkillHealthStatus;
  hasEvidence: boolean;
  uniqueSessions: number;
  lastSeen: string | null;
}

// -- Job execution types (re-declared for package independence) ---------------

export interface JobExecution {
  id: string;
  jobName: string;
  status: "success" | "error";
  startedAt: string;
  durationMs: number;
  metrics: Record<string, unknown>;
  error?: string;
}

export interface JobScheduleEntry {
  name: string;
  schedule: string;
  cronExpression: string;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
  lastRunDurationMs: number | null;
  nextRunAt: string;
}

export interface JobScheduleState {
  jobs: JobScheduleEntry[];
}

// -- Dashboard contract types (re-declared for package independence) ----------

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
  skill_actions: OrchestrateRunSkillAction[];
}

// -- Overview panel types (shared between local & cloud dashboards) ----------

export type AutonomyStatusLevel = "healthy" | "watching" | "needs_review" | "blocked";

export interface AutonomyStatus {
  level: AutonomyStatusLevel;
  summary: string;
  skills_observed: number;
  attention_required: number;
  pending_reviews: number;
}

export type TrustBucket = "at_risk" | "improving" | "uncertain" | "stable";

export interface TrustWatchlistEntry {
  skill_name: string;
  bucket: TrustBucket;
  pass_rate: number | null;
  reason: string;
  last_seen: string | null;
}

export type AttentionSeverity = "critical" | "warning" | "info";

export interface AttentionItem {
  skill_name: string;
  category: string;
  severity: AttentionSeverity;
  reason: string;
  recommended_action: string;
  timestamp: string | null;
}

export type DecisionKind =
  | "proposal_created"
  | "proposal_rejected"
  | "validation_failed"
  | "proposal_deployed"
  | "rollback_triggered"
  | "regression_found";

export interface AutonomousDecision {
  skill_name: string;
  kind: DecisionKind;
  summary: string;
  timestamp: string;
}

// -- Trust / skill report types (shared between local & cloud dashboards) ----

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
