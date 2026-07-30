ALTER TABLE `upload_queue` ADD `next_attempt_at` text;--> statement-breakpoint
CREATE INDEX `idx_upload_queue_retry` ON `upload_queue` (`status`,`next_attempt_at`);
