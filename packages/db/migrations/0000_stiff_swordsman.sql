CREATE TABLE `seller_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seller_profiles_status_check" CHECK("seller_profiles"."status" in ('pending', 'active', 'suspended', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seller_profiles_user_id_unique` ON `seller_profiles` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `seller_profiles_slug_unique` ON `seller_profiles` (`slug`);--> statement-breakpoint
CREATE TABLE `stores` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_profile_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`seller_profile_id`) REFERENCES `seller_profiles`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "stores_status_check" CHECK("stores"."status" in ('draft', 'active', 'inactive', 'closed'))
);
--> statement-breakpoint
CREATE INDEX `stores_seller_profile_id_idx` ON `stores` (`seller_profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stores_slug_unique` ON `stores` (`slug`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'customer' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`name` text NOT NULL,
	`password_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "users_role_check" CHECK("users"."role" in ('customer', 'seller', 'admin')),
	CONSTRAINT "users_status_check" CHECK("users"."status" in ('active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'inactive' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "categories_status_check" CHECK("categories"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_root_slug_unique` ON `categories` (`slug`) WHERE "categories"."parent_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `categories_child_slug_unique` ON `categories` (`parent_id`,`slug`) WHERE "categories"."parent_id" is not null;--> statement-breakpoint
CREATE TABLE `inventory` (
	`variant_id` text PRIMARY KEY NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inventory_quantity_non_negative" CHECK("inventory"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE `product_images` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`url` text NOT NULL,
	`alt_text` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_primary` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_images_is_primary_flag" CHECK("product_images"."is_primary" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_images_product_primary_unique` ON `product_images` (`product_id`) WHERE "product_images"."is_primary" = 1;--> statement-breakpoint
CREATE INDEX `product_images_product_id_sort_idx` ON `product_images` (`product_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`sku` text,
	`name` text NOT NULL,
	`price_amount_cents` integer DEFAULT 0 NOT NULL,
	`compare_at_amount_cents` integer,
	`currency` text(3) NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_variants_price_non_negative" CHECK("product_variants"."price_amount_cents" >= 0),
	CONSTRAINT "product_variants_compare_at_non_negative" CHECK("product_variants"."compare_at_amount_cents" is null or "product_variants"."compare_at_amount_cents" >= 0),
	CONSTRAINT "product_variants_currency_length" CHECK(length("product_variants"."currency") = 3),
	CONSTRAINT "product_variants_status_check" CHECK("product_variants"."status" in ('draft', 'active', 'inactive'))
);
--> statement-breakpoint
CREATE INDEX `product_variants_product_id_idx` ON `product_variants` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_sku_unique` ON `product_variants` (`sku`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`category_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "products_status_check" CHECK("products"."status" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `products_store_id_idx` ON `products` (`store_id`);--> statement-breakpoint
CREATE INDEX `products_category_id_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_store_id_slug_unique` ON `products` (`store_id`,`slug`);--> statement-breakpoint
CREATE TABLE `addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`recipient_name` text NOT NULL,
	`phone` text,
	`line1` text NOT NULL,
	`line2` text,
	`city` text NOT NULL,
	`region` text,
	`postal_code` text,
	`country_code` text(2) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "addresses_is_default_flag" CHECK("addresses"."is_default" in (0, 1)),
	CONSTRAINT "addresses_country_code_length" CHECK(length("addresses"."country_code") = 2),
	CONSTRAINT "addresses_type_check" CHECK("addresses"."type" in ('shipping', 'billing'))
);
--> statement-breakpoint
CREATE INDEX `addresses_user_id_type_idx` ON `addresses` (`user_id`,`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `addresses_user_type_default_unique` ON `addresses` (`user_id`,`type`) WHERE "addresses"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `order_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`recipient_name` text NOT NULL,
	`phone` text,
	`line1` text NOT NULL,
	`line2` text,
	`city` text NOT NULL,
	`region` text,
	`postal_code` text,
	`country_code` text(2) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_addresses_country_code_length" CHECK(length("order_addresses"."country_code") = 2),
	CONSTRAINT "order_addresses_kind_check" CHECK("order_addresses"."kind" in ('shipping', 'billing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_addresses_order_kind_unique` ON `order_addresses` (`order_id`,`kind`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`store_id` text NOT NULL,
	`product_name` text NOT NULL,
	`variant_name` text NOT NULL,
	`sku` text,
	`quantity` integer NOT NULL,
	`unit_amount_cents` integer DEFAULT 0 NOT NULL,
	`line_total_amount_cents` integer DEFAULT 0 NOT NULL,
	`currency` text(3) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_items_currency_length" CHECK(length("order_items"."currency") = 3),
	CONSTRAINT "order_items_quantity_positive" CHECK("order_items"."quantity" > 0),
	CONSTRAINT "order_items_unit_amount_non_negative" CHECK("order_items"."unit_amount_cents" >= 0),
	CONSTRAINT "order_items_line_total_non_negative" CHECK("order_items"."line_total_amount_cents" >= 0),
	CONSTRAINT "order_items_line_total_matches_quantity" CHECK("order_items"."line_total_amount_cents" = "order_items"."unit_amount_cents" * "order_items"."quantity"),
	CONSTRAINT "order_items_status_check" CHECK("order_items"."status" in ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'))
);
--> statement-breakpoint
CREATE INDEX `order_items_order_id_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_store_id_idx` ON `order_items` (`store_id`);--> statement-breakpoint
CREATE INDEX `order_items_variant_id_idx` ON `order_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`currency` text(3) NOT NULL,
	`subtotal_amount_cents` integer DEFAULT 0 NOT NULL,
	`shipping_amount_cents` integer DEFAULT 0 NOT NULL,
	`discount_amount_cents` integer DEFAULT 0 NOT NULL,
	`total_amount_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "orders_currency_length" CHECK(length("orders"."currency") = 3),
	CONSTRAINT "orders_subtotal_non_negative" CHECK("orders"."subtotal_amount_cents" >= 0),
	CONSTRAINT "orders_shipping_non_negative" CHECK("orders"."shipping_amount_cents" >= 0),
	CONSTRAINT "orders_discount_non_negative" CHECK("orders"."discount_amount_cents" >= 0),
	CONSTRAINT "orders_total_non_negative" CHECK("orders"."total_amount_cents" >= 0),
	CONSTRAINT "orders_status_check" CHECK("orders"."status" in ('pending', 'confirmed', 'processing', 'completed', 'cancelled', 'refunded'))
);
--> statement-breakpoint
CREATE INDEX `orders_customer_created_at_idx` ON `orders` (`customer_user_id`,`created_at`);