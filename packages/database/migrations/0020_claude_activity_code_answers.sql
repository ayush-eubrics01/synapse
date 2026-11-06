CREATE TABLE `claude_session_prs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`pr_url` text NOT NULL,
	`pr_number` integer NOT NULL,
	`pr_repository` text NOT NULL,
	`git_branch` text,
	`first_seen_at` text NOT NULL,
	`reminded_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `claude_sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_session_prs_pr_url_unique` ON `claude_session_prs` (`pr_url`);--> statement-breakpoint
CREATE INDEX `claude_session_prs_repo_idx` ON `claude_session_prs` (`repository_id`);--> statement-breakpoint
CREATE TABLE `claude_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`cwd` text NOT NULL,
	`git_branch` text,
	`title` text,
	`first_at` text NOT NULL,
	`last_at` text NOT NULL,
	`version` text,
	`entrypoint` text,
	`file_path` text NOT NULL,
	`file_offset` integer NOT NULL,
	`file_size` integer NOT NULL,
	`file_mtime_ms` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_sessions_file_path_unique` ON `claude_sessions` (`file_path`);--> statement-breakpoint
CREATE INDEX `claude_sessions_repo_last_idx` ON `claude_sessions` (`repository_id`,`last_at`);--> statement-breakpoint
CREATE TABLE `code_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`repository_id` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`answer` text,
	`confidence` real,
	`evidence` text NOT NULL,
	`dropped_evidence_count` integer NOT NULL,
	`suspected_injection` text,
	`not_answerable_reason` text,
	`claude_run_id` text,
	`failure` text,
	`auto_reply_id` text,
	`outgoing_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `slack_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`auto_reply_id`) REFERENCES `auto_replies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `code_answers_live_uq` ON `code_answers` (`message_id`,`repository_id`,`trigger`) WHERE "code_answers"."status" not in ('failed','dismissed');