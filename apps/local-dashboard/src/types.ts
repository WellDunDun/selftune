/** Data contracts for the v2 SQLite-backed dashboard API */

export type {
  CanonicalInvocation,
  EvalSnapshot,
  EvidenceEntry,
  EvolutionEntry,
  OrchestrateRunReport,
  OrchestrateRunSkillAction,
  OrchestrateRunsResponse,
  OverviewPayload,
  OverviewResponse,
  PendingProposal,
  PromptSample,
  SessionMeta,
  SkillReportPayload,
  SkillReportResponse,
  SkillSummary,
  SkillUsageRecord,
  TelemetryRecord,
  UnmatchedQuery,
} from "../../../cli/selftune/dashboard-contract";

// -- UI types -----------------------------------------------------------------

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
