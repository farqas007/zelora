import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createTestDatabase } from "./helpers";
import { createChain, type Chain } from "./fixtures";
import { createLocalCartRepository } from "../cart/local-repository";
import { createLocalOrderRepository } from "../orders/local-repository";
import { createId } from "../ids";
import type { CreateOrderInput } from "../orders/repository";

/**
 * Local (better-sqlite3) order repository tests.
 *
 * These exercise the transaction-level contract: order creation is atomic and
 * inventory is decremented in the same transaction, so a stock undershoot or a
 * missing variant rolls the whole operation back and surfaces as a
 * driver-neutral conflict. The real D1 behaviour of `createOrder` (batch
 * atomicity + the same CHECK guard) is covered in the Miniflare integration
 * suite; the D1-style message shapes of {@link mapCreateOrderConflict} are
 * covered in `orders-d1-conflicts.test.ts`.
 */

function addAddresses(input: CreateOrderInput, recipientName: string): CreateOrderInput {
  return {
    ...input,
    addresses: [
      { kind: "shipping", recipientName, phone: null, line1: "1 Chain Way", line2: null, city: "Testville", region: null, postalCode: null, countryCode: "US" },
      { kind: "billing", recipientName, phone: null, line1: "1 Chain Way", line2: null, city: "Testville", region: null, postalCode: null, countryCode: "US" },
    ],
  };
}

/**
 * The idempotency pair a normal checkout carries. Any hex digest would do —
 * the repository only stores and compares it — so a repeated letter keeps the
 * expectations readable.
 */
const CHECKOUT_KEY = "checkout-key-0001";
const CHECKOUT_FINGERPRINT = "a".repeat(64);

/**
 * A two-line USD checkout against a fresh `createChain` (camera qty 1, lens qty 1).
 *
 * `clearCartId` is the cart this checkout empties in the same transaction as the
 * order and the stock decrements; it defaults to `null` for the tests that are
 * about the order write alone.
 */
function twoLineCheckout(
  chain: Chain,
  quantity = 1,
  idempotency: { key?: string; fingerprint?: string } = {},
  clearCartId: string | null = null,
): CreateOrderInput {
  return addAddresses(
    {
      customerUserId: chain.customerUserId,
      idempotencyKey: idempotency.key ?? CHECKOUT_KEY,
      idempotencyFingerprint: idempotency.fingerprint ?? CHECKOUT_FINGERPRINT,
      currency: "USD",
      subtotalAmountCents: 84_998,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: 84_998,
      clearCartId,
      addresses: [],
      lines: [
        {
          variantId: chain.cameraVariantId,
          storeId: chain.storeAId,
          productName: "Chain Camera",
          variantName: "Body only",
          sku: "CHAIN-CAM-BODY",
          quantity,
          unitAmountCents: 59_999,
          lineTotalAmountCents: 59_999 * quantity,
          currency: "USD",
        },
        {
          variantId: chain.lensVariantId,
          storeId: chain.storeBId,
          productName: "Chain Lens",
          variantName: "50mm prime",
          sku: "CHAIN-LEN-50MM",
          quantity,
          unitAmountCents: 24_999,
          lineTotalAmountCents: 24_999 * quantity,
          currency: "USD",
        },
      ],
    },
    "Chain Customer",
  );
}

function inventoryQuantity(db: ReturnType<typeof createTestDatabase>["db"], variantId: string): number {
  return db.select().from(schema.inventory).where(eq(schema.inventory.variantId, variantId)).get()!.quantity;
}

/**
 * A cart for `customerUserId` holding both chain variants, the shape a real
 * checkout arrives with. Returns the cart id so it can be handed to
 * `createOrder` as the cart to empty.
 */
function seedChainCart(db: ReturnType<typeof createTestDatabase>["db"], chain: Chain): string {
  const cart = db
    .insert(schema.carts)
    .values({ userId: chain.customerUserId })
    .returning({ id: schema.carts.id })
    .get();
  db.insert(schema.cartItems)
    .values([
      { cartId: cart.id, variantId: chain.cameraVariantId, quantity: 2 },
      { cartId: cart.id, variantId: chain.lensVariantId, quantity: 1 },
    ])
    .run();
  return cart.id;
}

