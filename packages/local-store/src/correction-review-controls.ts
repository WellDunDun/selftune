import type { Database } from "bun:sqlite";
import type {
  correction_learning_policies,
  correction_review_decisions,
} from "./drizzle-schema.js";

type StoredPolicy = typeof correction_learning_policies.$inferSelect;
type StoredDecision = typeof correction_review_decisions.$inferSelect;

export type CorrectionReviewAction = "accept" | "edit" | "reject" | "defer";

export interface CorrectionReviewDecisionInput {
  readonly decision_id: string;
  readonly candidate_id: string;
  readonly replacement_candidate_id?: string;
  readonly action: CorrectionReviewAction;
  readonly actor: string;
  readonly reason: string;
  readonly manifest_digest: string;
  readonly decided_at: string;
}

export interface CorrectionLearningPolicy {
  readonly capture_enabled: boolean;
  readonly proactive_generation_enabled: boolean;
  readonly managed_execution_enabled: boolean;
  readonly kill_switch_enabled: boolean;
  readonly workspace_budget: number;
  readonly max_concurrency: number;
  readonly retention_e0_days: number;
  readonly updated_at: string;
}

const DEFAULT_POLICY: Omit<CorrectionLearningPolicy, "updated_at"> = {
  capture_enabled: true,
  proactive_generation_enabled: false,
  managed_execution_enabled: false,
  kill_switch_enabled: false,
  workspace_budget: 20,
  max_concurrency: 1,
  retention_e0_days: 30,
};

function requireIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`Invalid ${field}.`);
}

function requireTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid timestamp.");
}

function asPolicy(row: StoredPolicy): CorrectionLearningPolicy {
  return {
    capture_enabled: row.capture_enabled === "1",
    proactive_generation_enabled: row.proactive_generation_enabled === "1",
    managed_execution_enabled: row.managed_execution_enabled === "1",
    kill_switch_enabled: row.kill_switch_enabled === "1",
    workspace_budget: Number(row.workspace_budget),
    max_concurrency: Number(row.max_concurrency),
    retention_e0_days: Number(row.retention_e0_days),
    updated_at: String(row.updated_at),
  };
}

