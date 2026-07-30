CREATE TABLE `analytical_import_checkpoints` (
	`source_kind` text NOT NULL,
	`source_identity` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`normalizer_version` text NOT NULL,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytical_import_checkpoints_source_unique` ON `analytical_import_checkpoints` (`source_kind`,`source_identity`);--> statement-breakpoint
CREATE INDEX `idx_analytical_import_checkpoints_imported` ON `analytical_import_checkpoints` (`imported_at`);