/** The item rows currently in a cart, as `(variant, quantity)` pairs. */
function cartContents(
  db: ReturnType<typeof createTestDatabase>["db"],
  cartId: string,
): Array<[string, number]> {
  return db
    .select()
    .from(schema.cartItems)
    .where(eq(schema.cartItems.cartId, cartId))
    .all()
    .map((row) => [row.variantId, row.quantity] as [string, number])
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

describe("orders repository: createOrder", () => {
  it("writes the order, address snapshots and lines and decrements inventory atomically", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);

    const result = await repo.createOrder(twoLineCheckout(chain));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.order).toMatchObject({
      customerUserId: chain.customerUserId,
      status: "pending",
      currency: "USD",
      subtotalAmountCents: 84_998,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: 84_998,
    });

    expect(result.addresses).toHaveLength(2);
    expect(new Set(result.addresses.map((address) => address.kind))).toEqual(
      new Set(["shipping", "billing"]),
    );
    expect(result.addresses.every((address) => address.orderId === result.order.id)).toBe(true);
    expect(result.addresses.every((address) => address.line1 === "1 Chain Way")).toBe(true);

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.storeId).sort()).toEqual([chain.storeAId, chain.storeBId]);
    expect(result.items.every((item) => item.status === "pending")).toBe(true);
    expect(result.items[0]!.lineTotalAmountCents).toBe(result.items[0]!.unitAmountCents * 1);

    // Decrement happened in the same transaction as the insert.
    expect(inventoryQuantity(db, chain.cameraVariantId)).toBe(9);
    expect(inventoryQuantity(db, chain.lensVariantId)).toBe(4);

    expect(db.select().from(schema.orders).where(eq(schema.orders.id, result.order.id)).get()).toBeDefined();
    expect(
      db.select().from(schema.orderAddresses).where(eq(schema.orderAddresses.orderId, result.order.id)).all(),
    ).toHaveLength(2);
    expect(
      db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, result.order.id)).all(),
    ).toHaveLength(2);
  });

  it("maps a stock undershoot to INSUFFICIENT_STOCK and writes nothing", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);
    const cartId = seedChainCart(db, chain);

    // Chain inventory starts at 10 for the camera; 11 units must undershoot.
    const result = await repo.createOrder(twoLineCheckout(chain, 11, {}, cartId));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("INSUFFICIENT_STOCK");

    expect(db.select().from(schema.orders).all()).toHaveLength(0);
    expect(db.select().from(schema.orderAddresses).all()).toHaveLength(0);
    expect(db.select().from(schema.orderItems).all()).toHaveLength(0);
    expect(inventoryQuantity(db, chain.cameraVariantId)).toBe(10);
    expect(inventoryQuantity(db, chain.lensVariantId)).toBe(5);
    // The cart emptying was part of the transaction that just rolled back, so
    // the shopper is left holding exactly what they were holding.
    expect(cartContents(db, cartId)).toEqual([
      [chain.cameraVariantId, 2],
      [chain.lensVariantId, 1],
    ]);
  });

  it("rejects a reused (customer, key) as DUPLICATE_IDEMPOTENCY_KEY and writes nothing", async () => {
    // This is what two concurrent checkouts with one key look like from the
    // loser's side: the key is the only thing that collides, so the batch must
    // roll back whole and be reported distinctly from a stock problem.
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);
    const cartId = seedChainCart(db, chain);

    const first = await repo.createOrder(twoLineCheckout(chain, 1, {}, cartId));
    if (!first.ok) {
      throw new Error("expected a successful order create");
    }

    // Same customer, same key, different fingerprint (a materially different checkout).
    const replay = await repo.createOrder(
      twoLineCheckout(chain, 1, { fingerprint: "b".repeat(64) }, cartId),
    );
    expect(replay).toEqual({ ok: false, reason: "DUPLICATE_IDEMPOTENCY_KEY" });

    // Nothing from the rejected attempt survived: still one order, stock was
    // decremented exactly once, and the losing attempt's cart delete rolled
    // back with the rest of its transaction rather than emptying a cart the
    // winner's order already emptied.
    expect(db.select().from(schema.orders).all()).toHaveLength(1);
    expect(db.select().from(schema.orderItems).all()).toHaveLength(2);
    expect(inventoryQuantity(db, chain.cameraVariantId)).toBe(9);
    expect(inventoryQuantity(db, chain.lensVariantId)).toBe(4);
    expect(cartContents(db, cartId)).toEqual([]);
  });

  it("keeps the idempotency key consumed by the committed order", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);

    const created = await repo.createOrder(twoLineCheckout(chain));
    if (!created.ok) {
      throw new Error("expected a successful order create");
    }

    // The write is what makes the key durable: it is readable back with the
    // order, fingerprint and all.
    const stored = db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, created.order.id))
      .get();
    expect(stored?.idempotencyKey).toBe(CHECKOUT_KEY);
    expect(stored?.idempotencyFingerprint).toBe(CHECKOUT_FINGERPRINT);
  });

  it("frees the key again when the checkout it was sent with fails", async () => {
    // A key is consumed by a *commit*, never by an attempt: a shopper whose
    // checkout failed for a real reason (out of stock) must be able to fix the
    // cart and retry with the very same key.
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);

    // Camera stock is 10, so 11 units undershoot and abort the transaction.
    const failed = await repo.createOrder(twoLineCheckout(chain, 11));
    expect(failed).toEqual({ ok: false, reason: "INSUFFICIENT_STOCK" });

    const retried = await repo.createOrder(twoLineCheckout(chain, 1));
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.order.idempotencyKey).toBe(CHECKOUT_KEY);
    expect(inventoryQuantity(db, chain.cameraVariantId)).toBe(9);
  });

  it("maps a missing variant to VARIANT_NOT_FOUND and writes nothing", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);
    const cartId = seedChainCart(db, chain);

    const input = twoLineCheckout(chain, 1, {}, cartId);
    const missing = { ...input, lines: [{ ...input.lines[0]!, variantId: createId() }] };

    const result = await repo.createOrder(missing);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("VARIANT_NOT_FOUND");

    expect(db.select().from(schema.orders).all()).toHaveLength(0);
    expect(db.select().from(schema.orderAddresses).all()).toHaveLength(0);
    expect(db.select().from(schema.orderItems).all()).toHaveLength(0);
    expect(inventoryQuantity(db, chain.cameraVariantId)).toBe(10);
    expect(inventoryQuantity(db, chain.lensVariantId)).toBe(5);
    expect(cartContents(db, cartId)).toEqual([
      [chain.cameraVariantId, 2],
      [chain.lensVariantId, 1],
    ]);
  });
});

