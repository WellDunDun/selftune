CREATE TABLE `correction_signal_candidates` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`skill_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`source_session_id` text NOT NULL,
	`evidence_level` text NOT NULL,
	`lifecycle` text NOT NULL,
	`reason` text,
	`manifest_digest` text NOT NULL,
	`signal_payload_digest` text NOT NULL,
	`signal_payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correction_signal_candidates_idempotency_unique` ON `correction_signal_candidates` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_correction_signal_candidates_skill` ON `correction_signal_candidates` (`skill_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_correction_signal_candidates_lifecycle` ON `correction_signal_candidates` (`lifecycle`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_correction_signal_candidates_session` ON `correction_signal_candidates` (`source_session_id`);--> statement-breakpoint
CREATE TABLE `correction_study_drafts` (
	`draft_id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`candidate_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`source_revision` text,
	`evidence_level` text NOT NULL,
	`lifecycle` text NOT NULL,
	`reason` text,
	`manifest_digest` text NOT NULL,
	`study_payload_digest` text NOT NULL,
	`study_payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `correction_signal_candidates`(`candidate_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correction_study_drafts_idempotency_unique` ON `correction_study_drafts` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `correction_study_drafts_candidate_unique` ON `correction_study_drafts` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `idx_correction_study_drafts_skill` ON `correction_study_drafts` (`skill_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_correction_study_drafts_lifecycle` ON `correction_study_drafts` (`lifecycle`,`updated_at`);
