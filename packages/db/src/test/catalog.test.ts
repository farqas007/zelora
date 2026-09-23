import { beforeEach, describe, expect, it } from "vitest";
import type { LocalDatabase } from "../client";
import * as schema from "../schema";
import { createLocalCatalogRepository } from "../catalog/local-repository";
import { encodeCatalogCursor } from "../catalog/cursor";
import { createTestDatabase } from "./helpers";

/**
 * Real-SQLite integration tests for the catalog repository. Each test runs on
 * an isolated in-memory database with the committed migrations applied. The
 * fixtures build a small storefront (one seller, one active store) and assert
 * both *what* is public and *what must stay hidden*.
 */

let seq = 0;

/** Create the users/seller-profile/store scaffolding every fixture needs. */
function seedStore(db: LocalDatabase, overrides: Partial<typeof schema.stores.$inferInsert> = {}) {
  seq += 1;
  const sellerProfile = db
    .insert(schema.sellerProfiles)
    .values({
      userId: db
        .insert(schema.users)
        .values({ email: `catalog-user-${seq}@example.test`, name: "Catalog Seller" })
        .returning({ id: schema.users.id })
        .get().id,
      slug: `catalog-profile-${seq}`,
      displayName: "Catalog Seller",
    })
    .returning({ id: schema.sellerProfiles.id })
    .get();
  return db
    .insert(schema.stores)
    .values({
      sellerProfileId: sellerProfile.id,
      name: `Store ${seq}`,
      slug: `store-${seq}`,
      status: "active",
      ...overrides,
    })
    .returning()
    .get();
}

function seedCategory(db: LocalDatabase, overrides: Partial<typeof schema.categories.$inferInsert> = {}) {
  seq += 1;
  return db
    .insert(schema.categories)
    .values({ name: `Category ${seq}`, slug: `category-${seq}`, status: "active", ...overrides })
    .returning()
    .get();
}

function seedProduct(db: LocalDatabase, overrides: Partial<typeof schema.products.$inferInsert> = {}) {
  seq += 1;
  return db
    .insert(schema.products)
    .values({
      storeId: seedStore(db).id,
      name: `Product ${seq}`,
      slug: `product-${seq}`,
      status: "active",
      ...overrides,
    })
    .returning()
    .get();
}

function seedImage(db: LocalDatabase, overrides: Partial<typeof schema.productImages.$inferInsert> = {}) {
  seq += 1;
  return db
    .insert(schema.productImages)
    .values({
      productId: sequence.products[0]!,
      url: `https://cdn.example.test/image-${seq}.jpg`,
      altText: `Image ${seq}`,
      sortOrder: 0,
      isPrimary: 0,
      ...overrides,
    })
    .returning()
    .get();
}

/**
 * Helpers that are seeded via {@link seedProduct} may rely on the most recent
 * seed id; expose it through a tiny module-level holder so the fixture
 * functions above stay readable.
 */
const sequence: { products: string[]; stores: string[] } = { products: [], stores: [] };

let db: LocalDatabase;
let repo: ReturnType<typeof createLocalCatalogRepository>;
let store: typeof schema.stores.$inferSelect;
let category: typeof schema.categories.$inferSelect;

beforeEach(() => {
  ({ db } = createTestDatabase());
  repo = createLocalCatalogRepository(db);
  seq = 0;
  sequence.products.length = 0;
  sequence.stores.length = 0;
  store = seedStoreForSuite();
  category = seedCategory(db);
});

function seedStoreForSuite(): typeof schema.stores.$inferSelect {
  const inserted = seedStore(db, { slug: "active-store", name: "Active Store" });
  sequence.stores.push(inserted.id);
  return inserted;
}

function addProduct(overrides: Partial<typeof schema.products.$inferInsert> = {}) {
  const product = seedProduct(db, { storeId: store.id, ...overrides });
  sequence.products.push(product.id);
  return product;
}

describe("catalog repository: categories", () => {
  it("lists only active categories in name order", async () => {
    seedCategory(db, { slug: "zeta", name: "Zeta Category" });
    seedCategory(db, { slug: "alpha", name: "Alpha Category" });
    seedCategory(db, { slug: "hidden", name: "Hidden Category", status: "inactive" });

    const categories = await repo.listActiveCategories();

    // The scaffold category from beforeEach() is active too.
    expect(categories.map((c) => c.slug)).toEqual(["alpha", "category-2", "zeta"]);
    for (const row of categories) {
      expect(Object.keys(row).sort()).toEqual(["id", "name", "slug"]);
    }
  });
});

