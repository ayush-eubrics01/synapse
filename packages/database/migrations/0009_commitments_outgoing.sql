CREATE TABLE `commitment_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`commitment_id` text NOT NULL,
	`message_id` text,
	`source_external_ref` text NOT NULL,
	`conversation_id` text NOT NULL,
	`claude_run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`commitment_id`) REFERENCES `commitments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `slack_messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`claude_run_id`) REFERENCES `claude_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commitment_sources_commitment_id_source_external_ref_uq` ON `commitment_sources` (`commitment_id`,`source_external_ref`);--> statement-breakpoint
CREATE TABLE `commitment_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`commitment_id` text NOT NULL,
	`actor` text NOT NULL,
	`field` text NOT NULL,
	`from_value` text,
	`to_value` text,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`commitment_id`) REFERENCES `commitments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`owner_slack_user_id` text NOT NULL,
	`counterparty_slack_user_id` text,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`review_status` text NOT NULL,
	`due_at` text,
	`next_action` text,
	`completion_evidence` text,
	`stalled_at` text,
	`last_followup_at` text,
	`closed_at` text,
	`dedup_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commitments_dedup_key_uq` ON `commitments` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `commitments_review_status_status_idx` ON `commitments` (`review_status`,`status`);--> statement-breakpoint
CREATE TABLE `followup_history` (
	`id` text PRIMARY KEY NOT NULL,
	`followup_id` text NOT NULL,
	`event` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`followup_id`) REFERENCES `followups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `followups` (
	`id` text PRIMARY KEY NOT NULL,
	`commitment_id` text,
	`origin` text NOT NULL,
	`origin_message_id` text,
	`conversation_id` text NOT NULL,
	`thread_ts` text,
	`recipient_slack_user_id` text,
	`draft_text` text,
	`confidence` real,
	`status` text NOT NULL,
	`approval_id` text,
	`outgoing_id` text,
	`claude_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`commitment_id`) REFERENCES `commitments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_message_id`) REFERENCES `slack_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claude_run_id`) REFERENCES `claude_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `followups_status_idx` ON `followups` (`status`);--> statement-breakpoint
CREATE TABLE `outgoing_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`followup_id` text,
	`conversation_external_id` text NOT NULL,
	`thread_ts` text,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`claude_run_id` text,
	`sent_at` text,
	`verified_at` text,
	`verify_attempts` integer DEFAULT 0 NOT NULL,
	`failure` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`followup_id`) REFERENCES `followups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claude_run_id`) REFERENCES `claude_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outgoing_messages_approval_id_unique` ON `outgoing_messages` (`approval_id`);--> statement-breakpoint
CREATE INDEX `outgoing_messages_status_idx` ON `outgoing_messages` (`status`);--> statement-breakpoint
ALTER TABLE `slack_messages` ADD `commitments_extracted_at` text;