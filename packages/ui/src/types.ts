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
