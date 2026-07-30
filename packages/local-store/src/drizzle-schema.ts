/**
 * Typed schema for SelfTune's local SQLite operational store.
 *
 * This is the source of truth for Drizzle Kit migrations and runtime queries.
 * Keep compatibility-only bootstrap SQL in `schema.ts`; new schema changes
 * belong here and in a generated migration.
 */

import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export {
  correction_episodes,
  correction_evidence_ledger_entries,
  correction_signal_candidates,
  correction_study_drafts,
  correction_review_decisions,
  correction_learning_policies,
  correction_raw_source_material,
  promoted_study_cases,
  promoted_study_case_retirements,
  correction_candidate_evaluations,
} from "./correction-study-schema.js";

export const sessions = sqliteTable("sessions", {
  session_id: text().primaryKey(),
  started_at: text(),
  ended_at: text(),
  platform: text(),
  model: text(),
  completion_status: text(),
  source_session_kind: text(),
  agent_cli: text(),
  workspace_path: text(),
  repo_remote: text(),
  branch: text(),
  schema_version: text(),
  normalized_at: text(),
  normalizer_version: text(),
  capture_mode: text(),
  raw_source_ref: text(),
});

export const prompts = sqliteTable(
  "prompts",
  {
    prompt_id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => sessions.session_id),
    occurred_at: text(),
    prompt_kind: text(),
    is_actionable: integer(),
    prompt_index: integer(),
    prompt_text: text(),
    schema_version: text(),
    platform: text(),
    normalized_at: text(),
    normalizer_version: text(),
    capture_mode: text(),
    raw_source_ref: text(),
  },
  (table) => [
    index("idx_prompts_occurred").on(table.occurred_at),
    index("idx_prompts_session").on(table.session_id),
  ],
);

export const skill_invocations = sqliteTable(
  "skill_invocations",
  {
    skill_invocation_id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => sessions.session_id),
    occurred_at: text(),
    skill_name: text().notNull(),
    invocation_mode: text(),
    triggered: integer(),
    confidence: real(),
    tool_name: text(),
    matched_prompt_id: text(),
    agent_type: text(),
    query: text(),
    skill_path: text(),
    skill_version_hash: text(),
    skill_scope: text(),
    source: text(),
    schema_version: text(),
    platform: text(),
    normalized_at: text(),
    normalizer_version: text(),
    capture_mode: text(),
    raw_source_ref: text(),
  },
  (table) => [
    index("idx_skill_inv_dedup").on(
      table.session_id,
      table.skill_name,
      table.query,
      table.occurred_at,
      table.triggered,
    ),
    index("idx_skill_inv_version").on(
      table.skill_name,
      table.skill_version_hash,
      table.occurred_at,
    ),
    index("idx_skill_inv_scope").on(table.skill_name, table.skill_scope, table.occurred_at),
    index("idx_skill_inv_query_triggered").on(table.query, table.triggered),
    index("idx_skill_inv_ts").on(table.occurred_at),
    index("idx_skill_inv_name").on(table.skill_name),
    index("idx_skill_inv_session").on(table.session_id),
  ],
);

export const execution_facts = sqliteTable(
  "execution_facts",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    execution_fact_id: text(),
    session_id: text()
      .notNull()
      .references(() => sessions.session_id),
    occurred_at: text(),
    prompt_id: text(),
    tool_calls_json: text(),
    total_tool_calls: integer(),
    assistant_turns: integer(),
    errors_encountered: integer(),
    input_tokens: integer(),
    output_tokens: integer(),
    duration_ms: integer(),
    completion_status: text(),
    schema_version: text(),
    platform: text(),
    normalized_at: text(),
    normalizer_version: text(),
    capture_mode: text(),
    raw_source_ref: text(),
    files_changed: integer(),
    lines_added: integer(),
    lines_removed: integer(),
    lines_modified: integer(),
    cached_input_tokens: integer(),
    reasoning_output_tokens: integer(),
    cost_usd: real(),
    artifact_count: integer(),
    session_type: text(),
  },
  (table) => [
    uniqueIndex("idx_exec_facts_canonical_id").on(table.execution_fact_id),
    index("idx_exec_facts_session").on(table.session_id),
  ],
);

