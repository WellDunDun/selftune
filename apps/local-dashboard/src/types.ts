/** Data contracts matching the dashboard-server.ts LiveDashboardPayload shape */

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
  source?: string;
}

export interface EvolutionEntry {
  timestamp: string;
  proposal_id: string;
  action: string;
  details: string;
}

export interface DecisionRecord {
  timestamp: string;
  skill_name: string;
  action: string;
  rationale: string;
  proposal_id?: string;
}

export interface MonitoringSnapshot {
  timestamp: string;
  skill_name: string;
  window_sessions: number;
  skill_checks: number;
  pass_rate: number;
  false_negative_rate: number;
  by_invocation_type: Record<string, { passed: number; total: number }>;
  regression_detected: boolean;
  baseline_pass_rate: number;
}

export interface UnmatchedQuery {
  timestamp: string;
  session_id: string;
  query: string;
}

export interface PendingProposal {
  timestamp: string;
  proposal_id: string;
  skill_name: string;
  action: string;
  details: string;
}

export interface OverviewPayload {
  telemetry: TelemetryRecord[];
  skills: SkillUsageRecord[];
  evolution: EvolutionEntry[];
  decisions: DecisionRecord[];
  computed: {
    snapshots: Record<string, MonitoringSnapshot>;
    unmatched: UnmatchedQuery[];
    unmatched_count: number;
    pendingProposals: PendingProposal[];
  };
  counts: {
    telemetry: number;
    skills: number;
    queries: number;
    evolution: number;
    evidence: number;
    decisions: number;
  };
}

export interface EvaluationRecord {
  timestamp: string;
  session_id: string;
  query: string;
  skill_name: string;
  triggered: boolean;
  source: string | null;
}

export type SkillHealthStatus = "HEALTHY" | "WARNING" | "CRITICAL" | "UNGRADED" | "UNKNOWN";

export interface SkillCard {
  name: string;
  passRate: number | null;
  checks: number;
  regression: boolean;
  status: SkillHealthStatus;
  snapshot: MonitoringSnapshot | null;
}
