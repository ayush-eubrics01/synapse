CREATE TABLE `dashboard_layouts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`layout` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_layouts_name_uq` ON `dashboard_layouts` (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_layouts_active_uq` ON `dashboard_layouts` ((1)) WHERE "dashboard_layouts"."is_active" = 1;