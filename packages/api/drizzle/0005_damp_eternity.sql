PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`restaurant_id` text NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`address` text,
	`iban` text,
	`start_date` text,
	`emergency_contact` text,
	`emergency_phone` text,
	`notes` text,
	`manager_notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`restaurant_id`) REFERENCES `restaurants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "name", "email", "phone", "password_hash", "role", "restaurant_id", "priority", "address", "iban", "start_date", "emergency_contact", "emergency_phone", "notes", "manager_notes", "created_at") SELECT "id", "name", "email", "phone", "password_hash", "role", "restaurant_id", "priority", "address", "iban", "start_date", "emergency_contact", "emergency_phone", "notes", "manager_notes", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `restaurants` ADD `open_days` text DEFAULT '[2,3,4,5,6,7]' NOT NULL;