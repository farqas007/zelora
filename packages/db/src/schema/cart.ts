import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_common";
import { productVariants } from "./catalog";
import { users } from "./identities";

/**
 * Shopping cart foundation.
 *
 * One `carts` row per user (enforced by a UNIQUE on `user_id`); `cart_items`
 * rows reference sellable `product_variants`. Carts are transient working
 * state: the row itself is kept so a returning user keeps a stable cart id,
 * but items ride the lifecycle of the cart and vanish if a variant is
 * removed from the catalog.
 *
 * Quantities are plain positive integers. No pricing, currency or totals are
 * stored here — cart totals are always derived from live variant prices at
 * checkout, never trusted from the client.
 */

export const carts = sqliteTable("carts", {
  id: idColumn(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("carts_user_id_unique").on(table.userId),
]);

export const cartItems = sqliteTable("cart_items", {
  id: idColumn(),
  cartId: text("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
  variantId: text("variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  // One row per (cart, variant): adding an already-present variant increments it.
  unique("cart_items_cart_id_variant_id_unique").on(table.cartId, table.variantId),
  index("cart_items_cart_id_idx").on(table.cartId),
  index("cart_items_variant_id_idx").on(table.variantId),
  check("cart_items_quantity_positive", sql`${table.quantity} > 0`),
]);