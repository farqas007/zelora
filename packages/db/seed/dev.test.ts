import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../src/schema";
import { createLocalCatalogRepository } from "../src/catalog/local-repository";
import { createTestDatabase, type TestDatabase } from "../src/test/helpers";
import { assertSeedAllowed, SEED_SUMMARY, seedDev } from "./dev";

/**
 * Focused tests for the dev/test seed: the fixture that makes up the data,
 * its idempotency (twice = same result, never duplicates), its visibility
 * through the existing public catalog/storefront repository, and the guard
 * that keeps it out of production.
 */

function counts(db: TestDatabase["db"]) {
  return {
    users: db.select({ id: schema.users.id }).from(schema.users).all().length,
    sellerProfiles: db.select({ id: schema.sellerProfiles.id }).from(schema.sellerProfiles).all().length,
    stores: db.select({ id: schema.stores.id }).from(schema.stores).all().length,
    categories: db.select({ id: schema.categories.id }).from(schema.categories).all().length,
    products: db.select({ id: schema.products.id }).from(schema.products).all().length,
    productVariants: db.select({ id: schema.productVariants.id }).from(schema.productVariants).all().length,
    productImages: db.select({ id: schema.productImages.id }).from(schema.productImages).all().length,
    orders: db.select({ id: schema.orders.id }).from(schema.orders).all().length,
    orderItems: db.select({ id: schema.orderItems.id }).from(schema.orderItems).all().length,
  };
}

const allProductSlugs = ["gaming-keyboard", "gaming-mouse", "led-desk-lamp", "wireless-headphones"];

