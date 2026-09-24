import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { isValidId } from "../ids";
import * as schema from "../schema";
import { createLocalCartRepository } from "../cart/local-repository";
import { createTestDatabase, expectConstraintError } from "./helpers";
import { createChain } from "./fixtures";

/**
 * Real-SQLite integration tests for the cart repository and its schema
 * constraints. Each test uses an isolated in-memory database with the
 * committed migrations applied (foreign keys ON), matching the Cloudflare D1
 * runtime behavior.
 */

let cartUserSeq = 0;

function insertCustomer(db: LocalDatabase): string {
  cartUserSeq += 1;
  return db
    .insert(schema.users)
    .values({ email: `cart-user-${cartUserSeq}@example.test`, name: "Cart Customer" })
    .returning({ id: schema.users.id })
    .get().id;
}

/** Chain gives a real variant to reference. */
function seeded(): LocalDatabase {
  return createTestDatabase().db;
}

describe("cart schema constraints", () => {
  it("enforces one cart per user via the unique user_id index", () => {
    const db = seeded();
    const userId = insertCustomer(db);

    db.insert(schema.carts).values({ userId }).run();

    expectConstraintError(
      () => db.insert(schema.carts).values({ userId }).run(),
      /UNIQUE constraint failed: carts\.user_id/,
    );
  });

  it("rejects a cart referencing a missing user (FK)", () => {
    const db = seeded();
    expectConstraintError(
      () => db.insert(schema.carts).values({ userId: "00000000-0000-0000-0000-000000000000" }).run(),
      /FOREIGN KEY constraint failed/,
    );
  });

  it("enforces the (cart_id, variant_id) uniqueness per cart item", () => {
    const db = seeded();
    const chain = createChain(db);
    const cartId = db.insert(schema.carts).values({ userId: chain.customerUserId })
      .returning({ id: schema.carts.id })
      .get().id;

    db.insert(schema.cartItems).values({ cartId, variantId: chain.cameraVariantId, quantity: 1 }).run();

    expectConstraintError(
      () => db.insert(schema.cartItems).values({ cartId, variantId: chain.cameraVariantId, quantity: 2 }).run(),
      /UNIQUE constraint failed: cart_items\.cart_id, cart_items\.variant_id/,
    );

    // A different variant in the same cart is fine.
    db.insert(schema.cartItems).values({ cartId, variantId: chain.lensVariantId, quantity: 1 }).run();
  });

  it("rejects zero and negative quantities (CHECK)", () => {
    const db = seeded();
    const chain = createChain(db);
    const cartId = db.insert(schema.carts).values({ userId: chain.customerUserId })
      .returning({ id: schema.carts.id })
      .get().id;

    expectConstraintError(
      () => db.insert(schema.cartItems).values({ cartId, variantId: chain.cameraVariantId, quantity: 0 }).run(),
      /CHECK constraint failed: cart_items_quantity_positive/,
    );
    expectConstraintError(
      () => db.insert(schema.cartItems).values({ cartId, variantId: chain.cameraVariantId, quantity: -1 }).run(),
      /CHECK constraint failed: cart_items_quantity_positive/,
    );
  });

  it("rejects a cart item referencing a missing cart or variant (FK)", () => {
    const db = seeded();
    const chain = createChain(db);
    const cartId = db.insert(schema.carts).values({ userId: chain.customerUserId })
      .returning({ id: schema.carts.id })
      .get().id;

    expectConstraintError(
      () => db.insert(schema.cartItems).values({ cartId: "00000000-0000-0000-0000-000000000000", variantId: chain.cameraVariantId, quantity: 1 }).run(),
      /FOREIGN KEY constraint failed/,
    );
    expectConstraintError(
      () => db.insert(schema.cartItems).values({ cartId, variantId: "00000000-0000-0000-0000-000000000000", quantity: 1 }).run(),
      /FOREIGN KEY constraint failed/,
    );
  });

  it("cascades cart deletion through its items", () => {
    const db = seeded();
    const chain = createChain(db);
    const cartId = db.insert(schema.carts).values({ userId: chain.customerUserId })
      .returning({ id: schema.carts.id })
      .get().id;
    db.insert(schema.cartItems).values({ cartId, variantId: chain.cameraVariantId, quantity: 1 }).run();

    db.delete(schema.carts).where(eq(schema.carts.id, cartId)).run();

    const items = db.select().from(schema.cartItems).all();
    expect(items).toHaveLength(0);
  });

  it("cascades user deletion through the cart and its items", () => {
    const db = seeded();
    const chain = createChain(db);
    const cartId = db.insert(schema.carts).values({ userId: chain.customerUserId })
      .returning({ id: schema.carts.id })
      .get().id;
    db.insert(schema.cartItems).values({ cartId, variantId: chain.cameraVariantId, quantity: 2 }).run();

    db.delete(schema.users).where(eq(schema.users.id, chain.customerUserId)).run();

    expect(db.select().from(schema.carts).all()).toHaveLength(0);
    expect(db.select().from(schema.cartItems).all()).toHaveLength(0);
  });

  it("cascades variant deletion through cart items", () => {
    const db = seeded();
    const chain = createChain(db);
    const cartId = db.insert(schema.carts).values({ userId: chain.customerUserId })
      .returning({ id: schema.carts.id })
      .get().id;
    db.insert(schema.cartItems).values({ cartId, variantId: chain.cameraVariantId, quantity: 1 }).run();

    db.delete(schema.productVariants).where(eq(schema.productVariants.id, chain.cameraVariantId)).run();

    expect(db.select().from(schema.cartItems).all()).toHaveLength(0);
    expect(db.select().from(schema.carts).all()).toHaveLength(1);
  });
});

