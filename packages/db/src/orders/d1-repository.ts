import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { createId } from "../ids";
import { cartItems } from "../schema/cart";
import { inventory } from "../schema/catalog";
import { orderAddresses, orderItems, orders } from "../schema/orders";
import { mapCreateOrderConflict } from "./conflicts";
import { decodeOrderCursor, encodeOrderCursor } from "./cursor";
import type {
  OrderAddressRecord,
  OrderItemRecord,
  OrderListPage,
  OrderListQuery,
  OrderRepository,
  OrderWithItemsRecord,
} from "./repository";

/**
 * Cloudflare D1 implementation of the order repository.
 *
 * Concrete implementation of {@link OrderRepository} against the Drizzle D1
 * client created by {@link createD1Client}. Mirrors the local better-sqlite3
 * contract. D1 rejects raw `BEGIN` statements, so Drizzle's driver-level
 * `db.transaction()` fails at runtime; D1's native atomic primitive is
 * `batch()`, and every statement in the batch commits or rolls back as one
 * unit. The inventory decrement is therefore an unconditional statement in the
 * same batch as the order/address/line inserts, and the inventory
 * `CHECK (quantity >= 0)` constraint is the stock guard: if any line would
 * drive a variant negative the whole batch rolls back and the conflict is
 * surfaced as the driver-neutral {@link CreateOrderConflictReason} result.
 *
 * The purchased cart is emptied by a `DELETE` statement in that same batch,
 * which is D1's only way to make the three writes share a commit point —
 * there is no transaction to defer it to. A batch that aborts on stock, a
 * missing variant or a taken idempotency key therefore leaves the cart exactly
 * as it was, so the shopper can fix the problem and retry with the same key.
 *
 * The idempotency key travels in the order insert statement of that same batch,
 * which is what gives D1 the same guarantee the local transaction has: the key
 * is committed with the order and nothing else, and a rolled-back batch leaves
 * it free. Two checkouts that race on the same `(customer, key)` are separated
 * by the unique index — the loser's whole batch is rejected and reported as
 * {@link CreateOrderConflictReason.DUPLICATE_IDEMPOTENCY_KEY}, cart delete
 * included, so the winner's checkout is the only one that empties the cart.
 *
 * Worker-safe: only the Drizzle D1 driver and the order contract are imported
 * (conflict mapping lives in a pure, driver-free module); the Node-only
 * SQLite stack is never pulled into the Worker bundle.
 */
