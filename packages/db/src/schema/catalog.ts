import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { createdAtColumn, currencyColumn, enumCheck, flagColumn, idColumn, updatedAtColumn } from "./_common";
import { stores } from "./identities";
import {
  CATEGORY_STATUSES,
  PRODUCT_STATUSES,
  PRODUCT_VARIANT_STATUSES,
} from "./enums";

/**
 * Catalog tree and owned detail:
 *
 *   categories (self-referencing) ──┐
 *     products ── store (identities)│ SET NULL on category delete
 *       product_variants ── inventory (1:1)
 *       product_images
 *
 * Variants are the sellable unit (SKU, price in integer minor units). Between
 * the `product_variants` RESTRICT and `order_items` RESTRICT, a variant that
 * ever appeared in an order cannot be deleted.
 */

export const categories = sqliteTable("categories", {
  id: idColumn(),
  parentId: text("parent_id").references((): AnySQLiteColumn => categories.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  status: text("status", { enum: CATEGORY_STATUSES }).notNull().default("inactive"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  /**
   * SQLite treats NULLs as distinct in UNIQUE constraints, so a single
   * `UNIQUE(parent_id, slug)` would still allow duplicate root slugs. Enforce
   * "unique slug among siblings" with two partial indexes instead.
   */
  uniqueIndex("categories_root_slug_unique").on(table.slug).where(sql`${table.parentId} is null`),
  uniqueIndex("categories_child_slug_unique").on(table.parentId, table.slug).where(sql`${table.parentId} is not null`),
  check("categories_status_check", enumCheck(table.status, CATEGORY_STATUSES)),
]);

export const products = sqliteTable("products", {
  id: idColumn(),
  storeId: text("store_id").notNull().references(() => stores.id, { onDelete: "restrict" }),
  categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  status: text("status", { enum: PRODUCT_STATUSES }).notNull().default("draft"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("products_store_id_slug_unique").on(table.storeId, table.slug),
  index("products_store_id_idx").on(table.storeId),
  index("products_category_id_idx").on(table.categoryId),
  check("products_status_check", enumCheck(table.status, PRODUCT_STATUSES)),
]);

export const productVariants = sqliteTable("product_variants", {
  id: idColumn(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  sku: text("sku"),
  name: text("name").notNull(),
  priceAmountCents: integer("price_amount_cents").notNull().default(0),
  compareAtAmountCents: integer("compare_at_amount_cents"),
  currency: currencyColumn(),
  status: text("status", { enum: PRODUCT_VARIANT_STATUSES }).notNull().default("draft"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("product_variants_sku_unique").on(table.sku),
  index("product_variants_product_id_idx").on(table.productId),
  check("product_variants_price_non_negative", sql`${table.priceAmountCents} >= 0`),
  check("product_variants_compare_at_non_negative", sql`${table.compareAtAmountCents} is null or ${table.compareAtAmountCents} >= 0`),
  check("product_variants_currency_length", sql`length(${table.currency}) = 3`),
  check("product_variants_status_check", enumCheck(table.status, PRODUCT_VARIANT_STATUSES)),
]);

export const productImages = sqliteTable("product_images", {
  id: idColumn(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  altText: text("alt_text"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: flagColumn("is_primary"),
  createdAt: createdAtColumn(),
}, (table) => [
  uniqueIndex("product_images_product_primary_unique").on(table.productId).where(sql`${table.isPrimary} = 1`),
  index("product_images_product_id_sort_idx").on(table.productId, table.sortOrder),
  check("product_images_is_primary_flag", sql`${table.isPrimary} in (0, 1)`),
]);

export const inventory = sqliteTable("inventory", {
  variantId: text("variant_id").primaryKey().references(() => productVariants.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull().default(0),
  updatedAt: updatedAtColumn(),
}, (table) => [
  check("inventory_quantity_non_negative", sql`${table.quantity} >= 0`),
]);