export const evolution_evidence = sqliteTable(
  "evolution_evidence",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    timestamp: text().notNull(),
    proposal_id: text().notNull(),
    skill_name: text().notNull(),
    skill_path: text(),
    target: text(),
    stage: text(),
    rationale: text(),
    confidence: real(),
    details: text(),
    original_text: text(),
    proposed_text: text(),
    eval_set_json: text(),
    validation_json: text(),
  },
  (table) => [
    uniqueIndex("idx_evo_evidence_dedup").on(table.proposal_id, table.stage, table.timestamp),
    index("idx_evo_evidence_ts").on(table.timestamp),
    index("idx_evo_evidence_skill").on(table.skill_name),
    index("idx_evo_evidence_proposal").on(table.proposal_id),
  ],
);

export const evolution_audit = sqliteTable(
  "evolution_audit",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    timestamp: text().notNull(),
    proposal_id: text().notNull(),
    skill_name: text(),
    action: text().notNull(),
    details: text(),
    eval_snapshot_json: text(),
    iterations_used: integer(),
    validation_mode: text(),
    validation_agent: text(),
    validation_fixture_id: text(),
    validation_evidence_ref: text(),
  },
  (table) => [
    uniqueIndex("idx_evo_audit_dedup").on(table.proposal_id, table.action, table.timestamp),
    index("idx_evo_audit_action").on(table.action),
    index("idx_evo_audit_ts").on(table.timestamp),
    index("idx_evo_audit_proposal").on(table.proposal_id),
  ],
);

export const replay_entry_results = sqliteTable(
  "replay_entry_results",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    proposal_id: text().notNull(),
    skill_name: text().notNull(),
    validation_mode: text().notNull(),
    phase: text().notNull(),
    query: text().notNull(),
    should_trigger: integer().notNull(),
    triggered: integer().notNull(),
    passed: integer().notNull(),
    evidence: text(),
  },
  (table) => [
    index("idx_replay_entry_proposal_phase").on(table.proposal_id, table.phase),
    index("idx_replay_entry_passed").on(table.passed),
    index("idx_replay_entry_skill").on(table.skill_name),
    index("idx_replay_entry_proposal").on(table.proposal_id),
  ],
);

export const session_telemetry = sqliteTable(
  "session_telemetry",
  {
    session_id: text().primaryKey(),
    timestamp: text().notNull(),
    cwd: text(),
    transcript_path: text(),
    tool_calls_json: text(),
    total_tool_calls: integer(),
    bash_commands_json: text(),
    skills_triggered_json: text(),
    skills_invoked_json: text(),
    assistant_turns: integer(),
    errors_encountered: integer(),
    transcript_chars: integer(),
    last_user_query: text(),
    source: text(),
    input_tokens: integer(),
    output_tokens: integer(),
    files_changed: integer(),
    lines_added: integer(),
    lines_removed: integer(),
    lines_modified: integer(),
    cached_input_tokens: integer(),
    reasoning_output_tokens: integer(),
    cost_usd: real(),
    artifact_count: integer(),
    session_type: text(),
    agent_summary: text(),
  },
  (table) => [index("idx_session_tel_ts").on(table.timestamp)],
);

export const skill_usage = sqliteTable(
  "skill_usage",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    timestamp: text().notNull(),
    session_id: text().notNull(),
    skill_name: text().notNull(),
    skill_path: text(),
    skill_scope: text(),
    query: text(),
    triggered: integer(),
    source: text(),
  },
  (table) => [
    uniqueIndex("idx_skill_usage_dedup").on(
      table.session_id,
      table.skill_name,
      table.query,
      table.timestamp,
      table.triggered,
    ),
    index("idx_skill_usage_scope").on(table.skill_name, table.skill_scope, table.timestamp),
    index("idx_skill_usage_query_triggered").on(table.query, table.triggered),
    index("idx_skill_usage_ts").on(table.timestamp),
    index("idx_skill_usage_name").on(table.skill_name),
    index("idx_skill_usage_session").on(table.session_id),
  ],
);

