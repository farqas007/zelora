import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createTestDatabase, expectConstraintError } from "./helpers";
import { createChain } from "./fixtures";
import type { UserRole } from "../schema";

describe("unique constraints", () => {
  it("rejects duplicate user emails", () => {
    const { db } = createTestDatabase();
    db.insert(schema.users).values({ email: "dup@example.test", name: "First" }).run();
    expectConstraintError(
      () => db.insert(schema.users).values({ email: "dup@example.test", name: "Second" }).run(),
      /UNIQUE constraint failed: users\.email/,
    );
  });

  it("rejects duplicate store slugs", () => {
    const { db } = createTestDatabase();
    createChain(db);
    const profileId = db.select({ id: schema.sellerProfiles.id }).from(schema.sellerProfiles).limit(1).get()!.id;
    expectConstraintError(
      () =>
        db.insert(schema.stores).values({
          sellerProfileId: profileId,
          name: "Dup Store",
          slug: "chain-store-a",
          status: "active",
        }).run(),
      /UNIQUE constraint failed: stores\.slug/,
    );
  });

  it("allows multiple NULL SKUs but rejects a duplicated SKU", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const otherProduct = db
      .insert(schema.products)
      .values({ storeId: chain.storeAId, name: "No SKU product", slug: "no-sku" })
      .returning({ id: schema.products.id })
      .get().id;

    // Two null-SKU variants are fine (SQLite treats NULLs as distinct).
    db.insert(schema.productVariants).values([
      { productId: otherProduct, name: "A", currency: "USD" },
      { productId: otherProduct, name: "B", currency: "USD" },
    ]).run();

    // A duplicated SKU is rejected.
    expectConstraintError(
      () =>
        db
          .insert(schema.productVariants)
          .values({ productId: otherProduct, name: "C", sku: "CHAIN-CAM-BODY", currency: "USD" })
          .run(),
      /UNIQUE constraint failed: product_variants\.sku/,
    );
  });

  it("enforces unique (store_id, slug) per product", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    expectConstraintError(
      () =>
        db
          .insert(schema.products)
          .values({ storeId: chain.storeAId, name: "Dup", slug: "chain-camera" })
          .run(),
      /UNIQUE constraint failed: products\.store_id, products\.slug/,
    );
  });

  it("enforces duplicate roots and duplicate siblings, but not root-vs-child", () => {
    const { db } = createTestDatabase();
    db.insert(schema.categories).values({ name: "Travel", slug: "travel", status: "active" }).run();
    const parent = db
      .insert(schema.categories)
      .values({ name: "Outdoors", slug: "outdoors", status: "active" })
      .returning({ id: schema.categories.id })
      .get().id;
    db.insert(schema.categories).values({ name: "Tents", slug: "tents", parentId: parent }).run();

    // Duplicate root slug.
    expectConstraintError(
      () => db.insert(schema.categories).values({ name: "Travel 2", slug: "travel" }).run(),
      /UNIQUE constraint failed: categories\.slug/,
    );
    // Duplicate sibling slug.
    expectConstraintError(
      () => db.insert(schema.categories).values({ name: "Tents 2", slug: "tents", parentId: parent }).run(),
      /UNIQUE constraint failed: categories\.parent_id, categories\.slug/,
    );
    // Same slug at root and under a parent is allowed.
    db.insert(schema.categories).values({ name: "Travel", slug: "travel", parentId: parent }).run();
  });

  it("enforces one primary image per product, across products independently", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    expectConstraintError(
      () =>
        db
          .insert(schema.productImages)
          .values({ productId: chain.cameraProductId, url: "https://example.test/camera-2.jpg", isPrimary: 1 })
          .run(),
      /UNIQUE constraint failed: product_images\.product_id/,
    );
    // A different product is unaffected — it gets its own primary image.
    const independentProductId = db
      .insert(schema.products)
      .values({ storeId: chain.storeAId, name: "Independent", slug: "independent-product" })
      .returning({ id: schema.products.id })
      .get().id;
    db.insert(schema.productImages)
      .values({ productId: independentProductId, url: "https://example.test/independent.jpg", isPrimary: 1 })
      .run();
  });

  it("enforces one default address per (user, type)", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const values = {
      userId: chain.customerUserId,
      recipientName: "Chain Customer",
      line1: "1 Chain Way",
      city: "Testville",
      countryCode: "US",
      isDefault: 1,
    };
    db.insert(schema.addresses).values({ ...values, type: "shipping" }).run();
    db.insert(schema.addresses).values({ ...values, type: "billing" }).run();
    expectConstraintError(
      () => db.insert(schema.addresses).values({ ...values, type: "shipping" }).run(),
      /UNIQUE constraint failed: addresses\.user_id, addresses\.type/,
    );
  });
});

