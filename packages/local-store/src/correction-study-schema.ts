import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Durable, local-first evidence for an observed skill correction. These rows
 * intentionally store bounded JSON artifacts rather than source transcripts:
 * the authoritative trace stays with its harness and analytics stay in
 * DuckDB. The exact revisions and immutable manifest make a later replay
 * independently reproducible.
 */
export const correction_episodes = sqliteTable(
  "correction_episodes",
  {
    episode_id: text().primaryKey(),
    capture_key: text().notNull(),
    skill_id: text().notNull(),
    skill_name: text().notNull(),
    skill_path: text().notNull(),
    harness: text().notNull(),
    source_session_id: text().notNull(),
    pre_revision: text().notNull(),
    post_revision: text().notNull(),
    manifest_json: text().notNull(),
    correction_intent_json: text().notNull(),
    trace_payload_json: text().notNull(),
    evidence_level: text().notNull(),
    status: text().notNull(),
    reason: text(),
    captured_at: text().notNull(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    uniqueIndex("correction_episodes_capture_key_unique").on(table.capture_key),
    index("idx_correction_episodes_skill").on(table.skill_id, table.updated_at),
    index("idx_correction_episodes_status").on(table.status, table.updated_at),
    index("idx_correction_episodes_source_session").on(table.source_session_id),
  ],
);

/**
 * Append-only lifecycle receipts for a correction episode. Invalid and
 * inconclusive results are retained alongside promoted results so that failed
 * hypotheses cannot disappear from the product record.
 */
export const correction_evidence_ledger_entries = sqliteTable(
  "correction_evidence_ledger_entries",
  {
    evidence_id: text().primaryKey(),
    skill_id: text().notNull(),
    episode_id: text()
      .notNull()
      .references(() => correction_episodes.episode_id, { onDelete: "cascade" }),
    evidence_key: text().notNull(),
    evidence_level: text().notNull(),
    status: text().notNull(),
    reason: text(),
    manifest_json: text().notNull(),
    verifier_payload_json: text().notNull(),
    trial_payload_json: text().notNull(),
    recorded_at: text().notNull(),
  },
  (table) => [
    uniqueIndex("correction_evidence_ledger_episode_key_unique").on(
      table.episode_id,
      table.evidence_key,
    ),
    index("idx_correction_evidence_ledger_episode").on(table.episode_id, table.recorded_at),
    index("idx_correction_evidence_ledger_status").on(table.status, table.recorded_at),
  ],
);

/**
 * A proven correction promoted into the owning skill's regression suite. A
 * correction episode may promote at most one first-slice study case.
 */
export const promoted_study_cases = sqliteTable(
  "promoted_study_cases",
  {
    case_id: text().primaryKey(),
    episode_id: text()
      .notNull()
      .references(() => correction_episodes.episode_id, { onDelete: "restrict" }),
    evidence_id: text()
      .notNull()
      .references(() => correction_evidence_ledger_entries.evidence_id, { onDelete: "restrict" }),
    skill_name: text().notNull(),
    skill_id: text().notNull(),
    pre_revision: text().notNull(),
    post_revision: text().notNull(),
    manifest_json: text().notNull(),
    verifier_payload_json: text().notNull(),
    trial_payload_json: text().notNull(),
    evidence_level: text().notNull(),
    status: text().notNull(),
    reason: text(),
    promoted_at: text().notNull(),
    created_at: text().notNull(),
  },
  (table) => [
    uniqueIndex("promoted_study_cases_episode_unique").on(table.episode_id),
    index("idx_promoted_study_cases_skill").on(table.skill_id, table.promoted_at),
    index("idx_promoted_study_cases_evidence").on(table.evidence_id),
  ],
);

/** Append-only retirement receipt; the promoted case's evidence remains immutable. */
export const promoted_study_case_retirements = sqliteTable(
  "promoted_study_case_retirements",
  {
    retirement_id: text().primaryKey(),
    case_id: text()
      .notNull()
      .references(() => promoted_study_cases.case_id, { onDelete: "restrict" }),
    actor: text().notNull(),
    reason: text().notNull(),
    prior_manifest_digest: text().notNull(),
    retired_at: text().notNull(),
  },
  (table) => [
    uniqueIndex("promoted_study_case_retirements_case_unique").on(table.case_id),
    index("idx_promoted_study_case_retirements_case").on(table.case_id, table.retired_at),
  ],
);

export const correction_candidate_evaluations = sqliteTable(
  "correction_candidate_evaluations",
  {
    evaluation_id: text().primaryKey(),
    candidate_id: text()
      .notNull()
      .references(() => correction_signal_candidates.candidate_id, { onDelete: "restrict" }),
    current_revision: text().notNull(),
    candidate_revision: text().notNull(),
    evidence_level: text().notNull(),
    status: text().notNull(),
    reason: text(),
    blind_manifest_json: text().notNull(),
    blind_result_json: text().notNull(),
    verifier_provenance: text().notNull(),
    runtime_provenance: text().notNull(),
    cost_estimate: text(),
    cost_actual: text(),
    applies_change: text().notNull(),
    recorded_at: text().notNull(),
  },
  (table) => [
    uniqueIndex("correction_candidate_evaluations_candidate_unique").on(
      table.evaluation_id,
      table.candidate_id,
    ),
    index("idx_correction_candidate_evaluations_candidate").on(
      table.candidate_id,
      table.recorded_at,
    ),
  ],
);

/**
 * A review-only E0/E0.5 hypothesis recovered from local trace signals. This
 * is deliberately not an evaluation result or mutation instruction.
 */
export const correction_signal_candidates = sqliteTable(
  "correction_signal_candidates",
  {
    candidate_id: text().primaryKey(),
    idempotency_key: text().notNull(),
    skill_id: text().notNull(),
    skill_name: text().notNull(),
    source_session_id: text().notNull(),
    evidence_level: text().notNull(),
    lifecycle: text().notNull(),
    reason: text(),
    manifest_digest: text().notNull(),
    signal_payload_digest: text().notNull(),
    signal_payload_json: text().notNull(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    uniqueIndex("correction_signal_candidates_idempotency_unique").on(table.idempotency_key),
    index("idx_correction_signal_candidates_skill").on(table.skill_id, table.updated_at),
    index("idx_correction_signal_candidates_lifecycle").on(table.lifecycle, table.updated_at),
    index("idx_correction_signal_candidates_session").on(table.source_session_id),
  ],
);

/**
 * A bounded, local review draft derived from one signal candidate. It stores
 * only redacted preparation artifacts and cannot represent replay execution,
 * promotion, or a skill mutation.
 */
export const correction_study_drafts = sqliteTable(
  "correction_study_drafts",
  {
    draft_id: text().primaryKey(),
    idempotency_key: text().notNull(),
    candidate_id: text()
      .notNull()
      .references(() => correction_signal_candidates.candidate_id, { onDelete: "cascade" }),
    skill_id: text().notNull(),
    skill_name: text().notNull(),
    source_revision: text(),
    evidence_level: text().notNull(),
    lifecycle: text().notNull(),
    reason: text(),
    manifest_digest: text().notNull(),
    study_payload_digest: text().notNull(),
    study_payload_json: text().notNull(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    uniqueIndex("correction_study_drafts_idempotency_unique").on(table.idempotency_key),
    uniqueIndex("correction_study_drafts_candidate_unique").on(table.candidate_id),
    index("idx_correction_study_drafts_skill").on(table.skill_id, table.updated_at),
    index("idx_correction_study_drafts_lifecycle").on(table.lifecycle, table.updated_at),
  ],
);

/** Immutable human review receipts; edits always reference a replacement candidate. */
export const correction_review_decisions = sqliteTable(
  "correction_review_decisions",
  {
    decision_id: text().primaryKey(),
    candidate_id: text()
      .notNull()
      .references(() => correction_signal_candidates.candidate_id, { onDelete: "restrict" }),
    replacement_candidate_id: text().references(() => correction_signal_candidates.candidate_id, {
      onDelete: "restrict",
    }),
    action: text().notNull(),
    actor: text().notNull(),
    reason: text().notNull(),
    manifest_digest: text().notNull(),
    decided_at: text().notNull(),
  },
  (table) => [
    index("idx_correction_review_decisions_candidate").on(table.candidate_id, table.decided_at),
    index("idx_correction_review_decisions_replacement").on(table.replacement_candidate_id),
  ],
);

/** Workspace-scoped policy: capture is independent from generation or execution. */
export const correction_learning_policies = sqliteTable("correction_learning_policies", {
  workspace_id: text().primaryKey(),
  capture_enabled: text().notNull(),
  proactive_generation_enabled: text().notNull(),
  managed_execution_enabled: text().notNull(),
  kill_switch_enabled: text().notNull(),
  workspace_budget: text().notNull(),
  max_concurrency: text().notNull(),
  retention_e0_days: text().notNull(),
  updated_at: text().notNull(),
});

/** Expirable source material is intentionally separate from immutable evidence and review receipts. */
export const correction_raw_source_material = sqliteTable(
  "correction_raw_source_material",
  {
    source_id: text().primaryKey(),
    candidate_id: text()
      .notNull()
      .references(() => correction_signal_candidates.candidate_id, { onDelete: "cascade" }),
    evidence_level: text().notNull(),
    payload_json: text().notNull(),
    expires_at: text().notNull(),
    created_at: text().notNull(),
  },
  (table) => [
    index("idx_correction_raw_source_material_expiry").on(table.evidence_level, table.expires_at),
    index("idx_correction_raw_source_material_candidate").on(table.candidate_id),
  ],
);