export const orchestrate_runs = sqliteTable(
  "orchestrate_runs",
  {
    run_id: text().primaryKey(),
    timestamp: text().notNull(),
    elapsed_ms: integer().notNull(),
    dry_run: integer().notNull(),
    approval_mode: text().notNull(),
    total_skills: integer().notNull(),
    evaluated: integer().notNull(),
    evolved: integer().notNull(),
    deployed: integer().notNull(),
    watched: integer().notNull(),
    skipped: integer().notNull(),
    skill_actions_json: text().notNull(),
  },
  (table) => [index("idx_orchestrate_runs_ts").on(table.timestamp)],
);

export const queries = sqliteTable(
  "queries",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    timestamp: text().notNull(),
    session_id: text().notNull(),
    query: text().notNull(),
    source: text(),
  },
  (table) => [
    uniqueIndex("idx_queries_dedup").on(table.session_id, table.query, table.timestamp),
    index("idx_queries_ts").on(table.timestamp),
    index("idx_queries_session").on(table.session_id),
  ],
);

export const grading_results = sqliteTable(
  "grading_results",
  {
    grading_id: text().primaryKey(),
    session_id: text().notNull(),
    skill_name: text().notNull(),
    transcript_path: text(),
    graded_at: text().notNull(),
    pass_rate: real(),
    mean_score: real(),
    score_std_dev: real(),
    passed_count: integer(),
    failed_count: integer(),
    total_count: integer(),
    expectations_json: text(),
    claims_json: text(),
    eval_feedback_json: text(),
    failure_feedback_json: text(),
    execution_metrics_json: text(),
  },
  (table) => [
    uniqueIndex("idx_grading_dedup").on(table.session_id, table.skill_name, table.graded_at),
    index("idx_grading_ts").on(table.graded_at),
    index("idx_grading_skill").on(table.skill_name),
    index("idx_grading_session").on(table.session_id),
  ],
);

export const grading_baselines = sqliteTable(
  "grading_baselines",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    skill_name: text().notNull(),
    proposal_id: text(),
    measured_at: text().notNull(),
    pass_rate: real().notNull(),
    mean_score: real(),
    sample_size: integer().notNull(),
    grading_results_json: text(),
  },
  (table) => [
    index("idx_grading_bl_skill_proposal").on(
      table.skill_name,
      table.proposal_id,
      table.measured_at,
    ),
    index("idx_grading_bl_ts").on(table.measured_at),
    index("idx_grading_bl_proposal").on(table.proposal_id),
    index("idx_grading_bl_skill").on(table.skill_name),
  ],
);

export const canonical_eval_sets = sqliteTable(
  "canonical_eval_sets",
  {
    skill_name: text().primaryKey(),
    stored_at: text().notNull(),
    eval_set_json: text().notNull(),
  },
  (table) => [index("idx_canonical_eval_sets_stored_at").on(table.stored_at)],
);

export const unit_test_files = sqliteTable(
  "unit_test_files",
  {
    skill_name: text().primaryKey(),
    stored_at: text().notNull(),
    tests_json: text().notNull(),
  },
  (table) => [index("idx_unit_test_files_stored_at").on(table.stored_at)],
);

export const unit_test_run_results = sqliteTable(
  "unit_test_run_results",
  {
    skill_name: text().primaryKey(),
    run_at: text().notNull(),
    total: integer().notNull(),
    passed: integer().notNull(),
    failed: integer().notNull(),
    pass_rate: real().notNull(),
    result_json: text().notNull(),
  },
  (table) => [index("idx_unit_test_run_results_run_at").on(table.run_at)],
);

export const package_evaluation_reports = sqliteTable(
  "package_evaluation_reports",
  {
    skill_name: text().primaryKey(),
    stored_at: text().notNull(),
    summary_json: text().notNull(),
  },
  (table) => [index("idx_package_evaluation_reports_stored_at").on(table.stored_at)],
);

