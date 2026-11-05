CREATE TABLE `message_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`confidence` real NOT NULL,
	`status` text NOT NULL,
	`claude_run_id` text,
	`created_at` text NOT NULL,
	`content_expired_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `slack_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claude_run_id`) REFERENCES `claude_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_drafts_message_id_kind_uq` ON `message_drafts` (`message_id`,`kind`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`slack_user_id` text NOT NULL,
	`name` text,
	`email` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_slack_user_id_unique` ON `people` (`slack_user_id`);--> statement-breakpoint
CREATE TABLE `people_priority_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`priority` text NOT NULL,
	`rationale` text,
	`extra_attention` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_priority_settings_person_id_unique` ON `people_priority_settings` (`person_id`);--> statement-breakpoint
CREATE TABLE `security_flag_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`rules` text NOT NULL,
	`active` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_flag_rules_version_unique` ON `security_flag_rules` (`version`);--> statement-breakpoint
CREATE TABLE `security_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`source_external_ref` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`person_id` text,
	`conversation_id` text,
	`detector` text NOT NULL,
	`rule_id` text NOT NULL,
	`claude_run_id` text,
	`severity` text NOT NULL,
	`excerpt` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`rules_version` integer,
	`created_at` text NOT NULL,
	`reviewed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `slack_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claude_run_id`) REFERENCES `claude_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_flags_message_id_detector_rule_id_uq` ON `security_flags` (`message_id`,`detector`,`rule_id`);--> statement-breakpoint
CREATE INDEX `security_flags_status_severity_idx` ON `security_flags` (`status`,`severity`);--> statement-breakpoint
CREATE INDEX `security_flags_slack_user_id_idx` ON `security_flags` (`slack_user_id`);