import type { TrustBucket, TrustState, TrustWatchlistEntry } from "./dashboard-contract.js";
import type { SkillTrustSummary } from "./localdb/queries.js";

const AT_RISK_MISS_RATE_THRESHOLD = 0.15;
const UNCERTAIN_MIN_CHECKS = 10;

export function deriveTrustState(summary: SkillTrustSummary): TrustState {
  if (summary.latest_action === "rolled_back") return "rolled_back";
  if (summary.latest_action === "deployed") return "deployed";
  if (summary.latest_action === "validated") return "validated";
  if (summary.latest_action === "watch") return "watch";
  if (summary.total_checks < 5) return "low_sample";
  return "observed";
}

export function deriveTrustBucket(summary: SkillTrustSummary): TrustBucket {
  if (summary.latest_action === "rolled_back" || summary.miss_rate > AT_RISK_MISS_RATE_THRESHOLD) {
    return "at_risk";
  }
  if (
    summary.latest_action === "validated" ||
    summary.latest_action === "created" ||
    summary.latest_action === "proposed"
  ) {
    return "improving";
  }
  if (summary.total_checks < UNCERTAIN_MIN_CHECKS || summary.latest_action === "watch") {
    return "uncertain";
  }
  return "stable";
}

export function deriveTrustBucketReason(bucket: TrustBucket, summary: SkillTrustSummary): string {
  switch (bucket) {
    case "at_risk":
      if (summary.latest_action === "rolled_back") return "Recently rolled back";
      return `High miss rate (${Math.round(summary.miss_rate * 100)}%)`;
    case "improving":
      if (summary.latest_action === "validated") return "Proposal validated, pending deploy";
      return "Has pending evolution proposal";
    case "uncertain":
      if (summary.total_checks < 10) return `Low sample size (${summary.total_checks} checks)`;
      return "Under active observation";
    case "stable":
      return "Routing healthy, no issues detected";
  }
}

export function buildTrustWatchlist(summaries: SkillTrustSummary[]): TrustWatchlistEntry[] {
  return summaries.map((summary) => {
    const bucket = deriveTrustBucket(summary);
    return {
      skill_name: summary.skill_name,
      bucket,
      trust_state: deriveTrustState(summary),
      reason: deriveTrustBucketReason(bucket, summary),
      pass_rate: summary.pass_rate,
      checks: summary.total_checks,
      last_seen: summary.last_seen,
    };
  });
}
