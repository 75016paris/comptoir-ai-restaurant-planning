-- Swap broadcast: make target_id nullable
-- SQLite doesn't support ALTER COLUMN, so we recreate the table

PRAGMA foreign_keys = OFF;

CREATE TABLE `swap_requests_new` (
	`id` text PRIMARY KEY NOT NULL,
	`requester_id` text NOT NULL,
	`requester_shift_id` text NOT NULL,
	`target_id` text,
	`target_shift_id` text,
	`restaurant_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`message` text,
	`responded_at` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`restaurant_id`) REFERENCES `restaurants`(`id`) ON UPDATE no action ON DELETE no action
);

INSERT INTO `swap_requests_new` SELECT * FROM `swap_requests`;
DROP TABLE `swap_requests`;
ALTER TABLE `swap_requests_new` RENAME TO `swap_requests`;

PRAGMA foreign_keys = ON;