/**
 * Z-05: the purchased cart is emptied by the same transaction that writes the
 * order and spends the stock.
 *
 * Before this, the service cleared the cart in a second call after
 * `createOrder` had already committed. That made "order placed" and "cart
 * emptied" two separate facts with a window between them, and a failure in
 * that window left an order and a decremented inventory behind a cart the
 * shopper could still check out. These tests pin the three writes to one
 * commit point: together on success, and none of them on any rollback.
 */
describe("orders repository: the cart is cleared inside the order transaction", () => {
  it("empties the cart in the same transaction that writes the order", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);
    const cartId = seedChainCart(db, chain);

    const result = await repo.createOrder(twoLineCheckout(chain, 1, {}, cartId));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All three effects are visible together, from one committed write.
    expect(result.items).toHaveLength(2);
    expect(inventoryQuantity(db, chain.cameraVariantId)).toBe(9);
    expect(inventoryQuantity(db, chain.lensVariantId)).toBe(4);
    expect(cartContents(db, cartId)).toEqual([]);
    // The cart row itself survives, exactly as `clearCart` has always behaved,
    // so the shopper keeps a stable cart id across checkouts.
    expect(db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get()).toBeDefined();
  });

  it("empties the cart exactly once across a committed checkout", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);
    const cartId = seedChainCart(db, chain);
    const carts = createLocalCartRepository(db);

    await repo.createOrder(twoLineCheckout(chain, 1, {}, cartId));

    // A second attempt under the same key is refused (it is the same key), and a
    // replay answered from the committed order must not clear anything again.
    expect(await repo.createOrder(twoLineCheckout(chain, 1, {}, cartId))).toEqual({
      ok: false,
      reason: "DUPLICATE_IDEMPOTENCY_KEY",
    });
    expect(await carts.clearCart(cartId)).toBe(0);
    expect(cartContents(db, cartId)).toEqual([]);
  });

  it("empties only the cart it was given, leaving other carts alone", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);
    const cartId = seedChainCart(db, chain);

    // A second customer with a cart of their own, in the same database.
    const interloper = db
      .insert(schema.users)
      .values({ email: "cart-interloper@example.test", name: "Interloper" })
      .returning({ id: schema.users.id })
      .get();
    const otherCart = db
      .insert(schema.carts)
      .values({ userId: interloper.id })
      .returning({ id: schema.carts.id })
      .get();
    db.insert(schema.cartItems)
      .values({ cartId: otherCart.id, variantId: chain.lensVariantId, quantity: 1 })
      .run();

    await repo.createOrder(twoLineCheckout(chain, 1, {}, cartId));

    expect(cartContents(db, cartId)).toEqual([]);
    expect(cartContents(db, otherCart.id)).toEqual([[chain.lensVariantId, 1]]);
  });

  it("leaves no partial order when the stock decrement aborts the transaction", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);
    const cartId = seedChainCart(db, chain);

    // The first line fits in stock, the second does not: the transaction has to
    // undo the first line's decrement and every row it wrote.
    const input = twoLineCheckout(chain, 1, {}, cartId);
    const over = {
      ...input,
      lines: [
        { ...input.lines[0]!, quantity: 1 },
        { ...input.lines[1]!, quantity: 99 },
      ],
    };

    expect(await repo.createOrder(over)).toEqual({ ok: false, reason: "INSUFFICIENT_STOCK" });

    expect(db.select().from(schema.orders).all()).toHaveLength(0);
    expect(db.select().from(schema.orderAddresses).all()).toHaveLength(0);
    expect(db.select().from(schema.orderItems).all()).toHaveLength(0);
    expect(inventoryQuantity(db, chain.cameraVariantId)).toBe(10);
    expect(inventoryQuantity(db, chain.lensVariantId)).toBe(5);
    expect(cartContents(db, cartId)).toEqual([
      [chain.cameraVariantId, 2],
      [chain.lensVariantId, 1],
    ]);
  });

  it("rolls the order and the stock back when emptying the cart fails", async () => {
    // The one failure that separates an atomic checkout from a two-step one:
    // the cart delete itself failing. A BEFORE DELETE trigger is the
    // deterministic way to produce it. If the clear ran in its own statement
    // after the order had committed, this test would find an order and a spent
    // inventory behind an untouched cart — exactly the inconsistency Z-05 is
    // about.
    const { db, sqlite } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);
    const cartId = seedChainCart(db, chain);

    sqlite.exec(
      "CREATE TRIGGER refuse_cart_clear BEFORE DELETE ON cart_items BEGIN SELECT RAISE(ABORT, 'cart clear failed'); END;",
    );

    try {
      await expect(
        repo.createOrder(twoLineCheckout(chain, 1, {}, cartId)),
      ).rejects.toThrow(/cart clear failed/);

      // The clear is not a conflict the mapper knows about, so it propagates —
      // and the transaction it belonged to took every other write with it.
      expect(db.select().from(schema.orders).all()).toHaveLength(0);
      expect(db.select().from(schema.orderAddresses).all()).toHaveLength(0);
      expect(db.select().from(schema.orderItems).all()).toHaveLength(0);
      expect(inventoryQuantity(db, chain.cameraVariantId)).toBe(10);
      expect(inventoryQuantity(db, chain.lensVariantId)).toBe(5);
      expect(cartContents(db, cartId)).toEqual([
        [chain.cameraVariantId, 2],
        [chain.lensVariantId, 1],
      ]);
      // The key is free again, so the shopper can retry once the cart can be
      // emptied at all.
      expect(await repo.findByIdempotencyKeyForCustomer(chain.customerUserId, CHECKOUT_KEY)).toBeNull();
    } finally {
      sqlite.exec("DROP TRIGGER refuse_cart_clear;");
    }
  });

  it("keeps a failed checkout retryable: the same key then commits and clears the cart", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);
    const cartId = seedChainCart(db, chain);

    // Stock runs out, so nothing commits and the shopper still has their cart.
    expect(await repo.createOrder(twoLineCheckout(chain, 11, {}, cartId))).toEqual({
      ok: false,
      reason: "INSUFFICIENT_STOCK",
    });
    expect(cartContents(db, cartId)).toEqual([
      [chain.cameraVariantId, 2],
      [chain.lensVariantId, 1],
    ]);

    // The retry uses the very same key and a quantity that fits.
    const retried = await repo.createOrder(twoLineCheckout(chain, 1, {}, cartId));

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.order.idempotencyKey).toBe(CHECKOUT_KEY);
    expect(inventoryQuantity(db, chain.cameraVariantId)).toBe(9);
    expect(cartContents(db, cartId)).toEqual([]);
  });

  it("is a no-op for the cart when the order is not sourced from one", async () => {
    // `clearCartId: null` is the explicit "there is no cart to empty" case: it
    // must neither fail nor invent a cart.
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);
    const cartId = seedChainCart(db, chain);

    const result = await repo.createOrder(twoLineCheckout(chain));

    expect(result.ok).toBe(true);
    expect(cartContents(db, cartId)).toEqual([
      [chain.cameraVariantId, 2],
      [chain.lensVariantId, 1],
    ]);
  });
});

