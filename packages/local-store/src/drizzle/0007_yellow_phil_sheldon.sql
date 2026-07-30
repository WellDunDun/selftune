CREATE TABLE `local_trace_metrics` (
	`metric_id` text PRIMARY KEY NOT NULL,
	`span_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`metric_name` text NOT NULL,
	`value` integer NOT NULL,
	`unit` text NOT NULL,
	FOREIGN KEY (`span_id`) REFERENCES `local_trace_spans`(`span_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_trace_metrics_span_name_unique` ON `local_trace_metrics` (`span_id`,`metric_name`);--> statement-breakpoint
CREATE INDEX `idx_local_trace_metrics_trace_name` ON `local_trace_metrics` (`trace_id`,`metric_name`);--> statement-breakpoint
CREATE INDEX `idx_local_trace_metrics_span_name` ON `local_trace_metrics` (`span_id`,`metric_name`);--> statement-breakpoint
CREATE TABLE `local_trace_spans` (
	`span_id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`parent_span_id` text,
	`span_name` text NOT NULL,
	`source_started_at` text NOT NULL,
	`source_ended_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`platform` text NOT NULL,
	`capture_mode` text NOT NULL,
	`source_authority` text NOT NULL,
	`source_id` text NOT NULL,
	`trace_boundary` text NOT NULL,
	`operation_name` text NOT NULL,
	`provider` text,
	`model` text
);
--> statement-breakpoint
CREATE INDEX `idx_local_trace_spans_trace_started` ON `local_trace_spans` (`trace_id`,`source_started_at`);--> statement-breakpoint
CREATE INDEX `idx_local_trace_spans_started` ON `local_trace_spans` (`source_started_at`);