/**
 * Service-specific types for the selftune.dev hosted badge service.
 */

/** Aggregated skill data computed from community contributions. */
export interface AggregatedSkillData {
  skill_name: string;
  weighted_pass_rate: number;
  trend: "up" | "down" | "stable" | "unknown";
  status: "HEALTHY" | "REGRESSED" | "NO DATA";
  contributor_count: number;
  session_count: number;
  last_updated: string;
}

/** Raw submission record stored in the database. */
export interface SubmissionRecord {
  id: number;
  skill_name: string;
  contributor_id: string;
  bundle_json: string;
  ip_hash: string;
  accepted_at: string;
}

/** Skill aggregation cache record. */
export interface SkillAggregationRecord {
  skill_name: string;
  weighted_pass_rate: number;
  trend: string;
  status: string;
  contributor_count: number;
  session_count: number;
  last_updated: string;
}

/** Audit log entry for the service. */
export interface ServiceAuditEntry {
  id: number;
  timestamp: string;
  action: string;
  details: string;
}
