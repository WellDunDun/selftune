ALTER TABLE `execution_facts` ADD `execution_fact_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_exec_facts_canonical_id` ON `execution_facts` (`execution_fact_id`);