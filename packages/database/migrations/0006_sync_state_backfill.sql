ALTER TABLE `integration_sync_states` ADD `stall_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `integration_sync_states` ADD `generation` text;