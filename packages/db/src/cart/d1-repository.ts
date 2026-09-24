import { and, asc, eq } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { createId } from "../ids";
import { cartItems, carts } from "../schema/cart";
import type {
  AddCartItemInput,
  AddCartItemResult,
  CartItemRecord,
  CartRepository,
  CartWithItemsRecord,
  CreateCartResult,
} from "./repository";

/**
 * Cloudflare D1 implementation of the cart repository.
 *
 * Concrete implementation of {@link CartRepository} against the Drizzle D1
 * client created by {@link createD1Client}. Mirrors the local better-sqlite3
 * contract: reads resolve to `null` when unknown, rejects duplicate rows via
 * the driver-neutral `CART_EXISTS` / `CART_ITEM_EXISTS` results, and never
 * exposes a raw driver error as a conflict. Carts are single-row writes and
 * item mutations are single statements, so D1's `batch()` constraint does not
 * apply here.
 *
 * Worker-safe: only the Drizzle D1 driver and the cart contract are imported;
 * the Node-only SQLite stack is never pulled into the Worker bundle.
 */
export function createD1CartRepository(
  db: DrizzleD1Database<DatabaseSchema>,
): CartRepository {
  return {
    async getCartByUserId(userId): Promise<CartWithItemsRecord | null> {
      const cart = await db.select().from(carts).where(eq(carts.userId, userId)).get();
      if (cart === undefined) {
        return null;
      }
      const items = await db
        .select()
        .from(cartItems)
        .where(eq(cartItems.cartId, cart.id))
        .orderBy(asc(cartItems.createdAt), asc(cartItems.id))
        .all();
      return { cart, items };
    },

    async createCart(userId): Promise<CreateCartResult> {
      try {
        // Id is generated client-side (UUIDv7) so the row exists independently
        // of the driver — mirrors the local insert's `$defaultFn`.
        const cart = await db
          .insert(carts)
          .values({ id: createId(), userId })
          .returning();
        const row = cart[0];
        if (row === undefined) {
          throw new Error("cart insert returned no row");
        }
        return { ok: true, cart: row };
      } catch (error) {
        if (mapD1CartConflict(error, "USER") !== null) {
          return { ok: false, reason: "CART_EXISTS" };
        }
        throw error;
      }
    },

    async addItem(input: AddCartItemInput): Promise<AddCartItemResult> {
      try {
        const item = await db
          .insert(cartItems)
          .values({ ...input, id: createId() })
          .returning();
        const row = item[0];
        if (row === undefined) {
          throw new Error("cart item insert returned no row");
        }
        return { ok: true, item: row };
      } catch (error) {
        if (mapD1CartConflict(error, "ITEM") !== null) {
          return { ok: false, reason: "CART_ITEM_EXISTS" };
        }
        throw error;
      }
    },

    async updateItemQuantity(cartId, itemId, quantity): Promise<CartItemRecord | null> {
      const rows = await db
        .update(cartItems)
        .set({ quantity, updatedAt: new Date() })
        .where(and(eq(cartItems.cartId, cartId), eq(cartItems.id, itemId)))
        .returning();
      return rows[0] ?? null;
    },

    async removeItem(cartId, itemId): Promise<boolean> {
      const result = await db
        .delete(cartItems)
        .where(and(eq(cartItems.cartId, cartId), eq(cartItems.id, itemId)))
        .returning({ id: cartItems.id });
      return result.length > 0;
    },

    async clearCart(cartId): Promise<number> {
      const result = await db
        .delete(cartItems)
        .where(eq(cartItems.cartId, cartId))
        .returning({ id: cartItems.id });
      return result.length;
    },
  };
}

/**
 * Which UNIQUE index a cart conflict can have hit. The unique constraints
 * remain the race-condition backstop; these names drive the mapping.
 */
type CartConflictKind = "USER" | "ITEM";

const CONFLICT_TABLE_COLUMNS: Readonly<Record<string, CartConflictKind>> = {
  "carts.user_id": "USER",
  "cart_items.cart_id": "ITEM",
  "cart_items.variant_id": "ITEM",
};

/**
 * SQLite emits the conflict text as `UNIQUE constraint failed: <table>.<column>`.
 * D1 wraps it as `D1_ERROR: <sqlite text>: SQLITE_CONSTRAINT_UNIQUE`, and
 * Drizzle forwards the driver error verbatim. The compound
 * `cart_items (cart_id, variant_id)` constraint is reported one column at a
 * time, so either table.column token maps back to `ITEM`. This matcher
 * extracts the token from any of those shapes; `null` means unrelated.
 */
const UNIQUE_CONFLICT_PATTERN = /UNIQUE constraint failed:\s+([a-z0-9_]+)\.([a-z0-9_]+)/i;

/**
 * Pure and exported for tests. Translation of a D1/Drizzle UNIQUE constraint
 * failure into the cart conflict kind, sweeping up to three `cause` nesting
 * levels to tolerate wrapper prefixes (`D1_ERROR:`), trailing
 * `: SQLITE_CONSTRAINT_UNIQUE` codes and cross-realm error objects. Unrelated
 * failures return `null` and propagate unchanged.
 */
export function mapD1CartConflict(error: unknown, expected: CartConflictKind): CartConflictKind | null {
  for (const message of collectErrorMessages(error)) {
    const match = UNIQUE_CONFLICT_PATTERN.exec(message);
    if (match === null) {
      continue;
    }
    const table = match[1]?.toLowerCase();
    const column = match[2]?.toLowerCase();
    const kind = CONFLICT_TABLE_COLUMNS[`${table}.${column}`];
    if (kind === expected) {
      return kind;
    }
  }
  return null;
}

/**
 * Collect non-empty error messages across up to three levels of `cause`
 * nesting, tolerating plain objects (D1 errors can cross realm boundaries
 * where `instanceof Error` is unreliable) and bare strings. Mirrors the
 * seller repository's collector so both drivers agree on conflict shapes.
 */
function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== null && current !== undefined; depth++) {
    if (typeof current === "string" && current !== "") {
      messages.push(current);
    } else if (typeof current === "object") {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string" && message !== "") {
        messages.push(message);
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return messages;
}