export const package_candidates = sqliteTable(
  "package_candidates",
  {
    candidate_id: text().primaryKey(),
    skill_name: text().notNull(),
    skill_path: text().notNull(),
    package_fingerprint: text().notNull(),
    parent_candidate_id: text(),
    candidate_generation: integer().default(0).notNull(),
    evaluation_count: integer().default(0).notNull(),
    first_evaluated_at: text().notNull(),
    last_evaluated_at: text().notNull(),
    latest_status: text().notNull(),
    latest_evaluation_source: text(),
    latest_acceptance_decision: text(),
    artifact_path: text(),
    summary_json: text().notNull(),
  },
  (table) => [
    uniqueIndex("package_candidates_skill_fingerprint_unique").on(
      table.skill_name,
      table.package_fingerprint,
    ),
    index("idx_package_candidates_parent").on(table.parent_candidate_id),
    index("idx_package_candidates_skill_ts").on(table.skill_name, table.last_evaluated_at),
  ],
);

export const improvement_signals = sqliteTable(
  "improvement_signals",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    timestamp: text().notNull(),
    session_id: text().notNull(),
    query: text().notNull(),
    signal_type: text().notNull(),
    mentioned_skill: text(),
    consumed: integer().default(0).notNull(),
    consumed_at: text(),
    consumed_by_run: text(),
  },
  (table) => [
    uniqueIndex("idx_signals_dedup").on(
      table.session_id,
      table.query,
      table.signal_type,
      table.timestamp,
    ),
    index("idx_signals_ts").on(table.timestamp),
    index("idx_signals_consumed").on(table.consumed),
    index("idx_signals_session").on(table.session_id),
  ],
);

export const upload_queue = sqliteTable(
  "upload_queue",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    payload_type: text().notNull(),
    payload_json: text().notNull(),
    status: text().default("pending").notNull(),
    attempts: integer().default(0).notNull(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
    last_error: text(),
    staging_max_seq: integer(),
    next_attempt_at: text(),
  },
  (table) => [
    index("idx_upload_queue_type_status").on(table.payload_type, table.status),
    index("idx_upload_queue_status").on(table.status),
    index("idx_upload_queue_retry").on(table.status, table.next_attempt_at),
  ],
);

export const creator_contribution_staging = sqliteTable(
  "creator_contribution_staging",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    dedupe_key: text().notNull(),
    skill_name: text().notNull(),
    creator_id: text().notNull(),
    payload_json: text().notNull(),
    status: text().default("pending").notNull(),
    staged_at: text().notNull(),
    updated_at: text().notNull(),
    last_error: text(),
  },
  (table) => [
    uniqueIndex("idx_creator_contrib_dedup").on(table.dedupe_key),
    index("idx_creator_contrib_skill").on(table.skill_name),
    index("idx_creator_contrib_status").on(table.status),
  ],
);

export const upload_watermarks = sqliteTable("upload_watermarks", {
  payload_type: text().primaryKey(),
  last_uploaded_id: integer().notNull(),
  updated_at: text().notNull(),
});

export const canonical_upload_staging = sqliteTable(
  "canonical_upload_staging",
  {
    local_seq: integer().primaryKey({ autoIncrement: true }),
    record_kind: text().notNull(),
    record_id: text().notNull(),
    record_json: text().notNull(),
    session_id: text(),
    prompt_id: text(),
    normalized_at: text(),
    staged_at: text().notNull(),
    content_sha256: text(),
  },
  (table) => [
    index("idx_staging_sha256").on(table.content_sha256),
    uniqueIndex("idx_staging_dedup").on(table.record_kind, table.record_id),
    index("idx_staging_session").on(table.session_id),
    index("idx_staging_kind").on(table.record_kind),
  ],
);

export const commit_tracking = sqliteTable(
  "commit_tracking",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    session_id: text().notNull(),
    commit_sha: text().notNull(),
    commit_title: text(),
    branch: text(),
    repo_remote: text(),
    timestamp: text().notNull(),
    created_at: text()
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_commit_dedup").on(table.session_id, table.commit_sha),
    index("idx_commit_ts").on(table.timestamp),
    index("idx_commit_session").on(table.session_id),
    index("idx_commit_sha").on(table.commit_sha),
  ],
);

