CREATE TABLE `shift_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`restaurant_id` text NOT NULL,
	`role` text NOT NULL,
	`zone` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	FOREIGN KEY (`restaurant_id`) REFERENCES `restaurants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `worker_availability` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`restaurant_id` text NOT NULL,
	`day_of_week` integer NOT NULL,
	`midi` integer DEFAULT false NOT NULL,
	`soir` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`restaurant_id`) REFERENCES `restaurants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `users` ADD `priority` integer DEFAULT 3 NOT NULL;