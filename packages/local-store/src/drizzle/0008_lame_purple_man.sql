CREATE TABLE `local_trace_skill_links` (
	`link_id` text PRIMARY KEY NOT NULL,
	`span_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`skill_invocation_id` text NOT NULL,
	FOREIGN KEY (`span_id`) REFERENCES `local_trace_spans`(`span_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_trace_skill_links_span_skill_invocation_unique` ON `local_trace_skill_links` (`span_id`,`skill_invocation_id`);--> statement-breakpoint
CREATE INDEX `idx_local_trace_skill_links_skill_invocation` ON `local_trace_skill_links` (`skill_invocation_id`);--> statement-breakpoint
CREATE INDEX `idx_local_trace_skill_links_trace_span` ON `local_trace_skill_links` (`trace_id`,`span_id`);