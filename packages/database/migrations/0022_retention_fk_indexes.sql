CREATE INDEX `claude_runs_job_id_idx` ON `claude_runs` (`job_id`);--> statement-breakpoint
CREATE INDEX `event_consumptions_event_id_idx` ON `event_consumptions` (`event_id`);--> statement-breakpoint
CREATE INDEX `job_attempts_job_id_idx` ON `job_attempts` (`job_id`);--> statement-breakpoint
CREATE INDEX `job_checkpoints_job_id_idx` ON `job_checkpoints` (`job_id`);