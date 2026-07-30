CREATE TABLE `skill_classification_overrides` (
	`skill_id` text PRIMARY KEY NOT NULL,
	`skill_name` text NOT NULL,
	`category` text NOT NULL,
	`inferred_category` text NOT NULL,
	`reason` text,
	`algorithm_version` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_skill_classification_overrides_updated` ON `skill_classification_overrides` (`updated_at`);--> statement-breakpoint
CREATE TABLE `skill_set_suggestion_reviews` (
	`review_id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`suggestion_id` text NOT NULL,
	`evidence_fingerprint` text NOT NULL,
	`decision` text NOT NULL,
	`reason_code` text NOT NULL,
	`reason` text,
	`resulting_set_id` text,
	`result_json` text,
	`algorithm_version` text NOT NULL,
	`reviewed_at` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `skill_set_suggestion_snapshots`(`snapshot_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_set_suggestion_review_decision_unique` ON `skill_set_suggestion_reviews` (`snapshot_id`,`decision`);--> statement-breakpoint
CREATE INDEX `idx_skill_set_suggestion_reviews_reviewed` ON `skill_set_suggestion_reviews` (`reviewed_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_set_suggestion_reviews_suggestion` ON `skill_set_suggestion_reviews` (`suggestion_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_set_suggestion_reviews_snapshot` ON `skill_set_suggestion_reviews` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `skill_set_suggestion_snapshots` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`suggestion_id` text NOT NULL,
	`evidence_fingerprint` text NOT NULL,
	`pattern` text NOT NULL,
	`algorithm_version` text NOT NULL,
	`evidence_version` integer NOT NULL,
	`suggestion_json` text NOT NULL,
	`generated_at` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_set_suggestion_snapshot_evidence_unique` ON `skill_set_suggestion_snapshots` (`suggestion_id`,`evidence_fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_skill_set_suggestion_snapshots_last_seen` ON `skill_set_suggestion_snapshots` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_set_suggestion_snapshots_suggestion` ON `skill_set_suggestion_snapshots` (`suggestion_id`);