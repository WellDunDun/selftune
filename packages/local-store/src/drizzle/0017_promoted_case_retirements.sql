CREATE TABLE `promoted_study_case_retirements` (
	`retirement_id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`prior_manifest_digest` text NOT NULL,
	`retired_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `promoted_study_cases`(`case_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `promoted_study_case_retirements_case_unique` ON `promoted_study_case_retirements` (`case_id`);--> statement-breakpoint
CREATE INDEX `idx_promoted_study_case_retirements_case` ON `promoted_study_case_retirements` (`case_id`,`retired_at`);
--> statement-breakpoint
CREATE TABLE `correction_candidate_evaluations` (
	`evaluation_id` text PRIMARY KEY NOT NULL, `candidate_id` text NOT NULL, `current_revision` text NOT NULL, `candidate_revision` text NOT NULL,
	`evidence_level` text NOT NULL, `status` text NOT NULL, `reason` text, `blind_manifest_json` text NOT NULL, `blind_result_json` text NOT NULL,
	`verifier_provenance` text NOT NULL, `runtime_provenance` text NOT NULL, `cost_estimate` text, `cost_actual` text, `applies_change` text NOT NULL, `recorded_at` text NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `correction_signal_candidates`(`candidate_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correction_candidate_evaluations_candidate_unique` ON `correction_candidate_evaluations` (`evaluation_id`,`candidate_id`);--> statement-breakpoint
CREATE INDEX `idx_correction_candidate_evaluations_candidate` ON `correction_candidate_evaluations` (`candidate_id`,`recorded_at`);
