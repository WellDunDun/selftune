CREATE TABLE `correction_learning_policies` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`capture_enabled` text NOT NULL,
	`proactive_generation_enabled` text NOT NULL,
	`managed_execution_enabled` text NOT NULL,
	`kill_switch_enabled` text NOT NULL,
	`workspace_budget` text NOT NULL,
	`max_concurrency` text NOT NULL,
	`retention_e0_days` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `correction_raw_source_material` (
	`source_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`evidence_level` text NOT NULL,
	`payload_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `correction_signal_candidates`(`candidate_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_correction_raw_source_material_expiry` ON `correction_raw_source_material` (`evidence_level`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_correction_raw_source_material_candidate` ON `correction_raw_source_material` (`candidate_id`);--> statement-breakpoint
CREATE TABLE `correction_review_decisions` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`replacement_candidate_id` text,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `correction_signal_candidates`(`candidate_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`replacement_candidate_id`) REFERENCES `correction_signal_candidates`(`candidate_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_correction_review_decisions_candidate` ON `correction_review_decisions` (`candidate_id`,`decided_at`);--> statement-breakpoint
CREATE INDEX `idx_correction_review_decisions_replacement` ON `correction_review_decisions` (`replacement_candidate_id`);