describe("check constraints", () => {
  it("rejects an unknown user role", () => {
    const { db } = createTestDatabase();
    expectConstraintError(
      () => db.insert(schema.users).values({ email: "bad-role@example.test", name: "Bad", role: "superadmin" as UserRole }).run(),
      /CHECK constraint failed: users_role_check/,
    );
  });

  it("rejects a negative variant price", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    expectConstraintError(
      () =>
        db
          .insert(schema.productVariants)
          .values({ productId: chain.cameraProductId, name: "Negative", priceAmountCents: -5, currency: "USD" })
          .run(),
      /CHECK constraint failed: product_variants_price_non_negative/,
    );
  });

  it("rejects order items whose line total does not equal unit price times quantity", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });
    expectConstraintError(
      () =>
        db.insert(schema.orderItems).values({
          orderId: chain.orderId!,
          variantId: chain.cameraVariantId,
          storeId: chain.storeAId,
          productName: "Chain Camera",
          variantName: "Body only",
          quantity: 2,
          unitAmountCents: 9_999,          lineTotalAmountCents: 30_000,
          currency: "USD",
        }).run(),
      /CHECK constraint failed: order_items_line_total_matches_quantity/,
    );
  });

  it("rejects zero/negative order-item quantity", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });
    expectConstraintError(
      () =>
        db.insert(schema.orderItems).values({
          orderId: chain.orderId!,
          variantId: chain.cameraVariantId,
          storeId: chain.storeAId,
          productName: "Chain Camera",
          variantName: "Body only",
          quantity: 0,
          unitAmountCents: 9_999,          lineTotalAmountCents: 0,
          currency: "USD",
        }).run(),
      /CHECK constraint failed: order_items_quantity_positive/,
    );
  });

  it("rejects malformed currency codes", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    expectConstraintError(
      () => db.insert(schema.orders).values({ customerUserId: chain.customerUserId, currency: "US" }).run(),
      /CHECK constraint failed: orders_currency_length/,
    );
  });

  it("rejects malformed country codes", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    expectConstraintError(
      () =>
        db.insert(schema.orderAddresses).values({
          orderId: chain.orderId ?? "00000000-0000-7000-8000-000000000001",
          kind: "shipping",
          recipientName: "Nope",
          line1: "1 Nowhere",
          city: "None",
          countryCode: "USA",
        }).run(),
      /CHECK constraint failed: order_addresses_country_code_length/,
    );
  });

  it("rejects images with a non-boolean primary flag", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    expectConstraintError(
      () =>
        db
          .insert(schema.productImages)
          .values({ productId: chain.cameraProductId, url: "https://example.test/x.jpg", isPrimary: 2 })
          .run(),
      /CHECK constraint failed: product_images_is_primary_flag/,
    );
  });
});

