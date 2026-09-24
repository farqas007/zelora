/**
 * Async-first shopping-cart repository port.
 *
 * Structural contract shared by the local better-sqlite3 implementation and
 * the Cloudflare D1 implementation. Every method is async so the same
 * interface drives both drivers (better-sqlite3 is synchronous; D1 is
 * promise-based). This module is deliberately dependency-free: it never
 * imports a database client, so edge/API runtimes can import the contract
 * without pulling in the Node-only SQLite stack.
 *
 * Identity is caller-supplied per call and never accepted from client input:
 * carts are always resolved by the authenticated session's user id, and item
 * operations always scope to that user's cart id.
 *
 * One cart row exists per user (the UNIQUE on `user_id` is the race-condition
 * backstop). Item inserts translate the `cart_items (cart_id, variant_id)`
 * UNIQUE into a driver-neutral result so callers never inspect raw
 * SQLite/D1 errors. Items are pure variant references + positive quantities;
 * no pricing is stored or read here.
 */

/** A persisted cart row, mirroring the `carts` table. */
export interface CartRecord {
  id: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A persisted cart item row, mirroring the `cart_items` table. */
export interface CartItemRecord {
  id: string;
  cartId: string;
  variantId: string;
  quantity: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A cart plus its items, the shape returned by cart reads. */
export interface CartWithItemsRecord {
  cart: CartRecord;
  items: CartItemRecord[];
}

/** What a cart item insert needs. `variantId` must already exist. */
export interface AddCartItemInput {
  cartId: string;
  variantId: string;
  quantity: number;
}

/**
 * Driver-neutral result of {@link CartRepository.createCart}: the UNIQUE on
 * `carts.user_id` means the second concurrent get-or-create loses and is told
 * the cart already exists.
 */
export type CreateCartResult =
  | { ok: true; cart: CartRecord }
  | { ok: false; reason: "CART_EXISTS" };

/**
 * Driver-neutral result of {@link CartRepository.addItem}: when the variant
 * is already in the cart, callers are expected to update its quantity instead
 * of trying to insert a duplicate row.
 */
export type AddCartItemResult =
  | { ok: true; item: CartItemRecord }
  | { ok: false; reason: "CART_ITEM_EXISTS" };

export interface CartRepository {
  /** Resolve a user's cart and its items, or `null` when the user has none. */
  getCartByUserId(userId: string): Promise<CartWithItemsRecord | null>;
  /** Create a cart row for a user. Fails with `CART_EXISTS` on a concurrent duplicate. */
  createCart(userId: string): Promise<CreateCartResult>;
  /** Add an item to a cart. Fails with `CART_ITEM_EXISTS` when the variant is already present. */
  addItem(input: AddCartItemInput): Promise<AddCartItemResult>;
  /** Overwrite an item's quantity within the owning cart; `null` when the item is not in the cart. */
  updateItemQuantity(cartId: string, itemId: string, quantity: number): Promise<CartItemRecord | null>;
  /** Remove an item from the owning cart. Returns `false` when the item is not in the cart. */
  removeItem(cartId: string, itemId: string): Promise<boolean>;
  /** Delete every item in the cart (the cart row is kept). Returns the number of rows deleted. */
  clearCart(cartId: string): Promise<number>;
}