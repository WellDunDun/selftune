CREATE TABLE `correction_episodes` (
	`episode_id` text PRIMARY KEY NOT NULL,
	`capture_key` text NOT NULL,
	`skill_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`skill_path` text NOT NULL,
	`harness` text NOT NULL,
	`source_session_id` text NOT NULL,
	`pre_revision` text NOT NULL,
	`post_revision` text NOT NULL,
	`manifest_json` text NOT NULL,
	`correction_intent_json` text NOT NULL,
	`trace_payload_json` text NOT NULL,
	`evidence_level` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`captured_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correction_episodes_capture_key_unique` ON `correction_episodes` (`capture_key`);--> statement-breakpoint
CREATE INDEX `idx_correction_episodes_skill` ON `correction_episodes` (`skill_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_correction_episodes_status` ON `correction_episodes` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_correction_episodes_source_session` ON `correction_episodes` (`source_session_id`);--> statement-breakpoint
CREATE TABLE `correction_evidence_ledger_entries` (
	`evidence_id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`episode_id` text NOT NULL,
	`evidence_key` text NOT NULL,
	`evidence_level` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`manifest_json` text NOT NULL,
	`verifier_payload_json` text NOT NULL,
	`trial_payload_json` text NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `correction_episodes`(`episode_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correction_evidence_ledger_episode_key_unique` ON `correction_evidence_ledger_entries` (`episode_id`,`evidence_key`);--> statement-breakpoint
CREATE INDEX `idx_correction_evidence_ledger_episode` ON `correction_evidence_ledger_entries` (`episode_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `idx_correction_evidence_ledger_status` ON `correction_evidence_ledger_entries` (`status`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `promoted_study_cases` (
	`case_id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`skill_id` text NOT NULL,
	`pre_revision` text NOT NULL,
	`post_revision` text NOT NULL,
	`manifest_json` text NOT NULL,
	`verifier_payload_json` text NOT NULL,
	`trial_payload_json` text NOT NULL,
	`evidence_level` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`promoted_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `correction_episodes`(`episode_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_id`) REFERENCES `correction_evidence_ledger_entries`(`evidence_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `promoted_study_cases_episode_unique` ON `promoted_study_cases` (`episode_id`);--> statement-breakpoint
CREATE INDEX `idx_promoted_study_cases_skill` ON `promoted_study_cases` (`skill_id`,`promoted_at`);--> statement-breakpoint
CREATE INDEX `idx_promoted_study_cases_evidence` ON `promoted_study_cases` (`evidence_id`);