import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { createdAtColumn, currencyColumn, enumCheck, idColumn, updatedAtColumn } from "./_common";
import { productVariants } from "./catalog";
import { stores, users } from "./identities";
import { ORDER_ADDRESS_KINDS, ORDER_ITEM_STATUSES, ORDER_STATUSES } from "./enums";

/**
 * Orders (multi-vendor capable).
 *
 * One `orders` row represents one customer checkout. The order belongs to the
 * customer; sellers are a property of the *lines*. Every `order_items` row
 * stores the `store_id` it belongs to at order time, so a single order can
 * contain lines from many stores and every seller-side operation is a simple
 * indexed `WHERE store_id = ?` query. Per-line status lets each store's part
 * of an order advance independently until per-store fulfillment records are
 * added in a later phase.
 *
 * Order rows are append-only business records: deleting an order (or its
 * users/stores/variants) is blocked by RESTRICT referential actions.
 */

export const orders = sqliteTable("orders", {
  id: idColumn(),
  customerUserId: text("customer_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  status: text("status", { enum: ORDER_STATUSES }).notNull().default("pending"),
  currency: currencyColumn(),
  subtotalAmountCents: integer("subtotal_amount_cents").notNull().default(0),
  shippingAmountCents: integer("shipping_amount_cents").notNull().default(0),
  discountAmountCents: integer("discount_amount_cents").notNull().default(0),
  totalAmountCents: integer("total_amount_cents").notNull().default(0),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  index("orders_customer_created_at_idx").on(table.customerUserId, table.createdAt),
  check("orders_currency_length", sql`length(${table.currency}) = 3`),
  check("orders_subtotal_non_negative", sql`${table.subtotalAmountCents} >= 0`),
  check("orders_shipping_non_negative", sql`${table.shippingAmountCents} >= 0`),
  check("orders_discount_non_negative", sql`${table.discountAmountCents} >= 0`),
  check("orders_total_non_negative", sql`${table.totalAmountCents} >= 0`),
  check("orders_status_check", enumCheck(table.status, ORDER_STATUSES)),
]);

/**
 * Verbatim address snapshots captured at checkout (one shipping + one billing
 * row per order via the UNIQUE on (order_id, kind)). Immutable once placed.
 */
export const orderAddresses = sqliteTable("order_addresses", {
  id: idColumn(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  kind: text("kind", { enum: ORDER_ADDRESS_KINDS }).notNull(),
  recipientName: text("recipient_name").notNull(),
  phone: text("phone"),
  line1: text("line1").notNull(),
  line2: text("line2"),
  city: text("city").notNull(),
  region: text("region"),
  postalCode: text("postal_code"),
  countryCode: text("country_code", { length: 2 }).notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("order_addresses_order_kind_unique").on(table.orderId, table.kind),
  check("order_addresses_country_code_length", sql`length(${table.countryCode}) = 2`),
  check("order_addresses_kind_check", enumCheck(table.kind, ORDER_ADDRESS_KINDS)),
]);

/**
 * One row per purchased line. Name, SKU, unit price and store are snapshotted
 * at order time so history is immutable even if catalog data changes later.
 */
export const orderItems = sqliteTable("order_items", {
  id: idColumn(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  variantId: text("variant_id").notNull().references(() => productVariants.id, { onDelete: "restrict" }),
  storeId: text("store_id").notNull().references(() => stores.id, { onDelete: "restrict" }),
  productName: text("product_name").notNull(),
  variantName: text("variant_name").notNull(),
  sku: text("sku"),
  quantity: integer("quantity").notNull(),
  unitAmountCents: integer("unit_amount_cents").notNull().default(0),
  lineTotalAmountCents: integer("line_total_amount_cents").notNull().default(0),
  currency: currencyColumn(),
  status: text("status", { enum: ORDER_ITEM_STATUSES }).notNull().default("pending"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  index("order_items_order_id_idx").on(table.orderId),
  index("order_items_store_id_idx").on(table.storeId),
  index("order_items_variant_id_idx").on(table.variantId),
  check("order_items_currency_length", sql`length(${table.currency}) = 3`),
  check("order_items_quantity_positive", sql`${table.quantity} > 0`),
  check("order_items_unit_amount_non_negative", sql`${table.unitAmountCents} >= 0`),
  check("order_items_line_total_non_negative", sql`${table.lineTotalAmountCents} >= 0`),
  check("order_items_line_total_matches_quantity", sql`${table.lineTotalAmountCents} = ${table.unitAmountCents} * ${table.quantity}`),
  check("order_items_status_check", enumCheck(table.status, ORDER_ITEM_STATUSES)),
]);