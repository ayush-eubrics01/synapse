CREATE TABLE `integration_capabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`name` text NOT NULL,
	`available` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_capabilities_integration_id_name_uq` ON `integration_capabilities` (`integration_id`,`name`);--> statement-breakpoint
CREATE TABLE `integration_sync_states` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`stream` text NOT NULL,
	`checkpoint` text,
	`cursor` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_success_at` text,
	`last_error` text,
	`upper_bound` text,
	`pages_done` integer DEFAULT 0 NOT NULL,
	`search_count_date` text,
	`search_count` integer DEFAULT 0 NOT NULL,
	`next_run_after` text,
	`backoff_minutes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_sync_states_integration_id_stream_uq` ON `integration_sync_states` (`integration_id`,`stream`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`adapter` text NOT NULL,
	`config` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_kind_adapter_uq` ON `integrations` (`kind`,`adapter`);--> statement-breakpoint
CREATE TABLE `slack_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`external_file_id` text NOT NULL,
	`name` text,
	`local_path` text,
	FOREIGN KEY (`message_id`) REFERENCES `slack_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `slack_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`accessible` integer DEFAULT true NOT NULL,
	`last_seen_ts` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_conversations_external_id_unique` ON `slack_conversations` (`external_id`);--> statement-breakpoint
CREATE TABLE `slack_message_references` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `slack_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `slack_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`ts` text NOT NULL,
	`thread_ts` text,
	`sender_user_id` text NOT NULL,
	`text` text,
	`full_notes` text,
	`permalink` text,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`sent_at` text NOT NULL,
	`collected_at` text NOT NULL,
	`content_expired_at` text,
	`screening` text,
	`urgency_level` text,
	`urgency_reason` text,
	`urgency_status` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `slack_conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_user_id`) REFERENCES `slack_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_messages_conversation_id_ts_uq` ON `slack_messages` (`conversation_id`,`ts`);--> statement-breakpoint
CREATE INDEX `slack_messages_sent_at_idx` ON `slack_messages` (`sent_at`);--> statement-breakpoint
CREATE INDEX `slack_messages_conversation_id_thread_ts_idx` ON `slack_messages` (`conversation_id`,`thread_ts`);--> statement-breakpoint
CREATE INDEX `slack_messages_urgency_level_urgency_status_idx` ON `slack_messages` (`urgency_level`,`urgency_status`);--> statement-breakpoint
CREATE TABLE `slack_users` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`name` text,
	`email` text,
	`is_bot` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_users_external_id_unique` ON `slack_users` (`external_id`);