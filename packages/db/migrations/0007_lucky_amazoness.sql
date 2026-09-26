CREATE TABLE `media_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`storage_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`bytes` blob NOT NULL,
	`created_at` integer NOT NULL,
	`checksum` text,
	CONSTRAINT "media_objects_byte_size_matches_bytes" CHECK("media_objects"."byte_size" = length("media_objects"."bytes"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_objects_storage_key_unique` ON `media_objects` (`storage_key`);--> statement-breakpoint
CREATE TABLE `product_media` (
	`product_id` text NOT NULL,
	`media_object_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`product_id`, `media_object_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_object_id`) REFERENCES `media_objects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_media_media_object_id_idx` ON `product_media` (`media_object_id`);