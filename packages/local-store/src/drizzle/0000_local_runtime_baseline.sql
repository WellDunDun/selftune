CREATE TABLE `_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `canonical_eval_sets` (
	`skill_name` text PRIMARY KEY NOT NULL,
	`stored_at` text NOT NULL,
	`eval_set_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_canonical_eval_sets_stored_at` ON `canonical_eval_sets` (`stored_at`);--> statement-breakpoint
CREATE TABLE `canonical_upload_staging` (
	`local_seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`record_kind` text NOT NULL,
	`record_id` text NOT NULL,
	`record_json` text NOT NULL,
	`session_id` text,
	`prompt_id` text,
	`normalized_at` text,
	`staged_at` text NOT NULL,
	`content_sha256` text
);
--> statement-breakpoint
CREATE INDEX `idx_staging_sha256` ON `canonical_upload_staging` (`content_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_staging_dedup` ON `canonical_upload_staging` (`record_kind`,`record_id`);--> statement-breakpoint
CREATE INDEX `idx_staging_session` ON `canonical_upload_staging` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_staging_kind` ON `canonical_upload_staging` (`record_kind`);--> statement-breakpoint
CREATE TABLE `commit_tracking` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`commit_title` text,
	`branch` text,
	`repo_remote` text,
	`timestamp` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_commit_dedup` ON `commit_tracking` (`session_id`,`commit_sha`);--> statement-breakpoint
CREATE INDEX `idx_commit_ts` ON `commit_tracking` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_commit_session` ON `commit_tracking` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_commit_sha` ON `commit_tracking` (`commit_sha`);--> statement-breakpoint
CREATE TABLE `creator_contribution_staging` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dedupe_key` text NOT NULL,
	`skill_name` text NOT NULL,
	`creator_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`staged_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_creator_contrib_dedup` ON `creator_contribution_staging` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_creator_contrib_skill` ON `creator_contribution_staging` (`skill_name`);--> statement-breakpoint
CREATE INDEX `idx_creator_contrib_status` ON `creator_contribution_staging` (`status`);--> statement-breakpoint
CREATE TABLE `cron_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_name` text NOT NULL,
	`started_at` text NOT NULL,
	`elapsed_ms` integer NOT NULL,
	`status` text NOT NULL,
	`metrics_json` text,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cron_runs_job_started_unique` ON `cron_runs` (`job_name`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_cron_runs_job_ts` ON `cron_runs` (`job_name`,`started_at`);--> statement-breakpoint
CREATE TABLE `evolution_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`proposal_id` text NOT NULL,
	`skill_name` text,
	`action` text NOT NULL,
	`details` text,
	`eval_snapshot_json` text,
	`iterations_used` integer,
	`validation_mode` text,
	`validation_agent` text,
	`validation_fixture_id` text,
	`validation_evidence_ref` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evo_audit_dedup` ON `evolution_audit` (`proposal_id`,`action`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_evo_audit_action` ON `evolution_audit` (`action`);--> statement-breakpoint
CREATE INDEX `idx_evo_audit_ts` ON `evolution_audit` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_evo_audit_proposal` ON `evolution_audit` (`proposal_id`);--> statement-breakpoint
CREATE TABLE `evolution_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`proposal_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`skill_path` text,
	`target` text,
	`stage` text,
	`rationale` text,
	`confidence` real,
	`details` text,
	`original_text` text,
	`proposed_text` text,
	`eval_set_json` text,
	`validation_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evo_evidence_dedup` ON `evolution_evidence` (`proposal_id`,`stage`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_evo_evidence_ts` ON `evolution_evidence` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_evo_evidence_skill` ON `evolution_evidence` (`skill_name`);--> statement-breakpoint
CREATE INDEX `idx_evo_evidence_proposal` ON `evolution_evidence` (`proposal_id`);--> statement-breakpoint
CREATE TABLE `execution_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`occurred_at` text,
	`prompt_id` text,
	`tool_calls_json` text,
	`total_tool_calls` integer,
	`assistant_turns` integer,
	`errors_encountered` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`duration_ms` integer,
	`completion_status` text,
	`schema_version` text,
	`platform` text,
	`normalized_at` text,
	`normalizer_version` text,
	`capture_mode` text,
	`raw_source_ref` text,
	`files_changed` integer,
	`lines_added` integer,
	`lines_removed` integer,
	`lines_modified` integer,
	`cached_input_tokens` integer,
	`reasoning_output_tokens` integer,
	`cost_usd` real,
	`artifact_count` integer,
	`session_type` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_exec_facts_session` ON `execution_facts` (`session_id`);--> statement-breakpoint
CREATE TABLE `grading_baselines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`skill_name` text NOT NULL,
	`proposal_id` text,
	`measured_at` text NOT NULL,
	`pass_rate` real NOT NULL,
	`mean_score` real,
	`sample_size` integer NOT NULL,
	`grading_results_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_grading_bl_skill_proposal` ON `grading_baselines` (`skill_name`,`proposal_id`,`measured_at`);--> statement-breakpoint
CREATE INDEX `idx_grading_bl_ts` ON `grading_baselines` (`measured_at`);--> statement-breakpoint
CREATE INDEX `idx_grading_bl_proposal` ON `grading_baselines` (`proposal_id`);--> statement-breakpoint
CREATE INDEX `idx_grading_bl_skill` ON `grading_baselines` (`skill_name`);--> statement-breakpoint
CREATE TABLE `grading_results` (
	`grading_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`transcript_path` text,
	`graded_at` text NOT NULL,
	`pass_rate` real,
	`mean_score` real,
	`score_std_dev` real,
	`passed_count` integer,
	`failed_count` integer,
	`total_count` integer,
	`expectations_json` text,
	`claims_json` text,
	`eval_feedback_json` text,
	`failure_feedback_json` text,
	`execution_metrics_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_grading_dedup` ON `grading_results` (`session_id`,`skill_name`,`graded_at`);--> statement-breakpoint
CREATE INDEX `idx_grading_ts` ON `grading_results` (`graded_at`);--> statement-breakpoint
CREATE INDEX `idx_grading_skill` ON `grading_results` (`skill_name`);--> statement-breakpoint
CREATE INDEX `idx_grading_session` ON `grading_results` (`session_id`);--> statement-breakpoint
CREATE TABLE `improvement_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`session_id` text NOT NULL,
	`query` text NOT NULL,
	`signal_type` text NOT NULL,
	`mentioned_skill` text,
	`consumed` integer DEFAULT 0 NOT NULL,
	`consumed_at` text,
	`consumed_by_run` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_signals_dedup` ON `improvement_signals` (`session_id`,`query`,`signal_type`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_signals_ts` ON `improvement_signals` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_signals_consumed` ON `improvement_signals` (`consumed`);--> statement-breakpoint
CREATE INDEX `idx_signals_session` ON `improvement_signals` (`session_id`);--> statement-breakpoint
CREATE TABLE `orchestrate_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`elapsed_ms` integer NOT NULL,
	`dry_run` integer NOT NULL,
	`approval_mode` text NOT NULL,
	`total_skills` integer NOT NULL,
	`evaluated` integer NOT NULL,
	`evolved` integer NOT NULL,
	`deployed` integer NOT NULL,
	`watched` integer NOT NULL,
	`skipped` integer NOT NULL,
	`skill_actions_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_orchestrate_runs_ts` ON `orchestrate_runs` (`timestamp`);--> statement-breakpoint
CREATE TABLE `package_candidates` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`skill_name` text NOT NULL,
	`skill_path` text NOT NULL,
	`package_fingerprint` text NOT NULL,
	`parent_candidate_id` text,
	`candidate_generation` integer DEFAULT 0 NOT NULL,
	`evaluation_count` integer DEFAULT 0 NOT NULL,
	`first_evaluated_at` text NOT NULL,
	`last_evaluated_at` text NOT NULL,
	`latest_status` text NOT NULL,
	`latest_evaluation_source` text,
	`latest_acceptance_decision` text,
	`artifact_path` text,
	`summary_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_candidates_skill_fingerprint_unique` ON `package_candidates` (`skill_name`,`package_fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_package_candidates_parent` ON `package_candidates` (`parent_candidate_id`);--> statement-breakpoint
CREATE INDEX `idx_package_candidates_skill_ts` ON `package_candidates` (`skill_name`,`last_evaluated_at`);--> statement-breakpoint
CREATE TABLE `package_evaluation_reports` (
	`skill_name` text PRIMARY KEY NOT NULL,
	`stored_at` text NOT NULL,
	`summary_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_package_evaluation_reports_stored_at` ON `package_evaluation_reports` (`stored_at`);--> statement-breakpoint
CREATE TABLE `package_search_runs` (
	`search_id` text PRIMARY KEY NOT NULL,
	`skill_name` text NOT NULL,
	`parent_candidate_id` text,
	`winner_candidate_id` text,
	`winner_rationale` text,
	`candidates_evaluated` integer NOT NULL,
	`provenance_json` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pkg_search_ts` ON `package_search_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_pkg_search_skill` ON `package_search_runs` (`skill_name`);--> statement-breakpoint
CREATE TABLE `prompts` (
	`prompt_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`occurred_at` text,
	`prompt_kind` text,
	`is_actionable` integer,
	`prompt_index` integer,
	`prompt_text` text,
	`schema_version` text,
	`platform` text,
	`normalized_at` text,
	`normalizer_version` text,
	`capture_mode` text,
	`raw_source_ref` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_prompts_occurred` ON `prompts` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_prompts_session` ON `prompts` (`session_id`);--> statement-breakpoint
CREATE TABLE `queries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`session_id` text NOT NULL,
	`query` text NOT NULL,
	`source` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_queries_dedup` ON `queries` (`session_id`,`query`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_queries_ts` ON `queries` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_queries_session` ON `queries` (`session_id`);--> statement-breakpoint
CREATE TABLE `replay_entry_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposal_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`validation_mode` text NOT NULL,
	`phase` text NOT NULL,
	`query` text NOT NULL,
	`should_trigger` integer NOT NULL,
	`triggered` integer NOT NULL,
	`passed` integer NOT NULL,
	`evidence` text
);
--> statement-breakpoint
CREATE INDEX `idx_replay_entry_proposal_phase` ON `replay_entry_results` (`proposal_id`,`phase`);--> statement-breakpoint
CREATE INDEX `idx_replay_entry_passed` ON `replay_entry_results` (`passed`);--> statement-breakpoint
CREATE INDEX `idx_replay_entry_skill` ON `replay_entry_results` (`skill_name`);--> statement-breakpoint
CREATE INDEX `idx_replay_entry_proposal` ON `replay_entry_results` (`proposal_id`);--> statement-breakpoint
CREATE TABLE `session_telemetry` (
	`session_id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`cwd` text,
	`transcript_path` text,
	`tool_calls_json` text,
	`total_tool_calls` integer,
	`bash_commands_json` text,
	`skills_triggered_json` text,
	`skills_invoked_json` text,
	`assistant_turns` integer,
	`errors_encountered` integer,
	`transcript_chars` integer,
	`last_user_query` text,
	`source` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`files_changed` integer,
	`lines_added` integer,
	`lines_removed` integer,
	`lines_modified` integer,
	`cached_input_tokens` integer,
	`reasoning_output_tokens` integer,
	`cost_usd` real,
	`artifact_count` integer,
	`session_type` text,
	`agent_summary` text
);
--> statement-breakpoint
CREATE INDEX `idx_session_tel_ts` ON `session_telemetry` (`timestamp`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`started_at` text,
	`ended_at` text,
	`platform` text,
	`model` text,
	`completion_status` text,
	`source_session_kind` text,
	`agent_cli` text,
	`workspace_path` text,
	`repo_remote` text,
	`branch` text,
	`schema_version` text,
	`normalized_at` text,
	`normalizer_version` text,
	`capture_mode` text,
	`raw_source_ref` text
);
--> statement-breakpoint
CREATE TABLE `skill_invocations` (
	`skill_invocation_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`occurred_at` text,
	`skill_name` text NOT NULL,
	`invocation_mode` text,
	`triggered` integer,
	`confidence` real,
	`tool_name` text,
	`matched_prompt_id` text,
	`agent_type` text,
	`query` text,
	`skill_path` text,
	`skill_version_hash` text,
	`skill_scope` text,
	`source` text,
	`schema_version` text,
	`platform` text,
	`normalized_at` text,
	`normalizer_version` text,
	`capture_mode` text,
	`raw_source_ref` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_skill_inv_dedup` ON `skill_invocations` (`session_id`,`skill_name`,`query`,`occurred_at`,`triggered`);--> statement-breakpoint
CREATE INDEX `idx_skill_inv_version` ON `skill_invocations` (`skill_name`,`skill_version_hash`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_inv_scope` ON `skill_invocations` (`skill_name`,`skill_scope`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_inv_query_triggered` ON `skill_invocations` (`query`,`triggered`);--> statement-breakpoint
CREATE INDEX `idx_skill_inv_ts` ON `skill_invocations` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_inv_name` ON `skill_invocations` (`skill_name`);--> statement-breakpoint
CREATE INDEX `idx_skill_inv_session` ON `skill_invocations` (`session_id`);--> statement-breakpoint
CREATE TABLE `skill_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`session_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`skill_path` text,
	`skill_scope` text,
	`query` text,
	`triggered` integer,
	`source` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_skill_usage_dedup` ON `skill_usage` (`session_id`,`skill_name`,`query`,`timestamp`,`triggered`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_scope` ON `skill_usage` (`skill_name`,`skill_scope`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_query_triggered` ON `skill_usage` (`query`,`triggered`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_ts` ON `skill_usage` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_name` ON `skill_usage` (`skill_name`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_session` ON `skill_usage` (`session_id`);--> statement-breakpoint
CREATE TABLE `unit_test_files` (
	`skill_name` text PRIMARY KEY NOT NULL,
	`stored_at` text NOT NULL,
	`tests_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_unit_test_files_stored_at` ON `unit_test_files` (`stored_at`);--> statement-breakpoint
CREATE TABLE `unit_test_run_results` (
	`skill_name` text PRIMARY KEY NOT NULL,
	`run_at` text NOT NULL,
	`total` integer NOT NULL,
	`passed` integer NOT NULL,
	`failed` integer NOT NULL,
	`pass_rate` real NOT NULL,
	`result_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_unit_test_run_results_run_at` ON `unit_test_run_results` (`run_at`);--> statement-breakpoint
CREATE TABLE `upload_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payload_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `idx_upload_queue_type_status` ON `upload_queue` (`payload_type`,`status`);--> statement-breakpoint
CREATE INDEX `idx_upload_queue_status` ON `upload_queue` (`status`);--> statement-breakpoint
CREATE TABLE `upload_watermarks` (
	`payload_type` text PRIMARY KEY NOT NULL,
	`last_uploaded_id` integer NOT NULL,
	`updated_at` text NOT NULL
);
