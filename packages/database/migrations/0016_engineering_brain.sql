CREATE TABLE `project_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`evidence` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`claude_run_id` text,
	`supersedes_id` text,
	`head_sha` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_facts_project_status_idx` ON `project_facts` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `project_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`target_date` text NOT NULL,
	`environment_id` text,
	`status` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `repository_environments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_milestones_project_date_idx` ON `project_milestones` (`project_id`,`target_date`);--> statement-breakpoint
CREATE TABLE `project_repositories` (
	`project_id` text NOT NULL,
	`repository_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_repositories_pair_uq` ON `project_repositories` (`project_id`,`repository_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`summary` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_unique` ON `projects` (`name`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`local_path` text NOT NULL,
	`origin_url` text,
	`upstream_url` text,
	`upstream_push_disabled` integer NOT NULL,
	`tracked_branch` text NOT NULL,
	`jira_project_keys` text NOT NULL,
	`notes` text,
	`head_sha` text,
	`inspected_head_sha` text,
	`drift` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_name_unique` ON `repositories` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_local_path_unique` ON `repositories` (`local_path`);--> statement-breakpoint
CREATE TABLE `repository_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`name` text NOT NULL,
	`branch` text NOT NULL,
	`protected` integer NOT NULL,
	`auto_deploys_on_merge` integer NOT NULL,
	`notes` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_environments_repo_name_uq` ON `repository_environments` (`repository_id`,`name`);