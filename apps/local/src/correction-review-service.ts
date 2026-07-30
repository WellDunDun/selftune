import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";
import { recordCorrectionReviewDecision } from "@selftune/local-store";

import { CorrectionStudyServiceError } from "./routes/correction-studies.js";

export function recordLocalCorrectionReviewDecision(
  database: Database,
  input: unknown,
  decidedAt = new Date().toISOString(),
) {
  if (
    typeof input !== "object" ||
    input === null ||
    !("candidate_id" in input) ||
    !("action" in input) ||
    !("reason" in input) ||
    !("manifest_digest" in input) ||
    typeof input.candidate_id !== "string" ||
    typeof input.action !== "string" ||
    typeof input.reason !== "string" ||
    typeof input.manifest_digest !== "string" ||
    input.candidate_id.length > 128 ||
    input.reason.length > 512 ||
    !["accept", "reject", "defer"].includes(input.action)
  ) {
    throw new CorrectionStudyServiceError(
      "INVALID_CORRECTION_REVIEW",
      "A review must name a candidate, action, reason, and immutable manifest.",
      400,
    );
  }
  const action = input.action as "accept" | "reject" | "defer";
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
