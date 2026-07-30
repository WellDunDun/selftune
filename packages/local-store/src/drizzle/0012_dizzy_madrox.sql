CREATE TABLE `evaluation_submission_drafts` (
	`draft_id` text PRIMARY KEY NOT NULL,
	`pattern_id` text NOT NULL,
	`cohort_fingerprint` text NOT NULL,
	`skill_name` text NOT NULL,
	`skill_revision` text NOT NULL,
	`payload_json` text NOT NULL,
	`lifecycle` text NOT NULL,
	`cloud_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_evaluation_submission_drafts_cohort` ON `evaluation_submission_drafts` (`pattern_id`,`cohort_fingerprint`,`skill_revision`);--> statement-breakpoint
CREATE INDEX `idx_evaluation_submission_drafts_status` ON `evaluation_submission_drafts` (`lifecycle`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_evaluation_submission_drafts_skill` ON `evaluation_submission_drafts` (`skill_name`,`skill_revision`,`updated_at`);
