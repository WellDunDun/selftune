/** Data contracts for the v2 SQLite-backed dashboard API */

// Re-export UI types from shared package
// Re-export dashboard contract types from shared package
export type {
  EvalSnapshot,
  EvidenceEntry,
  EvolutionEntry,
  OrchestrateRunReport,
  OrchestrateRunSkillAction,
  PendingProposal,
  SkillCard,
  SkillHealthStatus,
  UnmatchedQuery,
} from "@selftune/ui/types";

// Types that remain local (only used by pages/hooks, not by shared components)
export type {
  CanonicalInvocation,
  DoctorResult,
  HealthCheck,
  HealthResponse,
  HealthStatus,
  OrchestrateRunsResponse,
  OverviewPayload,
  OverviewResponse,
  PromptSample,
  SessionMeta,
  SkillReportPayload,
  SkillReportResponse,
  SkillSummary,
  SkillUsageRecord,
  TelemetryRecord,
} from "../../../cli/selftune/dashboard-contract";