describe("cart repository", () => {
  it("returns null for a user with no cart, then creates one with the user bound", async () => {
    const db = seeded();
    const userId = insertCustomer(db);
    const repo = createLocalCartRepository(db);

    expect(await repo.getCartByUserId(userId)).toBeNull();

    const result = await repo.createCart(userId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a successful cart creation");
    }

    expect(isValidId(result.cart.id)).toBe(true);
    expect(result.cart.userId).toBe(userId);

    const resolved = await repo.getCartByUserId(userId);
    expect(resolved?.cart.id).toBe(result.cart.id);
    expect(resolved?.items).toEqual([]);
  });

  it("reports a concurrent duplicate create as CART_EXISTS without corrupting the row", async () => {
    const db = seeded();
    const userId = insertCustomer(db);
    const repo = createLocalCartRepository(db);

    const first = await repo.createCart(userId);
    expect(first.ok).toBe(true);

    const second = await repo.createCart(userId);
    expect(second).toEqual({ ok: false, reason: "CART_EXISTS" });
  });

  it("adds items to a cart and resolves them in insertion order", async () => {
    const db = seeded();
    const chain = createChain(db);
    const repo = createLocalCartRepository(db);

    const created = await repo.createCart(chain.customerUserId);
    if (!created.ok) {
      throw new Error("expected a successful cart creation");
    }
    const cartId = created.cart.id;

    const camera = await repo.addItem({ cartId, variantId: chain.cameraVariantId, quantity: 2 });
    expect(camera.ok).toBe(true);
    if (!camera.ok) {
      throw new Error("expected a successful item insert");
    }
    expect(isValidId(camera.item.id)).toBe(true);
    expect(camera.item.cartId).toBe(cartId);
    expect(camera.item.variantId).toBe(chain.cameraVariantId);
    expect(camera.item.quantity).toBe(2);

    const lens = await repo.addItem({ cartId, variantId: chain.lensVariantId, quantity: 1 });
    expect(lens.ok).toBe(true);

    const resolved = await repo.getCartByUserId(chain.customerUserId);
    expect(resolved?.items.map((i) => i.variantId)).toEqual([chain.cameraVariantId, chain.lensVariantId]);
  });

  it("reports a duplicate (cart, variant) insert as CART_ITEM_EXISTS", async () => {
    const db = seeded();
    const chain = createChain(db);
    const repo = createLocalCartRepository(db);

    const created = await repo.createCart(chain.customerUserId);
    if (!created.ok) {
      throw new Error("expected a successful cart creation");
    }

    expect((await repo.addItem({ cartId: created.cart.id, variantId: chain.cameraVariantId, quantity: 1 })).ok).toBe(true);
    const duplicate = await repo.addItem({ cartId: created.cart.id, variantId: chain.cameraVariantId, quantity: 5 });
    expect(duplicate).toEqual({ ok: false, reason: "CART_ITEM_EXISTS" });
  });

  it("updates an item's quantity scoped to its cart, returning null for others", async () => {
    const db = seeded();
    const chain = createChain(db);
    const repo = createLocalCartRepository(db);

    const customerCart = await repo.createCart(chain.customerUserId);
    const sellerCart = await repo.createCart(chain.sellerAUserId);
    if (!customerCart.ok || !sellerCart.ok) {
      throw new Error("expected successful cart creations");
    }

    const item = await repo.addItem({ cartId: customerCart.cart.id, variantId: chain.cameraVariantId, quantity: 1 });
    if (!item.ok) {
      throw new Error("expected a successful item insert");
    }

    const updated = await repo.updateItemQuantity(customerCart.cart.id, item.item.id, 9);
    expect(updated?.quantity).toBe(9);

    // Same item id addressed through another user's cart is a miss.
    expect(await repo.updateItemQuantity(sellerCart.cart.id, item.item.id, 3)).toBeNull();
    expect(await repo.updateItemQuantity(customerCart.cart.id, "00000000-0000-0000-0000-000000000000", 3)).toBeNull();
  });

  it("removes an item only from its owning cart", async () => {
    const db = seeded();
    const chain = createChain(db);
    const repo = createLocalCartRepository(db);

    const customerCart = await repo.createCart(chain.customerUserId);
    const otherCart = await repo.createCart(chain.sellerAUserId);
    if (!customerCart.ok || !otherCart.ok) {
      throw new Error("expected successful cart creations");
    }

    const item = await repo.addItem({ cartId: customerCart.cart.id, variantId: chain.cameraVariantId, quantity: 1 });
    if (!item.ok) {
      throw new Error("expected a successful item insert");
    }

    expect(await repo.removeItem(otherCart.cart.id, item.item.id)).toBe(false);
    expect(await repo.removeItem(customerCart.cart.id, "00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(await repo.removeItem(customerCart.cart.id, item.item.id)).toBe(true);

    const resolved = await repo.getCartByUserId(chain.customerUserId);
    expect(resolved?.items).toEqual([]);
  });

  it("clears every item but keeps the cart row", async () => {
    const db = seeded();
    const chain = createChain(db);
    const repo = createLocalCartRepository(db);

    const created = await repo.createCart(chain.customerUserId);
    if (!created.ok) {
      throw new Error("expected a successful cart creation");
    }
    await repo.addItem({ cartId: created.cart.id, variantId: chain.cameraVariantId, quantity: 1 });
    await repo.addItem({ cartId: created.cart.id, variantId: chain.lensVariantId, quantity: 2 });

    expect(await repo.clearCart(created.cart.id)).toBe(2);

    const resolved = await repo.getCartByUserId(chain.customerUserId);
    expect(resolved?.cart.id).toBe(created.cart.id);
    expect(resolved?.items).toEqual([]);

    // Clearing an empty cart is idempotent.
    expect(await repo.clearCart(created.cart.id)).toBe(0);
  });
});