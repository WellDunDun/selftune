import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";
import { recordCorrectionReviewDecision } from "@selftune/local-store";

import type { CorrectionReviewRequest } from "./correction-review-request.js";

export function recordLocalCorrectionReviewDecision(
  database: Database,
  input: CorrectionReviewRequest,
  decidedAt = new Date().toISOString(),
) {
  const { action } = input;
  const decisionId = `review:${createHash("sha256")
    .update(
      JSON.stringify({
        candidate_id: input.candidate_id,
        action,
        reason: input.reason,
        manifest_digest: input.manifest_digest,
        actor: "local-dashboard",
      }),
    )
    .digest("hex")
    .slice(0, 32)}`;
  recordCorrectionReviewDecision(database, {
    decision_id: decisionId,
    candidate_id: input.candidate_id,
    action,
    actor: "local-dashboard",
    reason: input.reason,
    manifest_digest: input.manifest_digest,
    decided_at: decidedAt,
  });
  return { recorded: true as const, action, applies_skill: false as const };
}
