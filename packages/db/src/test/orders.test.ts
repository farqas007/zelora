import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "../schema";
import { createTestDatabase, expectConstraintError } from "./helpers";
import { createChain } from "./fixtures";

describe("multi-vendor orders", () => {
  it("stores one customer order containing lines from multiple stores", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });

    const items = db
      .select({ storeId: schema.orderItems.storeId, orderId: schema.orderItems.orderId })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, chain.orderId!))
      .all();

    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.storeId)).size).toBe(2);
    expect(items.every((item) => item.orderId === chain.orderId)).toBe(true);
  });

  it("can group a multi-store order into per-store buckets", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });

    const buckets = db
      .select({ storeId: schema.orderItems.storeId, itemCount: sql<number>`count(*)` })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, chain.orderId!))
      .groupBy(schema.orderItems.storeId)
      .all();

    const byStore = new Map(buckets.map((bucket) => [bucket.storeId, bucket.itemCount]));
    expect(byStore.get(chain.storeAId)).toBe(1);
    expect(byStore.get(chain.storeBId)).toBe(1);
  });

  it("keeps each line's store_id consistent with the variant's product store", () => {
    const { db } = createTestDatabase();
    createChain(db, { order: true });

    const rows = db
      .select({
        itemStoreId: schema.orderItems.storeId,
        productStoreId: schema.products.storeId,
      })
      .from(schema.orderItems)
      .innerJoin(schema.productVariants, eq(schema.orderItems.variantId, schema.productVariants.id))
      .innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id))
      .all();

    expect(rows).toHaveLength(2);
    rows.forEach((row) => {
      expect(row.itemStoreId).toBe(row.productStoreId);
    });
    // Sanity: the two lines really do come from different stores.
    expect(rows[0]?.productStoreId).not.toBe(rows[1]?.productStoreId);
  });

  it("lets each store's line advance its own lifecycle status independently", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });

    const cameraLine = db
      .select({ id: schema.orderItems.id })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.storeId, chain.storeAId))
      .get();
    expect(cameraLine).toBeDefined();

    db.update(schema.orderItems).set({ status: "shipped" }).where(eq(schema.orderItems.id, cameraLine!.id)).run();

    const statuses = db
      .select({ storeId: schema.orderItems.storeId, status: schema.orderItems.status })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, chain.orderId!))
      .all();

    expect(statuses.find((s) => s.storeId === chain.storeAId)?.status).toBe("shipped");
    expect(statuses.find((s) => s.storeId === chain.storeBId)?.status).toBe("pending");

    const order = db.select().from(schema.orders).where(eq(schema.orders.id, chain.orderId!)).get();
    expect(order?.status).toBe("confirmed");
  });

  it("supports a seller-side worklist across the seller's lines", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });

    const worklist = db
      .select({
        orderId: schema.orders.id,
        customer: schema.users.name,
        vendorQuantity: sql<number>`count(*)`,
      })
      .from(schema.orderItems)
      .innerJoin(schema.orders, eq(schema.orderItems.orderId, schema.orders.id))
      .innerJoin(schema.users, eq(schema.orders.customerUserId, schema.users.id))
      .where(eq(schema.orderItems.storeId, chain.storeAId))
      .groupBy(schema.orders.id)
      .all();

    expect(worklist).toHaveLength(1);
    expect(worklist[0]?.orderId).toBe(chain.orderId);
    expect(worklist[0]?.customer).toBe("Chain Customer");
    expect(worklist[0]?.vendorQuantity).toBe(1);
  });

  it("sums line totals exactly to the order subtotal (integer cents)", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });

    const sum = db
      .select({ subtotal: sql<number>`coalesce(sum(${schema.orderItems.lineTotalAmountCents}), 0)` })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, chain.orderId!))
      .get();

    const order = db.select().from(schema.orders).where(eq(schema.orders.id, chain.orderId!)).get();
    expect(sum?.subtotal).toBe(order?.subtotalAmountCents);
    expect(order?.subtotalAmountCents).toBe(84_998);
  });
});

describe("order immutability", () => {
  it("snapshots the address at checkout; later address-book edits never touch the order", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });

    const addressId = db
      .insert(schema.addresses)
      .values({
        userId: chain.customerUserId,
        type: "shipping",
        recipientName: "Original Recipient",
        line1: "1 Old Way",
        city: "Oldtown",
        countryCode: "US",
      })
      .returning({ id: schema.addresses.id })
      .get().id;

    db.update(schema.addresses).set({ line1: "999 New Avenue" }).where(eq(schema.addresses.id, addressId)).run();

    const snapshot = db
      .select()
      .from(schema.orderAddresses)
      .where(eq(schema.orderAddresses.orderId, chain.orderId!))
      .all();

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.line1).toBe("1 Chain Way");
  });

  it("keeps only one snapshot per (order, kind)", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });

    expectConstraintError(
      () =>
        db.insert(schema.orderAddresses).values({
          orderId: chain.orderId!,
          kind: "shipping",
          recipientName: "Second Snapshot",
          line1: "2 Chain Way",
          city: "Testville",
          countryCode: "US",
        }).run(),
      /UNIQUE constraint failed: order_addresses\.order_id, order_addresses\.kind/,
    );
  });

  it("never deletes an order, even an empty one (RESTRICT)", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });
    expectConstraintError(
      () => db.delete(schema.orders).where(eq(schema.orders.id, chain.orderId!)).run(),
      /FOREIGN KEY constraint failed/,
    );
  });
});