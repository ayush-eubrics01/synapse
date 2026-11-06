CREATE TABLE `jira_issues` (
	`key` text PRIMARY KEY NOT NULL,
	`jira_id` text NOT NULL,
	`project_key` text NOT NULL,
	`summary` text NOT NULL,
	`status_name` text NOT NULL,
	`status_category` text NOT NULL,
	`priority` text,
	`issue_type` text NOT NULL,
	`labels` text NOT NULL,
	`due_date` text,
	`jira_created_at` text NOT NULL,
	`jira_updated_at` text NOT NULL,
	`web_url` text NOT NULL,
	`in_scope` integer NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`attention` text,
	`attention_since` text
);
--> statement-breakpoint
CREATE INDEX `jira_issues_scope_category_idx` ON `jira_issues` (`in_scope`,`status_category`);--> statement-breakpoint
CREATE INDEX `jira_issues_updated_idx` ON `jira_issues` (`jira_updated_at`);