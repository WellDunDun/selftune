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

export interface SkillReportResponse extends SkillReportPayload {
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
