CREATE TABLE `engineering_task_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`step` text NOT NULL,
	`status` text NOT NULL,
	`approval_id` text,
	`claude_run_id` text,
	`output` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `engineering_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engineering_task_steps_task_step_uq` ON `engineering_task_steps` (`task_id`,`step`);--> statement-breakpoint
CREATE TABLE `engineering_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`environment_id` text,
	`source` text NOT NULL,
	`source_ref` text,
	`title` text NOT NULL,
	`draft_description` text NOT NULL,
	`approved_description` text,
	`plan` text,
	`parent_branch` text,
	`task_branch` text,
	`status` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`current_step` text,
	`pr_url` text,
	`pr_number` integer,
	`base_sha` text,
	`merge_sha` text,
	`failure` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `repository_environments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `engineering_tasks_status_idx` ON `engineering_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `engineering_tasks_repository_idx` ON `engineering_tasks` (`repository_id`);--> statement-breakpoint
ALTER TABLE `repositories` ADD `test_command` text;