export function getCorrectionLearningPolicy(
  database: Database,
  workspaceId: string,
): CorrectionLearningPolicy {
  requireIdentifier(workspaceId, "workspace id");
  const row = database
    .query<StoredPolicy, [string]>(
      "SELECT * FROM correction_learning_policies WHERE workspace_id = ?",
    )
    .get(workspaceId);
  if (row) return asPolicy(row);
  const updated_at = new Date().toISOString();
  database
    .query(
      `INSERT INTO correction_learning_policies
       (workspace_id, capture_enabled, proactive_generation_enabled, managed_execution_enabled,
        kill_switch_enabled, workspace_budget, max_concurrency, retention_e0_days, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workspaceId,
      "1",
      "0",
      "0",
      "0",
      String(DEFAULT_POLICY.workspace_budget),
      String(DEFAULT_POLICY.max_concurrency),
      String(DEFAULT_POLICY.retention_e0_days),
      updated_at,
    );
  return { ...DEFAULT_POLICY, updated_at };
}

export function setCorrectionLearningPolicy(
  database: Database,
  workspaceId: string,
  policy: CorrectionLearningPolicy,
): CorrectionLearningPolicy {
  requireIdentifier(workspaceId, "workspace id");
  if (
    !Number.isInteger(policy.workspace_budget) ||
    policy.workspace_budget < 1 ||
    policy.workspace_budget > 1_000 ||
    !Number.isInteger(policy.max_concurrency) ||
    policy.max_concurrency < 1 ||
    policy.max_concurrency > 32 ||
    !Number.isInteger(policy.retention_e0_days) ||
    policy.retention_e0_days < 1 ||
    policy.retention_e0_days > 3650
  ) {
    throw new Error("Correction learning policy limits are out of bounds.");
  }
  requireTimestamp(policy.updated_at);
  database
    .query(
      `INSERT INTO correction_learning_policies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         capture_enabled=excluded.capture_enabled,
         proactive_generation_enabled=excluded.proactive_generation_enabled,
         managed_execution_enabled=excluded.managed_execution_enabled,
         kill_switch_enabled=excluded.kill_switch_enabled,
         workspace_budget=excluded.workspace_budget,
         max_concurrency=excluded.max_concurrency,
         retention_e0_days=excluded.retention_e0_days,
         updated_at=excluded.updated_at`,
    )
    .run(
      workspaceId,
      policy.capture_enabled ? "1" : "0",
      policy.proactive_generation_enabled ? "1" : "0",
      policy.managed_execution_enabled ? "1" : "0",
      policy.kill_switch_enabled ? "1" : "0",
      String(policy.workspace_budget),
      String(policy.max_concurrency),
      String(policy.retention_e0_days),
      policy.updated_at,
    );
  return policy;
}

/** Append-only receipt. An edit must point at a distinct, already-captured candidate with new evidence. */
export function recordCorrectionReviewDecision(
  database: Database,
  input: CorrectionReviewDecisionInput,
): void {
  for (const [value, field] of [
    [input.decision_id, "decision id"],
    [input.candidate_id, "candidate id"],
    [input.actor, "actor"],
  ] as const)
    requireIdentifier(value, field);
  if (!input.reason.trim() || !/^sha256:[a-f0-9]{64}$/.test(input.manifest_digest))
    throw new Error("A decision needs a reason and manifest provenance.");
  requireTimestamp(input.decided_at);
  const existing = database
    .query<StoredDecision, [string]>(
      "SELECT * FROM correction_review_decisions WHERE decision_id = ?",
    )
    .get(input.decision_id);
  if (existing) {
    if (
      existing.candidate_id === input.candidate_id &&
      existing.replacement_candidate_id === (input.replacement_candidate_id ?? null) &&
      existing.action === input.action &&
      existing.actor === input.actor &&
      existing.reason === input.reason &&
      existing.manifest_digest === input.manifest_digest
    )
      return;
    throw new Error("The review decision id is already bound to another immutable receipt.");
  }
  const original = database
    .query<{ manifest_digest: string }, [string]>(
      "SELECT manifest_digest FROM correction_signal_candidates WHERE candidate_id = ?",
    )
    .get(input.candidate_id);
  if (!original) throw new Error("The correction candidate does not exist.");
  if (input.manifest_digest !== original.manifest_digest)
    throw new Error("A decision must cite the candidate's exact manifest provenance.");
  const terminal = database
    .query<{ action: string }, [string]>(
      `SELECT action FROM correction_review_decisions
       WHERE candidate_id = ? AND action IN ('accept', 'reject')
       ORDER BY decided_at DESC, decision_id DESC LIMIT 1`,
    )
    .get(input.candidate_id);
  if (terminal)
    throw new Error(`The correction candidate already has a terminal ${terminal.action} decision.`);
  if (input.action === "edit") {
    if (!input.replacement_candidate_id || input.replacement_candidate_id === input.candidate_id)
      throw new Error("An edit requires a distinct replacement candidate.");
    const replacement = database
      .query<{ manifest_digest: string; lifecycle: string }, [string]>(
        "SELECT manifest_digest, lifecycle FROM correction_signal_candidates WHERE candidate_id = ?",
      )
      .get(input.replacement_candidate_id);
    if (
      !replacement ||
      replacement.manifest_digest === original.manifest_digest ||
      replacement.lifecycle !== "deferred"
    )
      throw new Error("An edit requires new, deferred evidence for its replacement candidate.");
  } else if (input.replacement_candidate_id) {
    throw new Error("Only an edit may reference a replacement candidate.");
  }
  database
    .query(
      `INSERT INTO correction_review_decisions
       (decision_id, candidate_id, replacement_candidate_id, action, actor, reason, manifest_digest, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.decision_id,
      input.candidate_id,
      input.replacement_candidate_id ?? null,
      input.action,
      input.actor,
      input.reason,
      input.manifest_digest,
      input.decided_at,
    );
}

export function listCorrectionReviewDecisions(
  database: Database,
  candidateId: string,
  limit = 50,
): readonly StoredDecision[] {
  requireIdentifier(candidateId, "candidate id");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Invalid decision limit.");
  return database
    .query<StoredDecision, [string, number]>(
      "SELECT * FROM correction_review_decisions WHERE candidate_id = ? ORDER BY decided_at DESC, decision_id ASC LIMIT ?",
    )
    .all(candidateId, limit);
}

export function listCorrectionLearningPolicies(
  database: Database,
  limit = 50,
): ReadonlyArray<{ readonly workspace_id: string; readonly policy: CorrectionLearningPolicy }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Invalid policy limit.");
  return database
    .query<StoredPolicy, [number]>(
      "SELECT * FROM correction_learning_policies ORDER BY workspace_id ASC LIMIT ?",
    )
    .all(limit)
    .map((row) => ({ workspace_id: String(row.workspace_id), policy: asPolicy(row) }));
}

/** Deletes only separately-held, expired E0 raw material; candidates, drafts, ledgers, promotions, and receipts remain. */
export function purgeExpiredE0CorrectionSourceMaterial(database: Database, now: string): number {
  requireTimestamp(now);
  return database
    .query(
      "DELETE FROM correction_raw_source_material WHERE evidence_level = 'E0' AND expires_at <= ?",
    )
    .run(now).changes;
}
