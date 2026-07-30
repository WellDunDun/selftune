CREATE TABLE `skill_install_commit_locks` (
	`lock_name` text PRIMARY KEY NOT NULL,
	`owner_token` text,
	`generation` integer NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill_install_operation_steps` (
	`operation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`receipt_id` text,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`target_path` text NOT NULL,
	`staging_path` text,
	`rollback_path` text,
	`snapshot_path` text,
	`expected_sha256` text,
	`retain_rollback_after_commit` integer NOT NULL,
	`restore_backup_path` text,
	`strategy` text NOT NULL,
	`source_path` text,
	`operations_json` text NOT NULL,
	`expected_before_json` text NOT NULL,
	`error_code` text,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`operation_id`) REFERENCES `skill_install_operations`(`operation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_install_operation_steps_identity_unique` ON `skill_install_operation_steps` (`operation_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_skill_install_operation_steps_state` ON `skill_install_operation_steps` (`operation_id`,`state`);--> statement-breakpoint
CREATE TABLE `skill_install_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`preview_fingerprint` text NOT NULL,
	`fence_id` text NOT NULL,
	`fence_generation` integer NOT NULL,
	`request_json` text NOT NULL,
	`request_sha256` text NOT NULL,
	`error_code` text,
	`recovery_token` text,
	`recovery_generation` integer DEFAULT 0 NOT NULL,
	`recovery_started_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_skill_install_operations_state` ON `skill_install_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_install_operations_preview` ON `skill_install_operations` (`preview_fingerprint`,`kind`);--> statement-breakpoint
CREATE TABLE `skill_install_receipt_files` (
	`receipt_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_length` integer NOT NULL,
	`durable_snapshot_ref` text NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `skill_install_receipts`(`receipt_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_install_receipt_files_identity_unique` ON `skill_install_receipt_files` (`receipt_id`,`relative_path`);--> statement-breakpoint
CREATE INDEX `idx_skill_install_receipt_files_receipt` ON `skill_install_receipt_files` (`receipt_id`);--> statement-breakpoint
CREATE TABLE `skill_install_receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`subject_kind` text NOT NULL,
	`skill_set_id` text,
	`skill_set_version` text,
	`skill_set_package_sha256` text,
	`skill_name` text NOT NULL,
	`logical_skill_id` text NOT NULL,
	`logical_version` text NOT NULL,
	`distribution_id` text NOT NULL,
	`share_id` text NOT NULL,
	`handoff_id` text NOT NULL,
	`sealed_package_sha256` text NOT NULL,
	`sealed_object_id` text,
	`signature_algorithm` text NOT NULL,
	`signature_key_id` text NOT NULL,
	`signature_value` text NOT NULL,
	`license_spdx_expression` text NOT NULL,
	`license_file_json` text NOT NULL,
	`license_notices_json` text NOT NULL,
	`agent` text NOT NULL,
	`platform` text NOT NULL,
	`scope` text NOT NULL,
	`project_root` text,
	`registry_root` text NOT NULL,
	`target_path` text NOT NULL,
	`target_path_key` text NOT NULL,
	`strategy` text NOT NULL,
	`conflict_decision` text NOT NULL,
	`backup_path` text,
	`consent_id` text NOT NULL,
	`recipient_principal_id` text NOT NULL,
	`consent_recorded_at` text NOT NULL,
	`consent_action` text NOT NULL,
	`disclosure_sha256` text NOT NULL,
	`contributor_signals` text NOT NULL,
	`contributor_signal_owner_id` text,
	`contributor_signal_fields_json` text NOT NULL,
	`lifecycle_reporting` text NOT NULL,
	`lifecycle_fields_json` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_identity` text NOT NULL,
	`preview_fingerprint` text NOT NULL,
	`operation_id` text NOT NULL,
	`previous_receipt_id` text,
	`superseded_by_receipt_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`removed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_skill_install_receipts_target` ON `skill_install_receipts` (`target_path`,`state`);--> statement-breakpoint
CREATE INDEX `idx_skill_install_receipts_distribution` ON `skill_install_receipts` (`distribution_id`,`share_id`,`handoff_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_install_receipts_lineage` ON `skill_install_receipts` (`previous_receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `skill_install_receipts_operation_target_unique` ON `skill_install_receipts` (`operation_id`,`target_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `skill_install_receipts_active_target_unique` ON `skill_install_receipts` (`target_path_key`) WHERE "skill_install_receipts"."state" = 'active';