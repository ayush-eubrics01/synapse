CREATE TABLE `auto_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`recipient_slack_user_id` text NOT NULL,
	`conversation_external_id` text NOT NULL,
	`thread_ts` text,
	`source_message_id` text,
	`followup_id` text,
	`decision` text NOT NULL,
	`reason` text,
	`text` text,
	`outgoing_id` text,
	`approval_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `away_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `auto_replies_recipient_created_idx` ON `auto_replies` (`recipient_slack_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `auto_replies_thread_created_idx` ON `auto_replies` (`conversation_external_id`,`thread_ts`,`created_at`);--> statement-breakpoint
CREATE TABLE `away_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`dismissed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `away_sessions_open_uq` ON `away_sessions` ((1)) WHERE "away_sessions"."ended_at" is null;--> statement-breakpoint
ALTER TABLE `approvals` ADD `decided_by` text;