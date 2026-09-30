PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`idempotency_fingerprint` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`currency` text(3) NOT NULL,
	`subtotal_amount_cents` integer DEFAULT 0 NOT NULL,
	`shipping_amount_cents` integer DEFAULT 0 NOT NULL,
	`discount_amount_cents` integer DEFAULT 0 NOT NULL,
	`total_amount_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "orders_currency_length" CHECK(length("__new_orders"."currency") = 3),
	CONSTRAINT "orders_idempotency_key_length" CHECK(length("__new_orders"."idempotency_key") between 8 and 64),
	CONSTRAINT "orders_idempotency_fingerprint_length" CHECK(length("__new_orders"."idempotency_fingerprint") = 64),
	CONSTRAINT "orders_subtotal_non_negative" CHECK("__new_orders"."subtotal_amount_cents" >= 0),
	CONSTRAINT "orders_shipping_non_negative" CHECK("__new_orders"."shipping_amount_cents" >= 0),
	CONSTRAINT "orders_discount_non_negative" CHECK("__new_orders"."discount_amount_cents" >= 0),
	CONSTRAINT "orders_total_non_negative" CHECK("__new_orders"."total_amount_cents" >= 0),
	CONSTRAINT "orders_status_check" CHECK("__new_orders"."status" in ('pending', 'confirmed', 'processing', 'completed', 'cancelled', 'refunded'))
);
--> statement-breakpoint
INSERT INTO `__new_orders`("id", "customer_user_id", "idempotency_key", "idempotency_fingerprint", "status", "currency", "subtotal_amount_cents", "shipping_amount_cents", "discount_amount_cents", "total_amount_cents", "created_at", "updated_at") SELECT "id", "customer_user_id", "id", '0000000000000000000000000000000000000000000000000000000000000000', "status", "currency", "subtotal_amount_cents", "shipping_amount_cents", "discount_amount_cents", "total_amount_cents", "created_at", "updated_at" FROM `orders`;--> statement-breakpoint
DROP TABLE `orders`;--> statement-breakpoint
ALTER TABLE `__new_orders` RENAME TO `orders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `orders_customer_created_at_idx` ON `orders` (`customer_user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_customer_idempotency_key_unique` ON `orders` (`customer_user_id`,`idempotency_key`);