import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createTestDatabase } from "./helpers";
import { createChain, type Chain } from "./fixtures";
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

/** A two-line USD checkout against a fresh `createChain` (camera qty 1, lens qty 1). */
function twoLineCheckout(chain: Chain, quantity = 1): CreateOrderInput {
  return addAddresses(
    {
      customerUserId: chain.customerUserId,
      currency: "USD",
      subtotalAmountCents: 84_998,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: 84_998,
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

    // Chain inventory starts at 10 for the camera; 11 units must undershoot.
    const result = await repo.createOrder(twoLineCheckout(chain, 11));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("INSUFFICIENT_STOCK");

    expect(db.select().from(schema.orders).all()).toHaveLength(0);
    expect(db.select().from(schema.orderAddresses).all()).toHaveLength(0);
    expect(db.select().from(schema.orderItems).all()).toHaveLength(0);
    expect(inventoryQuantity(db, chain.cameraVariantId)).toBe(10);
    expect(inventoryQuantity(db, chain.lensVariantId)).toBe(5);
  });

  it("maps a missing variant to VARIANT_NOT_FOUND and writes nothing", async () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const repo = createLocalOrderRepository(db);

    const input = twoLineCheckout(chain);
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