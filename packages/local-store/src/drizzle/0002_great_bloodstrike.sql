CREATE TABLE `skill_classification_corrections` (
	`correction_id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`category` text,
	`inferred_category` text NOT NULL,
	`reason` text,
	`algorithm_version` text NOT NULL,
	`corrected_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_skill_classification_corrections_algorithm` ON `skill_classification_corrections` (`algorithm_version`,`corrected_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_classification_corrections_skill` ON `skill_classification_corrections` (`skill_id`,`corrected_at`);--> statement-breakpoint
CREATE TABLE `skill_set_outcomes` (
	`outcome_id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`set_id` text NOT NULL,
	`algorithm_version` text NOT NULL,
	`project_root` text NOT NULL,
	`activated_at` text NOT NULL,
	`measured_at` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`minimum_sessions` integer NOT NULL,
	`before_session_count` integer NOT NULL,
	`after_session_count` integer NOT NULL,
	`metrics_json` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `skill_set_suggestion_reviews`(`review_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_set_outcomes_review_receipt_unique` ON `skill_set_outcomes` (`review_id`,`receipt_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_set_outcomes_algorithm` ON `skill_set_outcomes` (`algorithm_version`,`measured_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_set_outcomes_set` ON `skill_set_outcomes` (`set_id`,`activated_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_set_outcomes_status` ON `skill_set_outcomes` (`status`,`measured_at`);--> statement-breakpoint
ALTER TABLE `skill_set_suggestion_reviews` ADD `edit_distance` real;