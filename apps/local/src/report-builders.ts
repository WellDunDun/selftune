import type { InsightsResponse } from "@selftune/runtime/dashboard-contract";
import type { Database } from "bun:sqlite";
import type { PortfolioAuditResult } from "@selftune/runtime/skill-portfolio";
import { scanSynthesisCandidates } from "@selftune/runtime/synthesis";

import type { ReportComputeOptions } from "./report-compute.js";

/**
 * Worker-only report builders. Keeping these imports out of report-compute.ts lets the
 * long-lived daemon retain only the small subprocess launcher.
 */
export async function buildInsightsResponse(
  audit: PortfolioAuditResult,
  options: ReportComputeOptions,
  db: Database,
): Promise<InsightsResponse> {
  const snapshot = await scanSynthesisCandidates({ configRoot: options.configRoot, db });
  const portfolio = audit.skills.filter(
    (skill) =>
      skill.recommendation === "review_quarantine" ||
      skill.recommendation === "repair_routing" ||
      skill.recommendation === "review_consolidation",
  );
  return {
    snapshot,
    portfolio_reviews: portfolio,
    counts: {
      pending: snapshot.candidates.filter((item) => item.status === "pending").length,
      accepted: snapshot.candidates.filter((item) => item.status === "accepted").length,
      drafted: snapshot.candidates.filter((item) => item.status === "drafted").length,
      snoozed: snapshot.candidates.filter((item) => item.status === "snoozed").length,
      completed: snapshot.candidates.filter((item) =>
        ["rejected", "drafted", "released"].includes(item.status),
      ).length,
      stale_reviews: portfolio.filter((item) => item.recommendation === "review_quarantine").length,
      routing_reviews: portfolio.filter((item) => item.recommendation === "repair_routing").length,
    },
  };
}
