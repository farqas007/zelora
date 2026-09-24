import { and, asc, eq } from "drizzle-orm";
import type { LocalDatabase } from "../client";
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
 * Local (better-sqlite3) implementation of the cart repository.
 *
 * Even though better-sqlite3 is synchronous, the methods here still present
 * the async port contract so callers and tests are driver-agnostic and a
 * Cloudflare D1 implementation can satisfy the same interface.
 *
 * UNIQUE constraint failures on `carts.user_id` and
 * `cart_items (cart_id, variant_id)` are translated into the driver-neutral
 * `CART_EXISTS` / `CART_ITEM_EXISTS` results; anything else propagates
 * unchanged. No raw driver error is exposed as a conflict to callers.
 */
export function createLocalCartRepository(db: LocalDatabase): CartRepository {
  return {
    async getCartByUserId(userId): Promise<CartWithItemsRecord | null> {
      const cart = db.select().from(carts).where(eq(carts.userId, userId)).get();
      if (cart === undefined) {
        return null;
      }
      const items = db
        .select()
        .from(cartItems)
        .where(eq(cartItems.cartId, cart.id))
        .orderBy(asc(cartItems.createdAt), asc(cartItems.id))
        .all();
      return { cart, items };
    },

    async createCart(userId): Promise<CreateCartResult> {
      try {
        const cart = db.insert(carts).values({ userId }).returning().get();
        if (cart === undefined) {
          throw new Error("cart insert returned no row");
        }
        return { ok: true, cart };
      } catch (error) {
        if (isUserUniqueConflict(error)) {
          return { ok: false, reason: "CART_EXISTS" };
        }
        throw error;
      }
    },

    async addItem(input: AddCartItemInput): Promise<AddCartItemResult> {
      try {
        const item = db.insert(cartItems).values(input).returning().get();
        if (item === undefined) {
          throw new Error("cart item insert returned no row");
        }
        return { ok: true, item };
      } catch (error) {
        if (isItemUniqueConflict(error)) {
          return { ok: false, reason: "CART_ITEM_EXISTS" };
        }
        throw error;
      }
    },

    async updateItemQuantity(cartId, itemId, quantity): Promise<CartItemRecord | null> {
      return (
        db
          .update(cartItems)
          .set({ quantity })
          .where(and(eq(cartItems.cartId, cartId), eq(cartItems.id, itemId)))
          .returning()
          .get() ?? null
      );
    },

    async removeItem(cartId, itemId): Promise<boolean> {
      const result = db
        .delete(cartItems)
        .where(and(eq(cartItems.cartId, cartId), eq(cartItems.id, itemId)))
        .run();
      return result.changes > 0;
    },

    async clearCart(cartId): Promise<number> {
      const result = db.delete(cartItems).where(eq(cartItems.cartId, cartId)).run();
      return result.changes;
    },
  };
}

/**
 * True when the error is better-sqlite3's UNIQUE violation on `carts.user_id`
 * (the "one cart per user" backstop).
 */
function isUserUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: carts\.user_id/.test(error.message)
  );
}

/**
 * True when the error is better-sqlite3's UNIQUE violation on
 * `cart_items (cart_id, variant_id)` (the "one row per variant per cart"
 * backstop).
 */
function isItemUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: cart_items\.cart_id, cart_items\.variant_id/.test(error.message)
  );
}