export function createD1OrderRepository(
  db: DrizzleD1Database<DatabaseSchema>,
): OrderRepository {
  return {
    async createOrder(input) {
      try {
        const orderId = createId();
        const now = new Date();

        // Ids are generated client-side (UUIDv7) so the address and line rows
        // can reference the order id before any statement runs. The fixed lead
        // of the batch keeps the tuple typing tractable; a stock undershoot or
        // missing variant aborts the whole batch before it commits.
        const [orderRows, addressRows, itemRows, ...mutationResults] = await db.batch([
          db
            .insert(orders)
            .values({
              id: orderId,
              customerUserId: input.customerUserId,
              idempotencyKey: input.idempotencyKey,
              idempotencyFingerprint: input.idempotencyFingerprint,
              status: "pending",
              currency: input.currency,
              subtotalAmountCents: input.subtotalAmountCents,
              shippingAmountCents: input.shippingAmountCents,
              discountAmountCents: input.discountAmountCents,
              totalAmountCents: input.totalAmountCents,
            })
            .returning(),
          db
            .insert(orderAddresses)
            .values(input.addresses.map((address) => ({ ...address, orderId })))
            .returning(),
          db
            .insert(orderItems)
            .values(input.lines.map((line) => ({ ...line, orderId, status: "pending" as const })))
            .returning(),
          ...input.lines.map((line) =>
            db
              .update(inventory)
              .set({
                quantity: sql`${inventory.quantity} - ${line.quantity}`,
                updatedAt: now,
              })
              .where(eq(inventory.variantId, line.variantId)),
          ),
          // Emptying the purchased cart is the last statement of the same
          // batch, so it commits with the order and the stock decrement or not
          // at all. A `null` cart id (an order not sourced from a cart) simply
          // contributes no statement, keeping the batch's shape a pure function
          // of the input.
          ...(input.clearCartId === null
            ? []
            : [db.delete(cartItems).where(eq(cartItems.cartId, input.clearCartId))]),
        ]);

        const order = orderRows[0];
        if (order === undefined) {
          throw new Error("order insert returned no row");
        }
        // Referenced to keep the tuple-deconstruction honest: the decrement and
        // cart-clear results carry per-statement D1 write metas, whose
        // change-count parity with the input is not required to inspect.
        void mutationResults;

        return { ok: true, order, addresses: addressRows, items: itemRows };
      } catch (error) {
        const reason = mapCreateOrderConflict(error);
        if (reason !== null) {
          return { ok: false, reason };
        }
        throw error;
      }
    },

    async findByIdempotencyKeyForCustomer(customerUserId, idempotencyKey) {
      const order = await db
        .select()
        .from(orders)
        .where(and(eq(orders.customerUserId, customerUserId), eq(orders.idempotencyKey, idempotencyKey)))
        .get();
      if (order === undefined) {
        return null;
      }

      const [addresses, items] = await loadOrderDetails(db, order.id);
      return { order, addresses, items };
    },

    async findByIdForCustomer(customerUserId, orderId) {
      const order = await db
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.customerUserId, customerUserId)))
        .get();
      if (order === undefined) {
        return null;
      }

      const [addresses, items] = await loadOrderDetails(db, order.id);
      return { order, addresses, items };
    },

    async listByCustomer(customerUserId, query) {
      return listOrderPage(db, customerUserId, query);
    },
  };
}

/**
 * Addresses and lines for one order, in stable display order (addresses by
 * kind, lines by `(createdAt, id)`).
 */
async function loadOrderDetails(
  db: DrizzleD1Database<DatabaseSchema>,
  orderId: string,
): Promise<[OrderAddressRecord[], OrderItemRecord[]]> {
  const [addresses, items] = await Promise.all([
    db
      .select()
      .from(orderAddresses)
      .where(eq(orderAddresses.orderId, orderId))
      .orderBy(orderAddresses.kind),
    db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.createdAt), asc(orderItems.id)),
  ]);
  return [addresses, items];
}

/**
 * Keyset-paginated customer order index (newest first), with each page order's
 * lines merged in process memory — the same shape the local twin uses.
 */
async function listOrderPage(
  db: DrizzleD1Database<DatabaseSchema>,
  customerUserId: string,
  query: OrderListQuery,
): Promise<OrderListPage> {
  const start = query.cursor === null ? null : decodeOrderCursor(query.cursor);
  if (query.cursor !== null && start === null) {
    return { items: [], nextCursor: null };
  }

  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.customerUserId, customerUserId),
        start === null
          ? undefined
          : or(
              lt(orders.createdAt, start.createdAt),
              and(eq(orders.createdAt, start.createdAt), lt(orders.id, start.id)),
            ),
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(query.limit + 1);

  const pageRows = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  if (pageRows.length === 0) {
    return { items: [], nextCursor: null };
  }

  const linesByOrder = await itemsByOrderId(db, pageRows.map((row) => row.id));
  const items: OrderWithItemsRecord[] = pageRows.map((row) => ({
    order: row,
    items: linesByOrder.get(row.id) ?? [],
  }));

  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last !== undefined
        ? encodeOrderCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

/** All lines for the given order ids, grouped by order id in read order. */
async function itemsByOrderId(
  db: DrizzleD1Database<DatabaseSchema>,
  orderIds: string[],
): Promise<Map<string, OrderItemRecord[]>> {
  const rows = await db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const grouped = new Map<string, OrderItemRecord[]>();
  for (const row of rows) {
    const list = grouped.get(row.orderId);
    if (list === undefined) {
      grouped.set(row.orderId, [row]);
    } else {
      list.push(row);
    }
  }
  return grouped;
}