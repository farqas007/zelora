import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { createId } from "../ids";
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
 * Local (better-sqlite3) implementation of the order repository.
 *
 * Order creation is one database transaction: every line's inventory is
 * decremented unconditionally and the inventory `CHECK (quantity >= 0)`
 * constraint is the stock guard — if any line would drive a variant negative,
 * SQLite aborts the whole transaction before the order, address or line rows
 * are written, and the conflict is surfaced as the driver-neutral
 * {@link CreateOrderConflictReason} result. This keeps local behavior byte
 * identical to the D1 twin, which cannot inspect intermediate `batch()`
 * results and relies on the same CHECK instead.
 */
export function createLocalOrderRepository(db: LocalDatabase): OrderRepository {
  return {
    async createOrder(input) {
      try {
        const orderId = createId();
        const now = new Date();

        const created = db.transaction((tx) => {
          // Reserve stock. The decrement is unconditional so the CHECK is the
          // whole safety net: an undershoot raises here, inside the
          // transaction, rolling back every row this function writes.
          for (const line of input.lines) {
            tx.update(inventory)
              .set({
                quantity: sql`${inventory.quantity} - ${line.quantity}`,
                updatedAt: now,
              })
              .where(eq(inventory.variantId, line.variantId))
              .run();
          }

          const order = tx
            .insert(orders)
            .values({
              id: orderId,
              customerUserId: input.customerUserId,
              status: "pending",
              currency: input.currency,
              subtotalAmountCents: input.subtotalAmountCents,
              shippingAmountCents: input.shippingAmountCents,
              discountAmountCents: input.discountAmountCents,
              totalAmountCents: input.totalAmountCents,
            })
            .returning()
            .get();
          if (order === undefined) {
            throw new Error("order insert returned no row");
          }

          const addresses = tx
            .insert(orderAddresses)
            .values(input.addresses.map((address) => ({ ...address, orderId: order.id })))
            .returning()
            .all();

          const items = tx
            .insert(orderItems)
            .values(input.lines.map((line) => ({ ...line, orderId: order.id, status: "pending" as const })))
            .returning()
            .all();

          return { order, addresses, items };
        });

        return { ok: true, ...created };
      } catch (error) {
        const reason = mapCreateOrderConflict(error);
        if (reason !== null) {
          return { ok: false, reason };
        }
        throw error;
      }
    },

    async findByIdForCustomer(customerUserId, orderId) {
      const order = db
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.customerUserId, customerUserId)))
        .get();
      if (order === undefined) {
        return null;
      }

      const [addresses, items] = loadOrderDetails(db, order.id);
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
export function loadOrderDetails(
  db: LocalDatabase,
  orderId: string,
): [OrderAddressRecord[], OrderItemRecord[]] {
  const addresses = db
    .select()
    .from(orderAddresses)
    .where(eq(orderAddresses.orderId, orderId))
    .orderBy(orderAddresses.kind)
    .all();
  const items = db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id))
    .all();
  return [addresses, items];
}

/**
 * Keyset-paginated customer order index (newest first), with each page order's
 * lines merged in process memory — the same discard-shape the catalog and
 * seller pages use, so it is portable to D1.
 */
function listOrderPage(db: LocalDatabase, customerUserId: string, query: OrderListQuery): OrderListPage {
  const start = query.cursor === null ? null : decodeOrderCursor(query.cursor);
  if (query.cursor !== null && start === null) {
    return { items: [], nextCursor: null };
  }

  const rows = db
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
    .limit(query.limit + 1)
    .all();

  const pageRows = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  if (pageRows.length === 0) {
    return { items: [], nextCursor: null };
  }

  const linesByOrder = itemsByOrderId(db, pageRows.map((row) => row.id));
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

/**
 * All lines for the given order ids, grouped by order id in read order.
 */
function itemsByOrderId(db: LocalDatabase, orderIds: string[]): Map<string, OrderItemRecord[]> {
  const rows = db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id))
    .all();
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