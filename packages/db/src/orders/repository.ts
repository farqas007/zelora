import type { OrderAddressKind, OrderItemStatus, OrderStatus } from "../schema/enums";

/**
 * Async-first order repository port.
 *
 * Structural contract shared by the local better-sqlite3 implementation and
 * the Cloudflare D1 implementation. Every method is async so the same
 * interface drives both drivers (better-sqlite3 is synchronous; D1 is
 * promise-based). This module is deliberately dependency-free: it never
 * imports a database client, so edge/API runtimes can import the contract
 * without pulling in the Node-only SQLite stack.
 *
 * Identity is caller-supplied per call and never accepted from client input:
 * orders are created for (and later resolved by) the authenticated session's
 * user id.
 *
 * Order creation is atomic and inventory is decremented as part of the same
 * transaction/batch as the order rows. Stock is never *checked* separately:
 * each line is an unconditional `quantity - n` decrement guarded by the
 * `inventory_quantity_non_negative` CHECK constraint, so an undershoot aborts
 * the whole operation and surfaces as the driver-neutral
 * {@link CreateOrderConflictReason.INSUFFICIENT_STOCK} result — no partial
 * decrement, no order without lines, and no oversell even under concurrent
 * checkouts. A foreign-key violation on a line (the only FK reachable at
 * write time is a variant deleted in the race window after the sellability
 * read) surfaces as {@link CreateOrderConflictReason.VARIANT_NOT_FOUND}.
 *
 * Order rows are append-only: `createOrder` never updates or deletes a
 * previous order, and the schema's RESTRICT referential actions make orders
 * immortal.
 */

/** A persisted order row, mirroring the `orders` table. */
export interface OrderRecord {
  id: string;
  customerUserId: string;
  status: OrderStatus;
  currency: string;
  subtotalAmountCents: number;
  shippingAmountCents: number;
  discountAmountCents: number;
  totalAmountCents: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A persisted order-address snapshot, mirroring the `order_addresses` table. */
export interface OrderAddressRecord {
  id: string;
  orderId: string;
  kind: OrderAddressKind;
  recipientName: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A persisted order line, mirroring the `order_items` table. */
export interface OrderItemRecord {
  id: string;
  orderId: string;
  variantId: string;
  storeId: string;
  productName: string;
  variantName: string;
  sku: string | null;
  quantity: number;
  unitAmountCents: number;
  lineTotalAmountCents: number;
  currency: string;
  status: OrderItemStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** A single customer order with its saved addresses and lines. */
export interface OrderWithDetailsRecord {
  order: OrderRecord;
  addresses: OrderAddressRecord[];
  items: OrderItemRecord[];
}

/** A single customer order with its lines (list-page projection, no addresses). */
export interface OrderWithItemsRecord {
  order: OrderRecord;
  items: OrderItemRecord[];
}

export interface OrderListPage {
  items: OrderWithItemsRecord[];
  /** Opaque keyset cursor for the next page (`null` = last page). */
  nextCursor: string | null;
}

export interface OrderListQuery {
  limit: number;
  cursor: string | null;
}

/** One order-address row to insert; `kind` is validated against the schema enum. */
export interface CreateOrderAddressInput {
  kind: OrderAddressKind;
  recipientName: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
}

/**
 * One order line to insert. Name, SKU, unit price, store and currency are
 * snapshotted at checkout time (the caller resolves the live sellable variant
 * and copies these fields) so history is immutable even if catalog data
 * changes later.
 */
export interface CreateOrderLineInput {
  variantId: string;
  storeId: string;
  productName: string;
  variantName: string;
  sku: string | null;
  quantity: number;
  unitAmountCents: number;
  lineTotalAmountCents: number;
  currency: string;
}

/**
 * Everything required to place one order. The caller is responsible for
 * recomputing and approving the monetary columns from live catalog prices —
 * the repository persists what it is given and never trusts the client
 * directly.
 *
 * Precondition: `addresses` and `lines` must each be non-empty. The service
 * guarantees that (a checkout always carries a shipping snapshot and at least
 * one line); a caller violating it gets an error rather than a half-written
 * order.
 */
export interface CreateOrderInput {
  customerUserId: string;
  currency: string;
  subtotalAmountCents: number;
  shippingAmountCents: number;
  discountAmountCents: number;
  totalAmountCents: number;
  addresses: CreateOrderAddressInput[];
  lines: CreateOrderLineInput[];
}

/**
 * Driver-neutral conflicts createOrder can surface. These are the race-window
 * backstops behind the sellability/lock step the service already performs; the
 * single atomic write reports them so the service never inspects raw
 * SQLite/D1 errors.
 */
export type CreateOrderConflictReason = "INSUFFICIENT_STOCK" | "VARIANT_NOT_FOUND";

export type CreateOrderResult =
  | { ok: true; order: OrderRecord; addresses: OrderAddressRecord[]; items: OrderItemRecord[] }
  | { ok: false; reason: CreateOrderConflictReason };

export interface OrderRepository {
  /**
   * Atomically decrement inventory and write the order, its address snapshots
   * and its lines. On a stock undershoot or a missing variant the entire
   * operation rolls back and a conflict reason is returned; no order is ever
   * left behind.
   */
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  /**
   * Resolve one customer's order with its addresses and lines, or `null`.
   * Scoped to the customer: another customer's order id resolves to `null`.
   */
  findByIdForCustomer(customerUserId: string, orderId: string): Promise<OrderWithDetailsRecord | null>;
  /**
   * Keyset-paginated list of one customer's orders, newest first
   * (`(createdAt, id)` descending) so the cursor stays stable as new orders
   * arrive. A malformed/unknown cursor yields an empty page
   * (`nextCursor: null`).
   */
  listByCustomer(customerUserId: string, opts: OrderListQuery): Promise<OrderListPage>;
}