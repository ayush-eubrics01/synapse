CREATE TABLE `people_profile_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`recommendation_id` text,
	`version_id` text,
	`observation_key` text NOT NULL,
	`message_id` text,
	`source_external_ref` text NOT NULL,
	`confidence` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`recommendation_id`) REFERENCES `people_profile_recommendations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `people_profile_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `slack_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `people_profile_evidence_version_id_idx` ON `people_profile_evidence` (`version_id`);--> statement-breakpoint
CREATE INDEX `people_profile_evidence_recommendation_id_idx` ON `people_profile_evidence` (`recommendation_id`);--> statement-breakpoint
CREATE TABLE `people_profile_recommendations` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`base_version` integer,
	`content` text,
	`observation_hash` text,
	`status` text NOT NULL,
	`approval_id` text,
	`claude_run_id` text,
	`reason` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claude_run_id`) REFERENCES `claude_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `people_profile_recommendations_person_id_status_idx` ON `people_profile_recommendations` (`person_id`,`status`);--> statement-breakpoint
CREATE TABLE `people_profile_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`recommendation_id` text NOT NULL,
	`approval_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `people_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recommendation_id`) REFERENCES `people_profile_recommendations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_profile_versions_profile_id_version_uq` ON `people_profile_versions` (`profile_id`,`version`);--> statement-breakpoint
CREATE TABLE `people_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`current_version` integer NOT NULL,
	`content` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_profiles_person_id_unique` ON `people_profiles` (`person_id`);--> statement-breakpoint
CREATE TABLE `temporary_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`slack_user_id` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`profile_assessment` text,
	`assessed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `temporary_contacts_slack_user_id_unique` ON `temporary_contacts` (`slack_user_id`);--> statement-breakpoint
ALTER TABLE `people` ADD `title` text;--> statement-breakpoint
ALTER TABLE `people` ADD `team` text;