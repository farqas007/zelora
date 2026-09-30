import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { IDEMPOTENCY_FINGERPRINT_HEX_LENGTH, IDEMPOTENCY_KEY_LIMITS } from "@zelora/shared";
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
 *
 * Checkout is idempotent, and the two idempotency columns are how. The client
 * generates `idempotency_key`; the API records the `idempotency_fingerprint` it
 * derived from the authenticated customer plus the normalized addresses of that
 * request. Replaying the key returns the original order; replaying it with a
 * different fingerprint is refused.
 *
 * The key lives on `orders` rather than in a separate idempotency table because
 * that makes the guarantee transactional for free: the key is consumed by the
 * very same insert (inside the same local transaction / the same D1 batch) that
 * decrements stock. A failed checkout rolls the key back with it, so a retry
 * that follows a real failure is not mistaken for a replay, and a checkout that
 * committed can never be lost.
 *
 * The uniqueness is per customer, not global. A shared `(customer_user_id,
 * idempotency_key)` means two customers may legitimately pick the same key
 * (their generators can collide, and guessing another's key is trivial if the
 * key alone were the lookup), each gets their own order, and neither can ever
 * observe or replay the other's.
 *
 * Orders that predate this migration are backfilled with their own id as the
 * key and an all-zero fingerprint. The zeroes are not a reachable SHA-256
 * output, so such a row can only ever answer "conflict" and never replays an
 * order that did not exist when the key was sent.
 *
 * Migration 0008 adds both columns to the live `orders` table rather than
 * recreating it, because `order_items` and `order_addresses` reference it with
 * `ON DELETE RESTRICT` and dropping it fails on a populated database. The
 * `notNull()` declarations below are therefore true of every row but are
 * enforced by BEFORE INSERT/UPDATE triggers rather than by a column flag: SQLite
 * cannot add `NOT NULL` to an existing column without rebuilding the table. The
 * length CHECKs are added inline with the columns, so they are real table
 * constraints under exactly the names declared here. See the migration file for
 * the full rationale.
 */

export const orders = sqliteTable("orders", {
  id: idColumn(),
  customerUserId: text("customer_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(),
  idempotencyFingerprint: text("idempotency_fingerprint").notNull(),
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
  unique("orders_customer_idempotency_key_unique").on(table.customerUserId, table.idempotencyKey),
  check("orders_currency_length", sql`length(${table.currency}) = 3`),
  check("orders_idempotency_key_length", sql`length(${table.idempotencyKey}) between ${IDEMPOTENCY_KEY_LIMITS.minLength} and ${IDEMPOTENCY_KEY_LIMITS.maxLength}`),
  check("orders_idempotency_fingerprint_length", sql`length(${table.idempotencyFingerprint}) = ${IDEMPOTENCY_FINGERPRINT_HEX_LENGTH}`),
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