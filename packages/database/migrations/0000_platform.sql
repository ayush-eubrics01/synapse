CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`target_integration` text,
	`target_ref` text,
	`payload` text NOT NULL,
	`risk_level` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text,
	`decided_at` text,
	`execution_result` text,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_idempotency_key_uq` ON `approvals` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`module` text,
	`worker_profile` text,
	`action` text NOT NULL,
	`target_integration` text,
	`target_ref` text,
	`approval_id` text,
	`result` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `auth_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`observed_at` text NOT NULL,
	`access_expires_at` text,
	`refresh_expires_at` text,
	`claude_run_id` text,
	FOREIGN KEY (`claude_run_id`) REFERENCES `claude_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `claude_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`worker_profile` text NOT NULL,
	`model` text,
	`status` text NOT NULL,
	`num_turns` integer,
	`duration_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_creation_tokens` integer,
	`cost_usd_equivalent` real,
	`permission_denials` text,
	`error` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `domain_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`correlation_id` text,
	`causation_id` text,
	`payload` text NOT NULL,
	`occurred_at` text NOT NULL,
	`dispatched_at` text,
	`ephemeral` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `domain_events_dispatched_at_occurred_at_idx` ON `domain_events` (`dispatched_at`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `event_consumptions` (
	`id` text PRIMARY KEY NOT NULL,
	`consumer` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`event_id`) REFERENCES `domain_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_consumptions_consumer_event_id_uq` ON `event_consumptions` (`consumer`,`event_id`);--> statement-breakpoint
CREATE TABLE `job_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`error` text,
	`claude_run_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claude_run_id`) REFERENCES `claude_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`checkpoint` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`input` text,
	`output` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`idempotency_key` text NOT NULL,
	`concurrency_group` text,
	`run_after` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `jobs_status_priority_run_after_idx` ON `jobs` (`status`,`priority`,`run_after`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_key_uq` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `leases` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`heartbeat_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `module_dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`module` text NOT NULL,
	`depends_on` text NOT NULL,
	FOREIGN KEY (`module`) REFERENCES `modules`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on`) REFERENCES `modules`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `module_dependencies_module_depends_on_uq` ON `module_dependencies` (`module`,`depends_on`);--> statement-breakpoint
CREATE TABLE `modules` (
	`name` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`ref` text,
	`created_at` text NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`policy` text NOT NULL,
	`scope` text
);
--> statement-breakpoint
CREATE TABLE `quota_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`observed_at` text NOT NULL,
	`five_hour_utilization` real,
	`five_hour_resets_at` text,
	`seven_day_utilization` real,
	`seven_day_resets_at` text,
	`status` text NOT NULL,
	`claude_run_id` text,
	FOREIGN KEY (`claude_run_id`) REFERENCES `claude_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`job_type` text NOT NULL,
	`interval_seconds` integer,
	`cron` text,
	`input` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` text,
	`last_run_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_tasks_name_unique` ON `scheduled_tasks` (`name`);