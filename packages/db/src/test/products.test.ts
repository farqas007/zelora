import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { LocalDatabase } from "../client";
import * as schema from "../schema";
import { createLocalProductRepository } from "../products/local-repository";
import { createTestDatabase } from "./helpers";

/**
 * Real-SQLite integration tests for the product repository. Each test runs on
 * an isolated in-memory database with the committed migrations applied. The
 * fixtures build the seller scaffolding (user → profile → store) plus an
 * active category, then assert what creation stores, what stays `draft`, and
 * that the `(store_id, slug)` UNIQUE constraint is (and remains) the
 * race-condition backstop.
 */

let seq = 0;

interface Scaffold {
  storeId: string;
  categoryId: string;
  otherStoreId: string;
}

function seedScaffold(db: LocalDatabase): Scaffold {
  seq += 1;
  const userId = db
    .insert(schema.users)
    .values({ email: `product-user-${seq}@example.test`, name: "Product Seller" })
    .returning({ id: schema.users.id })
    .get().id;
  const profile = db
    .insert(schema.sellerProfiles)
    .values({ userId, slug: `product-profile-${seq}`, displayName: "Product Seller" })
    .returning({ id: schema.sellerProfiles.id })
    .get();
  const store = db
    .insert(schema.stores)
    .values({ sellerProfileId: profile.id, name: `Store ${seq}`, slug: `product-store-${seq}` })
    .returning({ id: schema.stores.id })
    .get();
  const otherUserId = db
    .insert(schema.users)
    .values({ email: `product-other-${seq}@example.test`, name: "Other Seller" })
    .returning({ id: schema.users.id })
    .get().id;
  const otherProfile = db
    .insert(schema.sellerProfiles)
    .values({ userId: otherUserId, slug: `product-profile-${seq}-b`, displayName: "Other Profile" })
    .returning({ id: schema.sellerProfiles.id })
    .get();
  const otherStore = db
    .insert(schema.stores)
    .values({ sellerProfileId: otherProfile.id, name: `Other ${seq}`, slug: `product-other-${seq}` })
    .returning({ id: schema.stores.id })
    .get();
  const category = db
    .insert(schema.categories)
    .values({ name: `Category ${seq}`, slug: `product-category-${seq}`, status: "active" })
    .returning({ id: schema.categories.id })
    .get();

  return { storeId: store.id, categoryId: category.id, otherStoreId: otherStore.id };
}

let db: LocalDatabase;
let repo: ReturnType<typeof createLocalProductRepository>;
let scaffold: Scaffold;

beforeEach(() => {
  ({ db } = createTestDatabase());
  repo = createLocalProductRepository(db);
  seq = 0;
  scaffold = seedScaffold(db);
});

describe("product repository: createProduct", () => {
  it("creates a product row with all input fields and a draft status by default", async () => {
    const result = await repo.createProduct({
      storeId: scaffold.storeId,
      categoryId: scaffold.categoryId,
      name: "Vintage Camera",
      slug: "vintage-camera",
      description: "A lovely film camera.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a successful create");
    }

    const row = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, result.product.id))
      .get();

    expect(row).toMatchObject({
      id: result.product.id,
      storeId: scaffold.storeId,
      categoryId: scaffold.categoryId,
      name: "Vintage Camera",
      slug: "vintage-camera",
      description: "A lovely film camera.",
      status: "draft",
    });
    // The returned product mirrors the persisted row.
    expect(result.product.status).toBe("draft");
    expect(result.product.createdAt).toBeInstanceOf(Date);
    expect(result.product.updatedAt).toBeInstanceOf(Date);
  });

  it("persists null description and null category when omitted", async () => {
    const result = await repo.createProduct({
      storeId: scaffold.storeId,
      categoryId: null,
      name: "Bare Listing",
      slug: "bare-listing",
      description: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a successful create");
    }
    expect(result.product.description).toBeNull();
    expect(result.product.categoryId).toBeNull();
  });
});