describe("orders repository: reads", () => {
  it("resolves a customer's order with its addresses and lines", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);

    const created = await repo.createOrder(twoLineCheckout(chain));
    if (!created.ok) {
      throw new Error("expected a successful order create");
    }

    const found = await repo.findByIdForCustomer(chain.customerUserId, created.order.id);
    expect(found?.order.id).toBe(created.order.id);
    expect(found?.addresses).toHaveLength(2);
    expect(found?.items).toHaveLength(2);

    // Another user in the database sees nothing, and unknown ids also return null.
    const other = db.insert(schema.users).values({ email: "order-other@example.test", name: "Other" }).returning().get();
    expect(await repo.findByIdForCustomer(other.id, created.order.id)).toBeNull();
    expect(await repo.findByIdForCustomer(chain.customerUserId, createId())).toBeNull();
  });

  it("resolves the order a customer placed under a key, with its details", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);

    const created = await repo.createOrder(twoLineCheckout(chain));
    if (!created.ok) {
      throw new Error("expected a successful order create");
    }

    const found = await repo.findByIdempotencyKeyForCustomer(chain.customerUserId, CHECKOUT_KEY);
    expect(found?.order.id).toBe(created.order.id);
    // The fingerprint travels with it: this is what lets the caller tell a replay
    // of the same request from a reuse of the key for something else.
    expect(found?.order.idempotencyFingerprint).toBe(CHECKOUT_FINGERPRINT);
    expect(found?.addresses).toHaveLength(2);
    expect(found?.items).toHaveLength(2);

    // An unused key resolves to nothing rather than throwing.
    expect(await repo.findByIdempotencyKeyForCustomer(chain.customerUserId, "never-used-key")).toBeNull();
  });

  it("never resolves one customer's key to another customer's order", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);

    const created = await repo.createOrder(twoLineCheckout(chain));
    if (!created.ok) {
      throw new Error("expected a successful order create");
    }

    // Guessing somebody else's key must not expose their order: the lookup is
    // scoped to the caller, so it can only ever return null.
    const interloper = db
      .insert(schema.users)
      .values({ email: "order-key-other@example.test", name: "Other" })
      .returning()
      .get();
    expect(await repo.findByIdempotencyKeyForCustomer(interloper.id, CHECKOUT_KEY)).toBeNull();
  });

  it("paginates one customer's orders newest-first and is scoped to them", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);

    const other = db.insert(schema.users).values({ email: "order-list-other@example.test", name: "Other" }).returning().get();
    const base = new Date("2026-01-10T00:00:00.000Z");

    // Three orders at distinct timestamps for the chain customer, newest last.
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const row = db
        .insert(schema.orders)
        .values({
          customerUserId: chain.customerUserId,
          // Distinct keys: the unique index is per (customer, key), so these
          // three orders must not collide with each other.
          idempotencyKey: `checkout-key-000${index}`,
          idempotencyFingerprint: CHECKOUT_FINGERPRINT,
          status: "pending",
          currency: "USD",
          subtotalAmountCents: 1_000,
          shippingAmountCents: 0,
          discountAmountCents: 0,
          totalAmountCents: 1_000,
          createdAt: new Date(base.getTime() + index * 60_000),
        })
        .returning({ id: schema.orders.id })
        .get();
      ids.push(row.id);
    }
    // An interloper order from a different customer must never appear.
    db.insert(schema.orders)
      .values({
        customerUserId: other.id,
        // The same key the chain customer's orders use: the index is per
        // (customer, key), so this must still be accepted.
        idempotencyKey: CHECKOUT_KEY,
        idempotencyFingerprint: CHECKOUT_FINGERPRINT,
        status: "pending",
        currency: "USD",
        subtotalAmountCents: 1,
        shippingAmountCents: 0,
        discountAmountCents: 0,
        totalAmountCents: 1,
        createdAt: new Date(base.getTime() + 999_999),
      })
      .run();

    const first = await repo.listByCustomer(chain.customerUserId, { limit: 2, cursor: null });
    expect(first.items.map((item) => item.order.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items.every((item) => item.items.length === 0)).toBe(true);

    const second = await repo.listByCustomer(chain.customerUserId, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.order.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();

    // The interloper's page contains only their own order.
    const otherPage = await repo.listByCustomer(other.id, { limit: 10, cursor: null });
    expect(otherPage.items.map((item) => item.order.id)).toHaveLength(1);
    expect(otherPage.items[0]!.order.customerUserId).toBe(other.id);
  });

  it("returns an empty page for a malformed cursor", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);

    const page = await repo.listByCustomer(chain.customerUserId, { limit: 5, cursor: "not-a-cursor" });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});