describe("dev seed (development/test data only)", () => {
  it("loads the realistic marketplace fixture with the expected summary", () => {
    const { db } = createTestDatabase();
    const summary = seedDev(db);

    expect(summary).toEqual(SEED_SUMMARY);

    const store = db
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.slug, "zelora-test-store"))
      .get();
    expect(store?.name).toBe("Zelora Test Store");
    expect(store?.status).toBe("active");

    const profile = db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.slug, "zelora-test-seller"))
      .get();
    expect(profile?.status).toBe("active");

    const products = db.select().from(schema.products).all();
    expect(products.map((p) => p.name).sort()).toEqual([
      "Gaming Keyboard",
      "Gaming Mouse",
      "LED Desk Lamp",
      "Wireless Headphones",
    ]);
    expect(products.every((p) => p.status === "active")).toBe(true);

    const variants = db.select().from(schema.productVariants).all();
    expect(variants.map((v) => v.sku).sort()).toEqual([
      "DEV-GK-LIN",
      "DEV-GK-TCT",
      "DEV-GM-RGB",
      "DEV-LD-ADJ",
      "DEV-WH-BLK",
      "DEV-WH-CRM",
    ]);
    expect(variants.every((v) => v.status === "active")).toBe(true);
    // Money lives in integer cents with a 3-letter ISO 4217 currency.
    expect(variants.every((v) => Number.isInteger(v.priceAmountCents))).toBe(true);
    expect(variants.every((v) => v.currency === "USD")).toBe(true);
  });

  it("is clearly separate from real data: no credentials and no admin role", () => {
    const { db } = createTestDatabase();
    seedDev(db);

    const users = db.select().from(schema.users).all();
    expect(users.map((u) => u.email).sort()).toEqual([
      "dev-customer@example.test",
      "dev-seller@example.test",
    ]);
    users.forEach((user) => {
      expect(user.passwordHash).toBeNull();
    });
    expect(users.some((user) => user.role === "admin")).toBe(false);
  });

  it("creates one order with two line items, address snapshots and cent-accurate totals", () => {
    const { db } = createTestDatabase();
    seedDev(db);

    const order = db.select().from(schema.orders).get();
    expect(order).toBeDefined();
    expect(order?.subtotalAmountCents).toBe(179_98);
    expect(order?.shippingAmountCents).toBe(0);
    expect(order?.totalAmountCents).toBe(179_98);

    const items = db.select().from(schema.orderItems).all();
    expect(items).toHaveLength(2);
    const sum = items.reduce((total, item) => total + item.lineTotalAmountCents, 0);
    expect(sum).toBe(order?.subtotalAmountCents);

    const snapshots = db.select().from(schema.orderAddresses).all();
    expect(snapshots.map((s) => s.kind).sort()).toEqual(["billing", "shipping"]);
  });

  it("surfaces the seeded store and products through the public catalog/storefront repository", async () => {
    const { db } = createTestDatabase();
    seedDev(db);
    const catalog = createLocalCatalogRepository(db);

    const categories = await catalog.listActiveCategories();
    expect(categories.map((c) => c.slug).sort()).toEqual(["audio", "gaming", "home-living"]);

    const page = await catalog.listActiveProducts({ limit: 20, cursor: null });
    expect(page.items.map((i) => i.slug).sort()).toEqual(allProductSlugs);
    const headphones = page.items.find((i) => i.slug === "wireless-headphones");
    expect(headphones?.store).toMatchObject({ slug: "zelora-test-store", name: "Zelora Test Store" });
    expect(headphones?.category).toMatchObject({ slug: "audio", name: "Audio" });
    expect(headphones?.priceAmountCents).toBe(129_99);
    expect(headphones?.currency).toBe("USD");
    expect(headphones?.image).toEqual({
      url: "https://example.test/wireless-headphones.jpg",
      altText: "Wireless Headphones",
    });

    const storefront = await catalog.findActiveStoreBySlug("zelora-test-store");
    expect(storefront).toMatchObject({ slug: "zelora-test-store", name: "Zelora Test Store" });

    const storePage = await catalog.listStoreProducts({
      storeSlug: "zelora-test-store",
      limit: 20,
      cursor: null,
    });
    expect(storePage.items.map((i) => i.slug).sort()).toEqual(allProductSlugs);

    const detail = await catalog.findProductBySlug("wireless-headphones");
    expect(detail).not.toBeNull();
    expect(detail?.variants.map((v) => v.name).sort()).toEqual(["Cream", "Matte Black"]);
    expect(detail?.variants.every((v) => v.currency === "USD")).toBe(true);
    expect(detail?.images.filter((i) => i.isPrimary)).toHaveLength(1);
  });

  it("is idempotent: a second run changes nothing and never duplicates rows", () => {
    const { db } = createTestDatabase();
    const first = seedDev(db);
    const before = counts(db);

    const second = seedDev(db);

    expect(second).toEqual(first);
    expect(second).toEqual(SEED_SUMMARY);
    expect(counts(db)).toEqual(before);

    // Natural keys remain unique — exactly one row each after two runs.
    expect(
      db.select().from(schema.stores).where(eq(schema.stores.slug, "zelora-test-store")).all(),
    ).toHaveLength(1);
    expect(
      db.select().from(schema.productVariants).where(eq(schema.productVariants.sku, "DEV-WH-BLK")).all(),
    ).toHaveLength(1);
    const products = db
      .select()
      .from(schema.products)
      .where(eq(schema.products.name, "Wireless Headphones"))
      .all();
    expect(products).toHaveLength(1);
  });

  it("keeps growing a database that already holds real marketplace rows", () => {
    const { db } = createTestDatabase();
    // Pre-existing non-fixture rows (as if real marketplace data were present).
    db.insert(schema.users)
      .values({ email: "real-customer@example.com", name: "Real Customer" })
      .run();

    const summary = seedDev(db);

    expect(summary).toEqual(SEED_SUMMARY);
    expect(counts(db).users).toBe(3);
    expect(
      db.select().from(schema.users).where(eq(schema.users.email, "real-customer@example.com")).get(),
    ).toBeDefined();
    // The real row is untouched, and re-running is still safe.
    seedDev(db);
    expect(counts(db).users).toBe(3);
  });

  it("adopts a real product's existing primary image instead of crashing or duplicating", () => {
    const { db } = createTestDatabase();
    // A real marketplace row already claims every fixture natural key and that
    // product already owns its own primary image (the partial unique index
    // allows exactly one primary per product).
    db.insert(schema.users)
      .values({ email: "dev-customer@example.test", name: "Real Customer" })
      .run();
    db.insert(schema.users)
      .values({ email: "dev-seller@example.test", name: "Real Seller" })
      .run();
    db.insert(schema.sellerProfiles)
      .values({
        userId: db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, "dev-seller@example.test")).get()!.id,
        slug: "zelora-test-seller",
        displayName: "Real Seller",
        status: "active",
      })
      .run();
    const sellerProfile = db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.slug, "zelora-test-seller"))
      .get()!;
    db.insert(schema.stores)
      .values({ sellerProfileId: sellerProfile.id, name: "Real Store", slug: "zelora-test-store", status: "active" })
      .run();
    const store = db.select().from(schema.stores).where(eq(schema.stores.slug, "zelora-test-store")).get()!;
    db.insert(schema.products)
      .values({ storeId: store.id, name: "Real Headphones", slug: "wireless-headphones", status: "active" })
      .run();
    const product = db
      .select()
      .from(schema.products)
      .where(eq(schema.products.slug, "wireless-headphones"))
      .get()!;
    db.insert(schema.productImages)
      .values({
        productId: product.id,
        url: "https://real.test/real-primary.jpg",
        altText: "Real Primary",
        isPrimary: 1,
        sortOrder: 0,
      })
      .run();

    // Must not throw — the previous implementation crashed with
    // "UNIQUE constraint failed: product_images.product_id".
    expect(() => seedDev(db)).not.toThrow();

    // The real primary image is untouched.
    const realImage = db
      .select()
      .from(schema.productImages)
      .where(eq(schema.productImages.url, "https://real.test/real-primary.jpg"))
      .get();
    expect(realImage).toMatchObject({ isPrimary: 1, altText: "Real Primary" });

    // Exactly one primary image remains for the product — the fixture image was
    // not inserted as a second primary row.
    const primaryImages = db
      .select()
      .from(schema.productImages)
      .where(and(eq(schema.productImages.productId, product.id), eq(schema.productImages.isPrimary, 1)))
      .all();
    expect(primaryImages).toHaveLength(1);
    expect(primaryImages[0]!.url).toBe("https://real.test/real-primary.jpg");
  });

  it("refuses to run with NODE_ENV=production", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "production" })).toThrowError(/NODE_ENV=production/);
    expect(() => assertSeedAllowed({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertSeedAllowed({})).not.toThrow();
  });
});