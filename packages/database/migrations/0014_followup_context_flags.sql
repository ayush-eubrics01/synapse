ALTER TABLE `followups` ADD `suspected_injection` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `followups` ADD `context_message_ids` text;--> statement-breakpoint
CREATE INDEX `auto_replies_outgoing_idx` ON `auto_replies` (`outgoing_id`);