export const cron_runs = sqliteTable(
  "cron_runs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    job_name: text().notNull(),
    started_at: text().notNull(),
    elapsed_ms: integer().notNull(),
    status: text().notNull(),
    metrics_json: text(),
    error: text(),
  },
  (table) => [
    uniqueIndex("cron_runs_job_started_unique").on(table.job_name, table.started_at),
    index("idx_cron_runs_job_ts").on(table.job_name, table.started_at),
  ],
);

export const package_search_runs = sqliteTable(
  "package_search_runs",
  {
    search_id: text().primaryKey(),
    skill_name: text().notNull(),
    parent_candidate_id: text(),
    winner_candidate_id: text(),
    winner_rationale: text(),
    candidates_evaluated: integer().notNull(),
    provenance_json: text().notNull(),
    started_at: text().notNull(),
    completed_at: text().notNull(),
  },
  (table) => [
    index("idx_pkg_search_ts").on(table.started_at),
    index("idx_pkg_search_skill").on(table.skill_name),
  ],
);

export const skill_classification_overrides = sqliteTable(
  "skill_classification_overrides",
  {
    skill_id: text().primaryKey(),
    skill_name: text().notNull(),
    category: text().notNull(),
    inferred_category: text().notNull(),
    reason: text(),
    algorithm_version: text().notNull(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [index("idx_skill_classification_overrides_updated").on(table.updated_at)],
);

export const skill_classification_corrections = sqliteTable(
  "skill_classification_corrections",
  {
    correction_id: text().primaryKey(),
    skill_id: text().notNull(),
    skill_name: text().notNull(),
    category: text(),
    inferred_category: text().notNull(),
    reason: text(),
    algorithm_version: text().notNull(),
    corrected_at: text().notNull(),
  },
  (table) => [
    index("idx_skill_classification_corrections_algorithm").on(
      table.algorithm_version,
      table.corrected_at,
    ),
    index("idx_skill_classification_corrections_skill").on(table.skill_id, table.corrected_at),
  ],
);

export const skill_set_suggestion_snapshots = sqliteTable(
  "skill_set_suggestion_snapshots",
  {
    snapshot_id: text().primaryKey(),
    suggestion_id: text().notNull(),
    evidence_fingerprint: text().notNull(),
    pattern: text().notNull(),
    algorithm_version: text().notNull(),
    evidence_version: integer().notNull(),
    suggestion_json: text().notNull(),
    generated_at: text().notNull(),
    first_seen_at: text().notNull(),
    last_seen_at: text().notNull(),
  },
  (table) => [
    uniqueIndex("skill_set_suggestion_snapshot_evidence_unique").on(
      table.suggestion_id,
      table.evidence_fingerprint,
    ),
    index("idx_skill_set_suggestion_snapshots_last_seen").on(table.last_seen_at),
    index("idx_skill_set_suggestion_snapshots_suggestion").on(table.suggestion_id),
  ],
);

export const skill_set_suggestion_reviews = sqliteTable(
  "skill_set_suggestion_reviews",
  {
    review_id: text().primaryKey(),
    snapshot_id: text()
      .notNull()
      .references(() => skill_set_suggestion_snapshots.snapshot_id),
    suggestion_id: text().notNull(),
    evidence_fingerprint: text().notNull(),
    decision: text().notNull(),
    reason_code: text().notNull(),
    reason: text(),
    resulting_set_id: text(),
    resulting_set_revision_hash: text(),
    result_json: text(),
    edit_distance: real(),
    algorithm_version: text().notNull(),
    reviewed_at: text().notNull(),
  },
  (table) => [
    uniqueIndex("skill_set_suggestion_review_decision_unique").on(
      table.snapshot_id,
      table.decision,
    ),
    index("idx_skill_set_suggestion_reviews_reviewed").on(table.reviewed_at),
    index("idx_skill_set_suggestion_reviews_suggestion").on(table.suggestion_id),
    index("idx_skill_set_suggestion_reviews_snapshot").on(table.snapshot_id),
  ],
);

export const skill_set_outcomes = sqliteTable(
  "skill_set_outcomes",
  {
    outcome_id: text().primaryKey(),
    review_id: text()
      .notNull()
      .references(() => skill_set_suggestion_reviews.review_id),
    receipt_id: text().notNull(),
    set_id: text().notNull(),
    algorithm_version: text().notNull(),
    project_root: text().notNull(),
    activated_at: text().notNull(),
    measured_at: text().notNull(),
    status: text().notNull(),
    reason: text().notNull(),
    minimum_sessions: integer().notNull(),
    before_session_count: integer().notNull(),
    after_session_count: integer().notNull(),
    metrics_json: text().notNull(),
  },
  (table) => [
    uniqueIndex("skill_set_outcomes_review_receipt_unique").on(table.review_id, table.receipt_id),
    index("idx_skill_set_outcomes_algorithm").on(table.algorithm_version, table.measured_at),
    index("idx_skill_set_outcomes_set").on(table.set_id, table.activated_at),
    index("idx_skill_set_outcomes_status").on(table.status, table.measured_at),
  ],
);

/**
 * Durable local installer authority. Receipt metadata is deliberately stored
 * as columns rather than an opaque document so incompatible state fails at the
 * schema seam and active ownership can be protected by SQLite constraints.
 */
export const skill_install_receipts = sqliteTable(
  "skill_install_receipts",
  {
    receipt_id: text().primaryKey(),
    state: text().notNull(),
    subject_kind: text().notNull(),
    skill_set_id: text(),
    skill_set_version: text(),
    skill_set_package_sha256: text(),
    skill_name: text().notNull(),
    logical_skill_id: text().notNull(),
    logical_version: text().notNull(),
    distribution_id: text().notNull(),
    share_id: text().notNull(),
    handoff_id: text().notNull(),
    sealed_package_sha256: text().notNull(),
    sealed_object_id: text(),
    signature_algorithm: text().notNull(),
    signature_key_id: text().notNull(),
    signature_value: text().notNull(),
    license_spdx_expression: text().notNull(),
    license_file_json: text().notNull(),
    license_notices_json: text().notNull(),
    agent: text().notNull(),
    platform: text().notNull(),
    scope: text().notNull(),
    project_root: text(),
    registry_root: text().notNull(),
    target_path: text().notNull(),
    target_path_key: text().notNull(),
    strategy: text().notNull(),
    conflict_decision: text().notNull(),
    backup_path: text(),
    consent_id: text().notNull(),
    recipient_principal_id: text().notNull(),
    consent_recorded_at: text().notNull(),
    consent_action: text().notNull(),
    disclosure_sha256: text().notNull(),
    contributor_signals: text().notNull(),
    contributor_signal_owner_id: text(),
    contributor_signal_fields_json: text().notNull(),
    lifecycle_reporting: text().notNull(),
    lifecycle_fields_json: text().notNull(),
    source_kind: text().notNull(),
    source_identity: text().notNull(),
    preview_fingerprint: text().notNull(),
    operation_id: text().notNull(),
    previous_receipt_id: text(),
    superseded_by_receipt_id: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
    removed_at: text(),
  },
  (table) => [
    index("idx_skill_install_receipts_target").on(table.target_path, table.state),
    index("idx_skill_install_receipts_distribution").on(
      table.distribution_id,
      table.share_id,
      table.handoff_id,
    ),
    index("idx_skill_install_receipts_lineage").on(table.previous_receipt_id),
    uniqueIndex("skill_install_receipts_operation_target_unique").on(
      table.operation_id,
      table.target_path,
    ),
    uniqueIndex("skill_install_receipts_active_target_unique")
      .on(table.target_path_key)
      .where(sql`${table.state} = 'active'`),
  ],
);

export const skill_install_receipt_files = sqliteTable(
  "skill_install_receipt_files",
  {
    receipt_id: text()
      .notNull()
      .references(() => skill_install_receipts.receipt_id, { onDelete: "cascade" }),
    relative_path: text().notNull(),
    sha256: text().notNull(),
    byte_length: integer().notNull(),
    durable_snapshot_ref: text().notNull(),
  },
  (table) => [
    uniqueIndex("skill_install_receipt_files_identity_unique").on(
      table.receipt_id,
      table.relative_path,
    ),
    index("idx_skill_install_receipt_files_receipt").on(table.receipt_id),
  ],
);

export const skill_install_operations = sqliteTable(
  "skill_install_operations",
  {
    operation_id: text().primaryKey(),
    kind: text().notNull(),
    state: text().notNull(),
    preview_fingerprint: text().notNull(),
    fence_id: text().notNull(),
    fence_generation: integer().notNull(),
    request_json: text().notNull(),
    request_sha256: text().notNull(),
    error_code: text(),
    recovery_token: text(),
    recovery_generation: integer().notNull().default(0),
    recovery_started_at: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
    completed_at: text(),
  },
  (table) => [
    index("idx_skill_install_operations_state").on(table.state, table.created_at),
    index("idx_skill_install_operations_preview").on(table.preview_fingerprint, table.kind),
  ],
);

export const skill_install_operation_steps = sqliteTable(
  "skill_install_operation_steps",
  {
    operation_id: text()
      .notNull()
      .references(() => skill_install_operations.operation_id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    receipt_id: text(),
    kind: text().notNull(),
    state: text().notNull(),
    target_path: text().notNull(),
    staging_path: text(),
    rollback_path: text(),
    snapshot_path: text(),
    expected_sha256: text(),
    retain_rollback_after_commit: integer({ mode: "boolean" }).notNull(),
    restore_backup_path: text(),
    strategy: text().notNull(),
    source_path: text(),
    operations_json: text().notNull(),
    expected_before_json: text().notNull(),
    error_code: text(),
    started_at: text(),
    completed_at: text(),
  },
  (table) => [
    uniqueIndex("skill_install_operation_steps_identity_unique").on(
      table.operation_id,
      table.sequence,
    ),
    index("idx_skill_install_operation_steps_state").on(table.operation_id, table.state),
  ],
);

export const skill_install_commit_locks = sqliteTable("skill_install_commit_locks", {
  lock_name: text().primaryKey(),
  owner_token: text(),
  generation: integer().notNull(),
  lease_expires_at: integer().notNull(),
  updated_at: text().notNull(),
});

/**
 * Operational replay checkpoints for analytical imports. The analytical
 * corpus itself belongs to DuckDB; SQLite only records which durable source
 * revision was successfully acknowledged by that separate store.
 */
export const analytical_import_checkpoints = sqliteTable(
  "analytical_import_checkpoints",
  {
    source_kind: text().notNull(),
    source_identity: text().notNull(),
    source_fingerprint: text().notNull(),
    normalizer_version: text().notNull(),
    imported_at: text().notNull(),
  },
  (table) => [
    uniqueIndex("analytical_import_checkpoints_source_unique").on(
      table.source_kind,
      table.source_identity,
    ),
    index("idx_analytical_import_checkpoints_imported").on(table.imported_at),
  ],
);

/**
 * Operational hand-off state for a locally prepared Cloud evaluation.
 *
 * The payload is deliberately opaque here: it is a bounded, redacted JSON
 * envelope whose domain contract is decoded by the runtime immediately before
 * submission. Trace facts and source paths stay in their respective durable
 * source and DuckDB domains.
 */
export const evaluation_submission_drafts = sqliteTable(
  "evaluation_submission_drafts",
  {
    draft_id: text().primaryKey(),
    pattern_id: text().notNull(),
    cohort_fingerprint: text().notNull(),
    skill_name: text().notNull(),
    skill_revision: text().notNull(),
    payload_json: text().notNull(),
    lifecycle: text().notNull(),
    cloud_run_id: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    index("idx_evaluation_submission_drafts_cohort").on(
      table.pattern_id,
      table.cohort_fingerprint,
      table.skill_revision,
    ),
    index("idx_evaluation_submission_drafts_status").on(table.lifecycle, table.updated_at),
    index("idx_evaluation_submission_drafts_skill").on(
      table.skill_name,
      table.skill_revision,
      table.updated_at,
    ),
  ],
);

export const _meta = sqliteTable("_meta", {
  key: text().primaryKey(),
  value: text(),
});
