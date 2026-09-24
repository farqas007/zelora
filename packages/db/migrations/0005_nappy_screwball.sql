CREATE TABLE `cart_items` (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cart_items_quantity_positive" CHECK("cart_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX `cart_items_cart_id_idx` ON `cart_items` (`cart_id`);--> statement-breakpoint
CREATE INDEX `cart_items_variant_id_idx` ON `cart_items` (`variant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cart_items_cart_id_variant_id_unique` ON `cart_items` (`cart_id`,`variant_id`);--> statement-breakpoint
CREATE TABLE `carts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `carts_user_id_unique` ON `carts` (`user_id`);