describe("product repository: uniqueness", () => {
  it("rejects a duplicate slug within the same store as PRODUCT_SLUG_IN_USE", async () => {
    const first = await repo.createProduct({
      storeId: scaffold.storeId,
      categoryId: null,
      name: "First",
      slug: "same-slug",
      description: null,
    });
    expect(first.ok).toBe(true);

    const second = await repo.createProduct({
      storeId: scaffold.storeId,
      categoryId: null,
      name: "Second",
      slug: "same-slug",
      description: null,
    });

    expect(second).toEqual({ ok: false, reason: "PRODUCT_SLUG_IN_USE" });
  });

  it("allows the same slug in a different store (uniqueness is per store)", async () => {
    const first = await repo.createProduct({
      storeId: scaffold.storeId,
      categoryId: null,
      name: "Mine",
      slug: "shared-slug",
      description: null,
    });
    const second = await repo.createProduct({
      storeId: scaffold.otherStoreId,
      categoryId: null,
      name: "Theirs",
      slug: "shared-slug",
      description: null,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("findByStoreAndSlug resolves only within the given store", async () => {
    await repo.createProduct({
      storeId: scaffold.storeId,
      categoryId: null,
      name: "Mine",
      slug: "scoped-slug",
      description: null,
    });

    const inStore = await repo.findByStoreAndSlug(scaffold.storeId, "scoped-slug");
    const inOtherStore = await repo.findByStoreAndSlug(scaffold.otherStoreId, "scoped-slug");

    expect(inStore).not.toBeNull();
    expect(inStore!.storeId).toBe(scaffold.storeId);
    expect(inOtherStore).toBeNull();
  });

  it("findByStoreAndSlug returns null for an unknown slug", async () => {
    expect(await repo.findByStoreAndSlug(scaffold.storeId, "missing")).toBeNull();
  });
});

describe("product repository: seller reads", () => {
  it("lists only one store's products newest-first and paginates with a cursor", async () => {
    const own = db
      .insert(schema.products)
      .values([
        {
          storeId: scaffold.storeId,
          name: "Draft",
          slug: "seller-draft",
          status: "draft",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          storeId: scaffold.storeId,
          name: "Archived",
          slug: "seller-archived",
          status: "archived",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          storeId: scaffold.storeId,
          name: "Active",
          slug: "seller-active",
          status: "active",
          createdAt: new Date("2026-01-03T00:00:00.000Z"),
        },
      ])
      .returning()
      .all();
    expect(own).toHaveLength(3);
    db.insert(schema.products)
      .values({
        storeId: scaffold.otherStoreId,
        name: "Other",
        slug: "other-product",
        status: "active",
        createdAt: new Date("2026-01-04T00:00:00.000Z"),
      })
      .run();

    const first = await repo.listByStore(scaffold.storeId, { limit: 2, cursor: null });

    expect(first.items.map((product) => product.slug)).toEqual(["seller-active", "seller-archived"]);
    expect(first.items.map((product) => product.status)).toEqual(["active", "archived"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await repo.listByStore(scaffold.storeId, {
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(second.items.map((product) => product.slug)).toEqual(["seller-draft"]);
    expect(second.nextCursor).toBeNull();
  });

  it("uses the product id as a stable pagination tie-break", async () => {
    const createdAt = new Date("2026-02-01T00:00:00.000Z");
    const inserted = db
      .insert(schema.products)
      .values([
        { storeId: scaffold.storeId, name: "One", slug: "tie-one", createdAt },
        { storeId: scaffold.storeId, name: "Two", slug: "tie-two", createdAt },
      ])
      .returning()
      .all();
    const expected = [...inserted].sort((left, right) => right.id.localeCompare(left.id));

    const page = await repo.listByStore(scaffold.storeId, { limit: 2, cursor: null });

    expect(page.items.map((product) => product.id)).toEqual(expected.map((product) => product.id));
  });

  it("returns an empty page for a malformed cursor", async () => {
    expect(await repo.listByStore(scaffold.storeId, { limit: 20, cursor: "not-a-cursor" })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("returns owned detail with ordered variants and nullable inventory", async () => {
    const product = db
      .insert(schema.products)
      .values({
        storeId: scaffold.storeId,
        categoryId: scaffold.categoryId,
        name: "Detailed",
        slug: "detailed",
        description: "Seller detail",
      })
      .returning()
      .get();
    const variants = db
      .insert(schema.productVariants)
      .values([
        {
          productId: product.id,
          name: "First",
          priceAmountCents: 1000,
          currency: "USD",
          status: "active",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
        {
          productId: product.id,
          name: "Second",
          priceAmountCents: 2000,
          currency: "USD",
          status: "inactive",
          createdAt: new Date("2026-03-02T00:00:00.000Z"),
        },
      ])
      .returning()
      .all();
    db.insert(schema.inventory)
      .values({ variantId: variants[1]!.id, quantity: 4, updatedAt: new Date("2026-03-02T01:00:00.000Z") })
      .run();

    const detail = await repo.findByStoreAndId(scaffold.storeId, product.id);

    expect(detail).toMatchObject({
      id: product.id,
      storeId: scaffold.storeId,
      description: "Seller detail",
    });
    expect(detail?.variants.map((variant) => variant.name)).toEqual(["First", "Second"]);
    expect(detail?.variants[0]?.inventory).toBeNull();
    expect(detail?.variants[1]?.inventory).toMatchObject({
      variantId: variants[1]!.id,
      quantity: 4,
    });
  });

  it("returns null for unknown and cross-store product detail", async () => {
    const other = db
      .insert(schema.products)
      .values({ storeId: scaffold.otherStoreId, name: "Other", slug: "other-detail" })
      .returning()
      .get();

    expect(await repo.findByStoreAndId(scaffold.storeId, other.id)).toBeNull();
    expect(
      await repo.findByStoreAndId(
        scaffold.storeId,
        "01955f00-0000-7000-8000-000000000001",
      ),
    ).toBeNull();
  });
});

describe("product repository: product images", () => {
  /** Insert a product owned by `storeId` and return its id. */
  function seedProduct(storeId: string, slug: string): string {
    return db
      .insert(schema.products)
      .values({ storeId, name: slug, slug })
      .returning()
      .get().id;
  }

  it("returns images primary-first, then by sortOrder, then by id, with the flag as a boolean", async () => {
    const productId = seedProduct(scaffold.storeId, "media-order");
    db.insert(schema.productImages)
      .values([
        { productId, url: "https://cdn.test/hero.jpg", sortOrder: 9, isPrimary: 1 },
        { productId, url: "https://cdn.test/c.jpg", sortOrder: 2, isPrimary: 0 },
        { productId, url: "https://cdn.test/b.jpg", sortOrder: 2, isPrimary: 0 },
        { productId, url: "https://cdn.test/front.jpg", sortOrder: 0, isPrimary: 0 },
      ])
      .run();
    // The two `sortOrder: 2` rows tie, so their relative order is decided by id.
    const tiedIds = db
      .select({ id: schema.productImages.id, url: schema.productImages.url })
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, productId))
      .all()
      .filter((row) => row.url.endsWith("b.jpg") || row.url.endsWith("c.jpg"))
      .sort((left, right) => left.id.localeCompare(right.id));
    const tiedUrls = tiedIds.map((row) => row.url);

    const listed = await repo.listImagesByProduct(productId, scaffold.storeId);

    expect(listed.map((image) => image.url)).toEqual([
      "https://cdn.test/hero.jpg",
      "https://cdn.test/front.jpg",
      ...tiedUrls,
    ]);
    expect(listed.map((image) => image.isPrimary)).toEqual([true, false, false, false]);
    expect(listed[0]).toMatchObject({ productId, sortOrder: 9, altText: null });
  });

  it("returns another product's images never, and hides images of a product in another store", async () => {
    const ownProductId = seedProduct(scaffold.storeId, "media-own");
    const otherProductId = seedProduct(scaffold.storeId, "media-sibling");
    const foreignProductId = seedProduct(scaffold.otherStoreId, "media-foreign");
    db.insert(schema.productImages)
      .values([
        { productId: otherProductId, url: "https://cdn.test/sibling.jpg", isPrimary: 1 },
        { productId: foreignProductId, url: "https://cdn.test/foreign.jpg", isPrimary: 1 },
      ])
      .run();
    db.insert(schema.productImages)
      .values({ productId: ownProductId, url: "https://cdn.test/own.jpg", isPrimary: 1 })
      .run();

    expect(
      (await repo.listImagesByProduct(ownProductId, scaffold.storeId)).map((image) => image.url),
    ).toEqual(["https://cdn.test/own.jpg"]);
    expect(
      (await repo.listImagesByProduct(foreignProductId, scaffold.storeId)).map((image) => image.url),
    ).toEqual([]);
    expect(
      (await repo.listImagesByProduct(
        "01955f00-0000-7000-8000-000000000001",
        scaffold.storeId,
      )).map((image) => image.url),
    ).toEqual([]);
  });

  it("returns an empty list for a product that has no images", async () => {
    const productId = seedProduct(scaffold.storeId, "media-empty");

    expect(await repo.listImagesByProduct(productId, scaffold.storeId)).toEqual([]);
  });

  it("embeds the same ordered images in owned product detail", async () => {
    const productId = seedProduct(scaffold.storeId, "media-detail");
    db.insert(schema.productImages)
      .values([
        { productId, url: "https://cdn.test/second.jpg", sortOrder: 1, isPrimary: 0 },
        { productId, url: "https://cdn.test/primary.jpg", sortOrder: 5, isPrimary: 1, altText: "Hero" },
      ])
      .run();

    const detail = await repo.findByStoreAndId(scaffold.storeId, productId);

    expect(detail?.images.map((image) => image.url)).toEqual([
      "https://cdn.test/primary.jpg",
      "https://cdn.test/second.jpg",
    ]);
    expect(detail?.images[0]?.altText).toBe("Hero");
    expect(detail?.images[0]?.isPrimary).toBe(true);
  });

  it("returns an empty image list in detail for a product with no images", async () => {
    const productId = seedProduct(scaffold.storeId, "media-detail-empty");

    const detail = await repo.findByStoreAndId(scaffold.storeId, productId);

    expect(detail?.images).toEqual([]);
  });
});

describe("product repository: addProductImages", () => {
  /** Insert a product owned by `storeId` and return its id. */
  function seedProduct(storeId: string, slug: string): string {
    return db
      .insert(schema.products)
      .values({ storeId, name: slug, slug })
      .returning()
      .get().id;
  }

  /** Count rows directly, so "wrote nothing" is asserted against the table. */
  function countImages(productId: string): number {
    return db
      .select({ id: schema.productImages.id })
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, productId))
      .all().length;
  }

  it("inserts every submitted image with its url and storage key, all non-primary", async () => {
    const productId = seedProduct(scaffold.storeId, "append-basic");

    const result = await repo.addProductImages({
      productId,
      storeId: scaffold.storeId,
      images: [
        {
          url: "https://media.test/products/p/front.jpg",
          storageKey: "products/p/front.jpg",
          altText: "Front",
          sortOrder: 0,
        },
        {
          url: "https://media.test/products/p/back.jpg",
          storageKey: "products/p/back.jpg",
          altText: null,
          sortOrder: 1,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.images).toHaveLength(2);
    expect(result.images.map((image) => image.storageKey)).toEqual([
      "products/p/front.jpg",
      "products/p/back.jpg",
    ]);
    expect(result.images.map((image) => image.url)).toEqual([
      "https://media.test/products/p/front.jpg",
      "https://media.test/products/p/back.jpg",
    ]);
    // isPrimary is not expressible by the caller, so every row is non-primary
    // and the one-primary-per-product partial unique index is never at risk.
    expect(result.images.every((image) => image.isPrimary === false)).toBe(true);
    expect(result.images.every((image) => image.productId === productId)).toBe(true);
    expect(countImages(productId)).toBe(2);
  });

  it("stores an explicit null storage key for a URL-only image", async () => {
    const productId = seedProduct(scaffold.storeId, "append-url-only");

    const result = await repo.addProductImages({
      productId,
      storeId: scaffold.storeId,
      images: [{ url: "https://cdn.test/external.jpg", storageKey: null, altText: null, sortOrder: 0 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.images[0]?.storageKey).toBeNull();
  });

  it("returns the rows in submission order, not the canonical read order", async () => {
    const productId = seedProduct(scaffold.storeId, "append-order");

    const result = await repo.addProductImages({
      productId,
      storeId: scaffold.storeId,
      images: [
        { url: "https://media.test/c.jpg", storageKey: "c.jpg", altText: null, sortOrder: 2 },
        { url: "https://media.test/a.jpg", storageKey: "a.jpg", altText: null, sortOrder: 0 },
        { url: "https://media.test/b.jpg", storageKey: "b.jpg", altText: null, sortOrder: 1 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The read path owns the ordering rule; the insert path must not
    // second-guess it or renumber the caller's sortOrder values.
    expect(result.images.map((image) => image.storageKey)).toEqual(["c.jpg", "a.jpg", "b.jpg"]);
    expect(result.images.map((image) => image.sortOrder)).toEqual([2, 0, 1]);
  });

  it("appends to existing images and exposes both through the ownership-scoped read", async () => {
    const productId = seedProduct(scaffold.storeId, "append-existing");
    db.insert(schema.productImages)
      .values({ productId, url: "https://cdn.test/existing.jpg", isPrimary: 1 })
      .run();

    await repo.addProductImages({
      productId,
      storeId: scaffold.storeId,
      images: [{ url: "https://media.test/new.jpg", storageKey: "new.jpg", altText: null, sortOrder: 0 }],
    });

    const listed = await repo.listImagesByProduct(productId, scaffold.storeId);
    expect(listed.map((image) => image.url)).toEqual([
      "https://cdn.test/existing.jpg",
      "https://media.test/new.jpg",
    ]);
    // The pre-existing primary keeps the flag; the appended row stays non-primary.
    expect(listed.map((image) => image.isPrimary)).toEqual([true, false]);
    // A pre-existing URL-only row reads back as null, never as a fabricated "".
    expect(listed[0]?.storageKey).toBeNull();
    expect(listed[1]?.storageKey).toBe("new.jpg");
  });

  it("rejects a product owned by another store and writes nothing", async () => {
    const foreignProductId = seedProduct(scaffold.otherStoreId, "append-foreign");

    const result = await repo.addProductImages({
      productId: foreignProductId,
      storeId: scaffold.storeId,
      images: [{ url: "https://media.test/x.jpg", storageKey: "x.jpg", altText: null, sortOrder: 0 }],
    });

    expect(result).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
    expect(countImages(foreignProductId)).toBe(0);
  });

  it("rejects an unknown product id without writing anything", async () => {
    const result = await repo.addProductImages({
      productId: "01955f00-0000-7000-8000-000000000001",
      storeId: scaffold.storeId,
      images: [{ url: "https://media.test/x.jpg", storageKey: "x.jpg", altText: null, sortOrder: 0 }],
    });

    expect(result).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
  });

  it("makes an empty batch a checked no-op, so a foreign product is still rejected", async () => {
    const ownProductId = seedProduct(scaffold.storeId, "append-empty-own");
    const foreignProductId = seedProduct(scaffold.otherStoreId, "append-empty-foreign");

    expect(await repo.addProductImages({ productId: ownProductId, storeId: scaffold.storeId, images: [] }))
      .toEqual({ ok: true, images: [] });
    expect(
      await repo.addProductImages({ productId: foreignProductId, storeId: scaffold.storeId, images: [] }),
    ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
  });

  it("does not disturb another product's images", async () => {
    const productId = seedProduct(scaffold.storeId, "append-isolated-a");
    const siblingId = seedProduct(scaffold.storeId, "append-isolated-b");
    db.insert(schema.productImages)
      .values({ productId: siblingId, url: "https://cdn.test/sibling.jpg", isPrimary: 1 })
      .run();

    await repo.addProductImages({
      productId,
      storeId: scaffold.storeId,
      images: [{ url: "https://media.test/a.jpg", storageKey: "a.jpg", altText: null, sortOrder: 0 }],
    });

    expect(countImages(siblingId)).toBe(1);
  });
});