describe("catalog repository: product list", () => {
  it("returns active products of active stores with price, category and primary image", async () => {
    const product = addProduct({ name: "Widget", slug: "widget", description: "A widget", categoryId: category.id });
    addProduct({ slug: "hidden", status: "draft" });
    addProduct({ slug: "archived", status: "archived" });

    addVariant(product.id, { priceAmountCents: 3_000, currency: "USD" });
    // A cheaper variant is what the summary should report.
    addVariant(product.id, { name: "Cheaper", priceAmountCents: 2_500, currency: "USD" });
    seedImage(db, { productId: product.id, isPrimary: 1, sortOrder: 2, url: "https://cdn.example.test/primary.jpg", altText: "Primary" });
    seedImage(db, { productId: product.id, isPrimary: 0, sortOrder: 1, url: "https://cdn.example.test/first.jpg", altText: "First" });

    const page = await repo.listActiveProducts({ limit: 10, cursor: null });

    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.id).toBe(product.id);
    expect(item.slug).toBe("widget");
    expect(item.name).toBe("Widget");
    expect(item.description).toBe("A widget");
    expect(item.priceAmountCents).toBe(2_500);
    expect(item.currency).toBe("USD");
    expect(item.category).toEqual({ id: category.id, slug: category.slug, name: category.name });
    expect(item.image).toEqual({ url: "https://cdn.example.test/primary.jpg", altText: "Primary" });
    expect(page.nextCursor).toBeNull();
  });

  it("hides products whose store is not active", async () => {
    const inactiveStore = seedStore(db, { status: "inactive" });
    addProduct({ storeId: inactiveStore.id, slug: "in-store-offline" });

    const page = await repo.listActiveProducts({ limit: 10, cursor: null });

    expect(page.items).toHaveLength(0);
  });

  it("hides products whose category is inactive", async () => {
    const inactiveCategory = seedCategory(db, { status: "inactive" });
    addProduct({ categoryId: inactiveCategory.id, slug: "in-offline-category" });
    // Uncategorised products remain visible.
    const bare = addProduct({ slug: "uncategorised" });
    addVariant(bare.id, { priceAmountCents: 999, currency: "GBP" });

    const page = await repo.listActiveProducts({ limit: 10, cursor: null });

    expect(page.items.map((i) => i.slug)).toEqual(["uncategorised"]);
    expect(page.items[0]!.category).toBeNull();
    expect(page.items[0]!.currency).toBe("GBP");
  });

  it("reports null price for a product with no active variant", async () => {
    const product = addProduct({ slug: "no-variant" });
    addVariant(product.id, { status: "inactive", priceAmountCents: 1_000 });

    const page = await repo.listActiveProducts({ limit: 10, cursor: null });

    expect(page.items[0]!.priceAmountCents).toBeNull();
    expect(page.items[0]!.currency).toBeNull();
  });

  it("reports the cheapest active variant's own compare-at amount", async () => {
    const product = addProduct({ slug: "compare-at-same-row" });
    addVariant(product.id, { name: "Cheap", priceAmountCents: 1_800, compareAtAmountCents: 2_200, currency: "GBP" });
    addVariant(product.id, { name: "Expensive", priceAmountCents: 5_000, compareAtAmountCents: 6_000, currency: "USD" });

    const page = await repo.listActiveProducts({ limit: 10, cursor: null });
    const item = page.items.find((i) => i.slug === "compare-at-same-row");

    expect(item).toBeDefined();
    expect(item!.priceAmountCents).toBe(1_800);
    expect(item!.compareAtAmountCents).toBe(2_200);
    expect(item!.currency).toBe("GBP");
  });

  it("never pairs a more expensive variant's compare-at with the cheapest price", async () => {
    const product = addProduct({ slug: "compare-at-mismatch" });
    // The cheapest active variant has no compare-at; the more expensive
    // variant carries one. Independent MIN() aggregation would leak the
    // expensive variant's compare-at alongside the cheap price.
    addVariant(product.id, { name: "Cheap", priceAmountCents: 9_999, currency: "USD" });
    addVariant(product.id, { name: "Premium", priceAmountCents: 19_999, compareAtAmountCents: 24_999, currency: "EUR" });

    const page = await repo.listActiveProducts({ limit: 10, cursor: null });
    const item = page.items.find((i) => i.slug === "compare-at-mismatch");

    expect(item).toBeDefined();
    expect(item!.priceAmountCents).toBe(9_999);
    expect(item!.compareAtAmountCents).toBeNull();
    expect(item!.currency).toBe("USD");
  });

  it("derives currency from the cheapest active variant, not an arbitrary row", async () => {
    const product = addProduct({ slug: "currency-consistency" });
    addVariant(product.id, { name: "Cheap", priceAmountCents: 3_000, currency: "GBP" });
    addVariant(product.id, { name: "Expensive", priceAmountCents: 3_001, currency: "USD" });

    const page = await repo.listActiveProducts({ limit: 10, cursor: null });
    const item = page.items.find((i) => i.slug === "currency-consistency");

    expect(item).toBeDefined();
    expect(item!.priceAmountCents).toBe(3_000);
    expect(item!.currency).toBe("GBP");
  });

  it("resolves same-price variants deterministically when currencies differ", async () => {
    const product = addProduct({ slug: "tie-break" });
    addVariant(product.id, { name: "Alpha", createdAt: new Date("2026-01-01T00:00:00.000Z"), priceAmountCents: 5_000, currency: "GBP" });
    addVariant(product.id, { name: "Beta", createdAt: new Date("2026-01-02T00:00:00.000Z"), priceAmountCents: 5_000, currency: "USD" });

    const page = await repo.listActiveProducts({ limit: 10, cursor: null });
    const item = page.items.find((i) => i.slug === "tie-break");

    expect(item).toBeDefined();
    expect(item!.priceAmountCents).toBe(5_000);
    // Earliest createdAt is the deterministic tie-break for identical prices.
    expect(item!.currency).toBe("GBP");
  });

  it("filters by an active category while leaving other categories out", async () => {
    const productA = addProduct({ categoryId: category.id, slug: "in-category" });
    addVariant(productA.id, { priceAmountCents: 500, currency: "USD" });
    addProduct({ slug: "other-category" });

    const page = await repo.listActiveProducts({ limit: 10, cursor: null, categorySlug: category.slug });

    expect(page.items.map((i) => i.slug)).toEqual(["in-category"]);
  });

  it("paginates newest-first with a keyset cursor", async () => {
    const first = addProduct({ slug: "first", createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const second = addProduct({ slug: "second", createdAt: new Date("2026-01-02T00:00:00.000Z") });
    const third = addProduct({ slug: "third", createdAt: new Date("2026-01-03T00:00:00.000Z") });
    for (const id of [first.id, second.id, third.id]) {
      addVariant(id, { priceAmountCents: 100, currency: "USD" });
    }

    const page = await repo.listActiveProducts({ limit: 2, cursor: null });
    expect(page.items.map((i) => i.slug)).toEqual(["third", "second"]);
    expect(page.nextCursor).not.toBeNull();

    expect(await repo.findProductBySlug("second")).toMatchObject({ slug: "second" });

    const secondPage = await repo.listActiveProducts({ limit: 2, cursor: page.nextCursor });
    expect(secondPage.items.map((i) => i.slug)).toEqual(["first"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("pins cursor ordering with the id tiebreak for same-millisecond inserts", async () => {
    const createdAt = new Date("2026-02-01T00:00:00.000Z");
    // Deterministic ids: pass explicit ids so the (createdAt, id) order is known.
    addProduct({ slug: "a", createdAt, id: "00000000-0000-7000-8000-0000000000aa" });
    addProduct({ slug: "b", createdAt, id: "00000000-0000-7000-8000-0000000000bb" });

    const page = await repo.listActiveProducts({ limit: 1, cursor: null });

    expect(page.items.map((i) => i.slug)).toEqual(["b"]);
    expect(page.nextCursor).toBe(encodeCatalogCursor({ createdAt, id: "00000000-0000-7000-8000-0000000000bb" }));

    const next = await repo.listActiveProducts({ limit: 1, cursor: page.nextCursor });
    expect(next.items.map((i) => i.slug)).toEqual(["a"]);
  });

  it("returns an empty page for a malformed cursor", async () => {
    const page = await repo.listActiveProducts({ limit: 10, cursor: "not-a-cursor" });
    expect(page).toEqual({ items: [], nextCursor: null });
  });
});

describe("catalog repository: product detail", () => {
  it("returns full detail with active variants and ordered images", async () => {
    const product = addProduct({
      name: "Camper",
      slug: "camper",
      description: "A cozy camper",
      categoryId: category.id,
    });
    addVariant(product.id, { name: "Old / draft", status: "draft", priceAmountCents: 100, sku: "draft-sku" });
    addVariant(product.id, { name: "Two-person", priceAmountCents: 1_500, sku: "camper-t2" });
    addVariant(product.id, { name: "Four-person", priceAmountCents: 2_000, sku: "camper-t4" });
    seedImage(db, { productId: product.id, isPrimary: 0, sortOrder: 1, url: "https://cdn.example.test/side.jpg" });
    seedImage(db, { productId: product.id, isPrimary: 1, sortOrder: 0, url: "https://cdn.example.test/hero.jpg" });

    const detail = await repo.findProductBySlug("camper");

    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("Camper");
    expect(detail!.store).toMatchObject({ id: store.id, slug: "active-store", name: "Active Store" });
    expect(detail!.category).toEqual({ id: category.id, slug: category.slug, name: category.name });
    expect(detail!.variants.map((v) => v.name)).toEqual(["Two-person", "Four-person"]);
    expect(detail!.variants[0]).toMatchObject({ sku: "camper-t2", priceAmountCents: 1_500, currency: "USD" });
    expect(detail!.images.map((i) => i.url)).toEqual([
      "https://cdn.example.test/hero.jpg",
      "https://cdn.example.test/side.jpg",
    ]);
    expect(detail!.images[0]!.isPrimary).toBe(true);
  });

  it("resolves nothing for a draft product or an unknown slug", async () => {
    addProduct({ slug: "secret", status: "draft" });
    expect(await repo.findProductBySlug("secret")).toBeNull();
    expect(await repo.findProductBySlug("missing")).toBeNull();
  });
});

function addVariant(productId: string, overrides: Partial<typeof schema.productVariants.$inferInsert> = {}) {
  seq += 1;
  return db
    .insert(schema.productVariants)
    .values({
      productId,
      name: `Variant ${seq}`,
      sku: `sku-${seq}`,
      priceAmountCents: 1_000,
      currency: "USD",
      status: "active",
      ...overrides,
    })
    .returning()
    .get();
}