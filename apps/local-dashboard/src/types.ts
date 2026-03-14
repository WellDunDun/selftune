/** Data contracts for the v2 SQLite-backed dashboard API */

// -- Shared primitives --------------------------------------------------------

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

// -- /api/v2/overview response ------------------------------------------------

export interface SkillSummary {
  skill_name: string;
  total_checks: number;
  triggered_count: number;
  pass_rate: number;
  unique_sessions: number;
  last_seen: string | null;
  has_evidence: boolean;
}

export interface OverviewResponse {
  overview: {
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
  };
  skills: SkillSummary[];
  version?: string;
}

// -- /api/v2/skills/:name response --------------------------------------------

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
  session_id: string;
  skill_name: string;
  invocation_mode: string | null;
  triggered: boolean;
  confidence: number | null;
  tool_name: string | null;
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

export interface SkillReportResponse {
  skill_name: string;
  usage: {
    total_checks: number;
    triggered_count: number;
    pass_rate: number;
  };
  recent_invocations: Array<{
    timestamp: string;
    session_id: string;
    query: string;
    triggered: boolean;
    source: string | null;
  }>;
  evidence: EvidenceEntry[];
  sessions_with_skill: number;
  evolution: EvolutionEntry[];
  pending_proposals: PendingProposal[];
  // Extended data
  token_usage: {
    total_input_tokens: number;
    total_output_tokens: number;
  };
  canonical_invocations: CanonicalInvocation[];
  duration_stats: {
    avg_duration_ms: number;
    total_duration_ms: number;
    execution_count: number;
    total_errors: number;
  };
  prompt_samples: PromptSample[];
  session_metadata: SessionMeta[];
}

// -- UI types -----------------------------------------------------------------

export type SkillHealthStatus = "HEALTHY" | "WARNING" | "CRITICAL" | "UNGRADED" | "UNKNOWN";

export interface SkillCard {
  name: string;
  passRate: number | null;
  checks: number;
  status: SkillHealthStatus;
  hasEvidence: boolean;
  uniqueSessions: number;
  lastSeen: string | null;
}