describe("foreign keys", () => {
  it("rejects an order for a non-existent customer (foreign_keys is ON)", () => {
    const { db } = createTestDatabase();
    expectConstraintError(
      () =>
        db
          .insert(schema.orders)
          .values({ customerUserId: "00000000-0000-7000-8000-000000000001", currency: "USD" })
          .run(),
      /FOREIGN KEY constraint failed/,
    );
  });

  it("rejects an order item pointing at a non-existent store", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });
    expectConstraintError(
      () =>
        db.insert(schema.orderItems).values({
          orderId: chain.orderId!,
          variantId: chain.cameraVariantId,
          storeId: "00000000-0000-7000-8000-000000000099",
          productName: "Ghost",
          variantName: "X",
          quantity: 1,
          unitAmountCents: 100,          lineTotalAmountCents: 100,
          currency: "USD",
        }).run(),
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("deletion behavior", () => {
  it("never deletes a user with orders (RESTRICT)", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });
    expectConstraintError(
      () => db.delete(schema.users).where(eq(schema.users.id, chain.customerUserId)).run(),
      /FOREIGN KEY constraint failed/,
    );
    expect(db.select().from(schema.users).all()).toHaveLength(3);
  });

  it("never deletes a store referenced by an order item (RESTRICT)", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });
    expectConstraintError(
      () => db.delete(schema.stores).where(eq(schema.stores.id, chain.storeAId)).run(),
      /FOREIGN KEY constraint failed/,
    );
  });

  it("never deletes a product whose variant was ordered (RESTRICT through order_items)", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });
    expectConstraintError(
      () => db.delete(schema.products).where(eq(schema.products.id, chain.cameraProductId)).run(),
      /FOREIGN KEY constraint failed/,
    );
  });

  it("never deletes an ordered variant (RESTRICT)", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });
    expectConstraintError(
      () => db.delete(schema.productVariants).where(eq(schema.productVariants.id, chain.cameraVariantId)).run(),
      /FOREIGN KEY constraint failed/,
    );
  });

  it("never deletes an order (RESTRICT from order_items and order_addresses)", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db, { order: true });
    expectConstraintError(
      () => db.delete(schema.orders).where(eq(schema.orders.id, chain.orderId!)).run(),
      /FOREIGN KEY constraint failed/,
    );
  });

  it("cascades product delete to variants, images and inventory when nothing else references them", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    db.delete(schema.products).where(eq(schema.products.id, chain.cameraProductId)).run();
    expect(db.select().from(schema.products).all()).toHaveLength(1);
    expect(db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, chain.cameraProductId)).all()).toHaveLength(0);
    expect(db.select().from(schema.productImages).where(eq(schema.productImages.productId, chain.cameraProductId)).all()).toHaveLength(0);
    expect(
      db
        .select()
        .from(schema.inventory)
        .where(eq(schema.inventory.variantId, chain.cameraVariantId))
        .all(),
    ).toHaveLength(0);
  });

  it("sets product category to NULL when a category is deleted (SET NULL)", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    db.delete(schema.categories).where(eq(schema.categories.id, chain.categoryId)).run();
    const row = db.select().from(schema.products).where(eq(schema.products.id, chain.cameraProductId)).get();
    expect(row?.categoryId).toBeNull();
  });

  it("never deletes a parent category with children (RESTRICT)", () => {
    const { db } = createTestDatabase();
    const parent = db
      .insert(schema.categories)
      .values({ name: "Parent", slug: "parent", status: "active" })
      .returning({ id: schema.categories.id })
      .get().id;
    db.insert(schema.categories).values({ name: "Child", slug: "child", parentId: parent }).run();
    expectConstraintError(
      () => db.delete(schema.categories).where(eq(schema.categories.id, parent)).run(),
      /FOREIGN KEY constraint failed/,
    );
  });

  it("populates timestamps automatically", () => {
    const { db } = createTestDatabase();
    const row = db
      .insert(schema.users)
      .values({ email: "ts@example.test", name: "Timestamps" })
      .returning({ id: schema.users.id, createdAt: schema.users.createdAt, updatedAt: schema.users.updatedAt })
      .get();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });
});