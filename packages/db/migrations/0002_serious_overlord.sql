CREATE INDEX `product_variants_product_id_status_idx` ON `product_variants` (`product_id`,`status`);--> statement-breakpoint
CREATE INDEX `products_public_status_created_at_idx` ON `products` (`status`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `products_public_status_category_id_idx` ON `products` (`status`,`category_id`);