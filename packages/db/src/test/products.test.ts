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

/**
 * Image management on the local driver: count, delete and primary promotion.
 *
 * The D1 driver is a method-for-method twin of this one (same ownership guard,
 * same reasons, same clear-then-set order), so these tests are also the
 * behavioural spec the D1 implementation is written against. True D1 runtime
 * tests would need `workerd`, which is not a dependency of this repository.
 */
describe("product repository: image management", () => {
  /** Insert a product owned by `storeId` and return its id. */
  function seedProduct(storeId: string, slug: string): string {
    return db
      .insert(schema.products)
      .values({ storeId, name: slug, slug })
      .returning()
      .get().id;
  }

  /** Insert one image and return its id. */
  function seedImage(
    productId: string,
    overrides: Partial<typeof schema.productImages.$inferInsert> = {},
  ): string {
    return db
      .insert(schema.productImages)
      .values({ productId, url: "https://media.test/a.jpg", ...overrides })
      .returning()
      .get().id;
  }

  /** Read every image of a product straight from the table, in insertion order. */
  function readImages(productId: string): Array<{ url: string; isPrimary: number; sortOrder: number }> {
    return db
      .select({
        url: schema.productImages.url,
        isPrimary: schema.productImages.isPrimary,
        sortOrder: schema.productImages.sortOrder,
      })
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, productId))
      .all();
  }

  describe("countImagesByProduct", () => {
    it("counts a product's own images", async () => {
      const productId = seedProduct(scaffold.storeId, "count-own");
      seedImage(productId);
      seedImage(productId, { url: "https://media.test/b.jpg" });

      expect(await repo.countImagesByProduct(productId, scaffold.storeId)).toBe(2);
    });

    it("counts zero for a product with no images", async () => {
      const productId = seedProduct(scaffold.storeId, "count-empty");

      expect(await repo.countImagesByProduct(productId, scaffold.storeId)).toBe(0);
    });

    it("counts zero — not an error — for an unknown or unowned product", async () => {
      const foreign = seedProduct(scaffold.otherStoreId, "count-foreign");
      seedImage(foreign);

      // The count is a pre-check for the per-product cap, so it leaks nothing:
      // an unowned product is indistinguishable from an empty one.
      expect(await repo.countImagesByProduct(foreign, scaffold.storeId)).toBe(0);
      expect(await repo.countImagesByProduct("01955f00-0000-7000-8000-000000000001", scaffold.storeId))
        .toBe(0);
    });

    it("never counts another product's images", async () => {
      const first = seedProduct(scaffold.storeId, "count-iso-a");
      const second = seedProduct(scaffold.storeId, "count-iso-b");
      seedImage(first);
      seedImage(second);
      seedImage(second);

      expect(await repo.countImagesByProduct(first, scaffold.storeId)).toBe(1);
      expect(await repo.countImagesByProduct(second, scaffold.storeId)).toBe(2);
    });
  });

  describe("deleteProductImage", () => {
    it("removes the row and returns it", async () => {
      const productId = seedProduct(scaffold.storeId, "delete-own");
      const imageId = seedImage(productId, { storageKey: "products/p/a.jpg" });

      const result = await repo.deleteProductImage({ productId, imageId, storeId: scaffold.storeId });

      expect(result).toEqual({
        ok: true,
        image: expect.objectContaining({ id: imageId, storageKey: "products/p/a.jpg" }),
      });
      expect(readImages(productId)).toEqual([]);
    });

    it("leaves the product's other images, and their order, untouched", async () => {
      const productId = seedProduct(scaffold.storeId, "delete-siblings");
      seedImage(productId, { url: "https://media.test/a.jpg", isPrimary: 1, sortOrder: 0 });
      const target = seedImage(productId, { url: "https://media.test/b.jpg", sortOrder: 1 });
      seedImage(productId, { url: "https://media.test/c.jpg", sortOrder: 2 });

      await repo.deleteProductImage({ productId, imageId: target, storeId: scaffold.storeId });

      expect(readImages(productId).map((image) => image.url)).toEqual([
        "https://media.test/a.jpg",
        "https://media.test/c.jpg",
      ]);
      // No renumbering: the surviving sort orders keep their gaps.
      expect(readImages(productId).map((image) => image.sortOrder)).toEqual([0, 2]);
    });

    it("deleting the primary leaves the product with no primary, without promoting another", async () => {
      const productId = seedProduct(scaffold.storeId, "delete-primary");
      const primaryId = seedImage(productId, { url: "https://media.test/a.jpg", isPrimary: 1 });
      seedImage(productId, { url: "https://media.test/b.jpg", sortOrder: 1 });

      await repo.deleteProductImage({ productId, imageId: primaryId, storeId: scaffold.storeId });

      expect(readImages(productId).map((image) => image.isPrimary)).toEqual([0]);
    });

    it("reports an unowned product as PRODUCT_NOT_FOUND and deletes nothing", async () => {
      const foreign = seedProduct(scaffold.otherStoreId, "delete-foreign");
      const imageId = seedImage(foreign);

      const result = await repo.deleteProductImage({
        productId: foreign,
        imageId,
        storeId: scaffold.storeId,
      });

      expect(result).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
      expect(readImages(foreign)).toHaveLength(1);
    });

    it("reports an unknown product as PRODUCT_NOT_FOUND", async () => {
      expect(
        await repo.deleteProductImage({
          productId: "01955f00-0000-7000-8000-000000000001",
          imageId: "01955f00-0000-7000-8000-000000000002",
          storeId: scaffold.storeId,
        }),
      ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
    });

    it("reports an image of another product as IMAGE_NOT_FOUND and deletes nothing", async () => {
      const first = seedProduct(scaffold.storeId, "delete-wrong-product-a");
      const second = seedProduct(scaffold.storeId, "delete-wrong-product-b");
      const imageId = seedImage(second);

      const result = await repo.deleteProductImage({
        productId: first,
        imageId,
        storeId: scaffold.storeId,
      });

      expect(result).toEqual({ ok: false, reason: "IMAGE_NOT_FOUND" });
      expect(readImages(second)).toHaveLength(1);
    });

    it("reports an unknown image id as IMAGE_NOT_FOUND", async () => {
      const productId = seedProduct(scaffold.storeId, "delete-unknown-image");
      seedImage(productId);

      expect(
        await repo.deleteProductImage({
          productId,
          imageId: "01955f00-0000-7000-8000-000000000002",
          storeId: scaffold.storeId,
        }),
      ).toEqual({ ok: false, reason: "IMAGE_NOT_FOUND" });
    });
  });

  describe("setPrimaryProductImage", () => {
    it("promotes an image and demotes the previous primary", async () => {
      const productId = seedProduct(scaffold.storeId, "promote-swap");
      seedImage(productId, { url: "https://media.test/a.jpg", isPrimary: 1, sortOrder: 0 });
      const target = seedImage(productId, { url: "https://media.test/b.jpg", sortOrder: 1 });

      const result = await repo.setPrimaryProductImage({
        productId,
        imageId: target,
        storeId: scaffold.storeId,
      });

      expect(result).toEqual({
        ok: true,
        image: expect.objectContaining({ id: target, isPrimary: true }),
      });
      expect(readImages(productId).map((image) => image.isPrimary)).toEqual([0, 1]);
    });

    it("leaves every other row and its sort order untouched", async () => {
      const productId = seedProduct(scaffold.storeId, "promote-only-flag");
      seedImage(productId, { url: "https://media.test/a.jpg", isPrimary: 1, sortOrder: 0 });
      const target = seedImage(productId, { url: "https://media.test/b.jpg", sortOrder: 5 });
      seedImage(productId, { url: "https://media.test/c.jpg", sortOrder: 9 });

      await repo.setPrimaryProductImage({ productId, imageId: target, storeId: scaffold.storeId });

      expect(readImages(productId).map((image) => image.sortOrder)).toEqual([0, 5, 9]);
    });

    it("is idempotent, so re-promoting the current primary succeeds and changes nothing", async () => {
      const productId = seedProduct(scaffold.storeId, "promote-idempotent");
      const primaryId = seedImage(productId, { url: "https://media.test/a.jpg", isPrimary: 1 });

      const first = await repo.setPrimaryProductImage({
        productId,
        imageId: primaryId,
        storeId: scaffold.storeId,
      });
      const second = await repo.setPrimaryProductImage({
        productId,
        imageId: primaryId,
        storeId: scaffold.storeId,
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(readImages(productId).map((image) => image.isPrimary)).toEqual([1]);
    });

    it("promoting back and forth leaves exactly one primary at every step", async () => {
      const productId = seedProduct(scaffold.storeId, "promote-round-trip");
      const first = seedImage(productId, { url: "https://media.test/a.jpg" });
      const second = seedImage(productId, { url: "https://media.test/b.jpg", sortOrder: 1 });

      await repo.setPrimaryProductImage({ productId, imageId: first, storeId: scaffold.storeId });
      expect(readImages(productId).map((image) => image.isPrimary)).toEqual([1, 0]);

      await repo.setPrimaryProductImage({ productId, imageId: second, storeId: scaffold.storeId });
      expect(readImages(productId).map((image) => image.isPrimary)).toEqual([0, 1]);
    });

    it("puts the promoted image first in the canonical read order", async () => {
      const productId = seedProduct(scaffold.storeId, "promote-read-order");
      seedImage(productId, { url: "https://media.test/a.jpg", isPrimary: 1, sortOrder: 0 });
      seedImage(productId, { url: "https://media.test/b.jpg", sortOrder: 1 });
      const last = seedImage(productId, { url: "https://media.test/c.jpg", sortOrder: 2 });

      await repo.setPrimaryProductImage({ productId, imageId: last, storeId: scaffold.storeId });

      expect((await repo.listImagesByProduct(productId, scaffold.storeId)).map((image) => image.url))
        .toEqual(["https://media.test/c.jpg", "https://media.test/a.jpg", "https://media.test/b.jpg"]);
    });

    it("reports an unowned product as PRODUCT_NOT_FOUND and promotes nothing", async () => {
      const foreign = seedProduct(scaffold.otherStoreId, "promote-foreign");
      const imageId = seedImage(foreign);

      expect(
        await repo.setPrimaryProductImage({
          productId: foreign,
          imageId,
          storeId: scaffold.storeId,
        }),
      ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
      expect(readImages(foreign).map((image) => image.isPrimary)).toEqual([0]);
    });

    it("reports an unknown product as PRODUCT_NOT_FOUND", async () => {
      expect(
        await repo.setPrimaryProductImage({
          productId: "01955f00-0000-7000-8000-000000000001",
          imageId: "01955f00-0000-7000-8000-000000000002",
          storeId: scaffold.storeId,
        }),
      ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
    });

    it("reports an image of another product as IMAGE_NOT_FOUND and promotes nothing", async () => {
      const first = seedProduct(scaffold.storeId, "promote-wrong-product-a");
      const second = seedProduct(scaffold.storeId, "promote-wrong-product-b");
      const imageId = seedImage(second);

      expect(
        await repo.setPrimaryProductImage({ productId: first, imageId, storeId: scaffold.storeId }),
      ).toEqual({ ok: false, reason: "IMAGE_NOT_FOUND" });
      expect(readImages(second).map((image) => image.isPrimary)).toEqual([0]);
    });

    it("reports an unknown image id as IMAGE_NOT_FOUND", async () => {
      const productId = seedProduct(scaffold.storeId, "promote-unknown-image");
      seedImage(productId, { isPrimary: 1 });

      expect(
        await repo.setPrimaryProductImage({
          productId,
          imageId: "01955f00-0000-7000-8000-000000000002",
          storeId: scaffold.storeId,
        }),
      ).toEqual({ ok: false, reason: "IMAGE_NOT_FOUND" });
      // A refused promotion must not have demoted the existing primary.
      expect(readImages(productId).map((image) => image.isPrimary)).toEqual([1]);
    });
  });

  describe("reorderProductImages", () => {
    /**
     * Seed `count` images with distinct urls and an ascending sort order, and
     * return their ids in insertion order.
     */
    function seedGallery(productId: string, count: number): string[] {
      return Array.from({ length: count }, (_unused, index) =>
        seedImage(productId, {
          url: `https://media.test/${index}.jpg`,
          sortOrder: index,
        }),
      );
    }

    /**
     * `{ imageId: sortOrder }` for a product, read straight from the table.
     *
     * Keyed by id rather than returned as a positional array because
     * {@link readImages} carries no `ORDER BY`: SQLite happens to answer it from
     * a covering index, but nothing promises that order, and a positional
     * assertion about sort orders would be asserting the accident instead of the
     * write. Every assertion below is about *which* image holds *which* order.
     */
    function sortOrdersById(productId: string): Record<string, number> {
      return Object.fromEntries(
        db
          .select({ id: schema.productImages.id, sortOrder: schema.productImages.sortOrder })
          .from(schema.productImages)
          .where(eq(schema.productImages.productId, productId))
          .all()
          .map((image) => [image.id, image.sortOrder]),
      );
    }

    it("applies a new order and returns the images in it", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-apply");
      const [a, b, c] = seedGallery(productId, 3) as [string, string, string];

      const result = await repo.reorderProductImages({
        productId,
        storeId: scaffold.storeId,
        imageIds: [c, a, b],
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.images.map((image) => image.id)).toEqual([c, a, b]);
      expect(sortOrdersById(productId)).toEqual({ [a]: 1, [b]: 2, [c]: 0 });
    });

    it("rewrites a descending order to a dense ascending sequence", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-dense");
      const [a, b, c, d] = seedGallery(productId, 4) as [string, string, string, string];

      await repo.reorderProductImages({
        productId,
        storeId: scaffold.storeId,
        imageIds: [d, c, b, a],
      });

      // Dense 0..n-1, not the submitted 3,2,1,0: the contract is relative
      // order, and the canonical read order depends on those values being a
      // clean sequence.
      expect(sortOrdersById(productId)).toEqual({ [a]: 3, [b]: 2, [c]: 1, [d]: 0 });
    });

    it("accepts an empty list for a product with no images as a no-op", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-empty");

      const result = await repo.reorderProductImages({
        productId,
        storeId: scaffold.storeId,
        imageIds: [],
      });

      expect(result).toEqual({ ok: true, images: [] });
    });

    it("does not promote, demote or clear the primary when it is submitted last", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-primary-last");
      const primary = seedImage(productId, { url: "https://media.test/hero.jpg", isPrimary: 1 });
      const first = seedImage(productId, { url: "https://media.test/1.jpg", sortOrder: 1 });
      const second = seedImage(productId, { url: "https://media.test/2.jpg", sortOrder: 2 });

      const result = await repo.reorderProductImages({
        productId,
        storeId: scaffold.storeId,
        imageIds: [first, second, primary],
      });

      expect(readImages(productId).map((image) => image.isPrimary)).toEqual([0, 0, 1]);
      // Primary first, then the new relative order of the rest.
      expect(result.ok && result.images.map((image) => image.url)).toEqual([
        "https://media.test/hero.jpg",
        "https://media.test/1.jpg",
        "https://media.test/2.jpg",
      ]);
    });

    it("does not create a primary when the product has none", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-no-primary");
      const [a, b] = seedGallery(productId, 2) as [string, string];

      await repo.reorderProductImages({
        productId,
        storeId: scaffold.storeId,
        imageIds: [b, a],
      });

      expect(readImages(productId).map((image) => image.isPrimary)).toEqual([0, 0]);
    });

    it("ignores the submitted order of another product's images", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-isolated-a");
      const other = seedProduct(scaffold.storeId, "reorder-isolated-b");
      const [a, b] = seedGallery(productId, 2) as [string, string];
      const [c] = seedGallery(other, 1) as [string];

      await repo.reorderProductImages({
        productId,
        storeId: scaffold.storeId,
        imageIds: [b, a],
      });

      // The `WHERE product_id` bound is what keeps a reorder from reaching
      // across products; `c` is in a different product and must be untouched.
      expect(sortOrdersById(other)).toEqual({ [c]: 0 });
      expect(sortOrdersById(productId)).toEqual({ [a]: 1, [b]: 0 });
    });

    it("reports an unowned product as PRODUCT_NOT_FOUND and writes nothing", async () => {
      const foreign = seedProduct(scaffold.otherStoreId, "reorder-foreign");
      const [a, b] = seedGallery(foreign, 2) as [string, string];

      expect(
        await repo.reorderProductImages({
          productId: foreign,
          storeId: scaffold.storeId,
          imageIds: [b, a],
        }),
      ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
      expect(sortOrdersById(foreign)).toEqual({ [a]: 0, [b]: 1 });
    });

    it("reports an unknown product as PRODUCT_NOT_FOUND", async () => {
      expect(
        await repo.reorderProductImages({
          productId: "01955f00-0000-7000-8000-000000000001",
          storeId: scaffold.storeId,
          imageIds: [],
        }),
      ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
    });

    it("rejects a partial list and leaves every sort order untouched", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-partial");
      const [a, b, c] = seedGallery(productId, 3) as [string, string, string];

      expect(
        await repo.reorderProductImages({
          productId,
          storeId: scaffold.storeId,
          imageIds: [c, a],
        }),
      ).toEqual({ ok: false, reason: "IMAGE_SET_MISMATCH" });
      // The no-partial-mutation guarantee: not one row moved.
      expect(sortOrdersById(productId)).toEqual({ [a]: 0, [b]: 1, [c]: 2 });
    });

    it("rejects a duplicated id and leaves every sort order untouched", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-duplicate");
      const [a, b] = seedGallery(productId, 2) as [string, string];

      expect(
        await repo.reorderProductImages({
          productId,
          storeId: scaffold.storeId,
          imageIds: [a, a],
        }),
      ).toEqual({ ok: false, reason: "IMAGE_SET_MISMATCH" });
      expect(sortOrdersById(productId)).toEqual({ [a]: 0, [b]: 1 });
    });

    it("rejects an unknown id and leaves every sort order untouched", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-unknown-id");
      const [a, b] = seedGallery(productId, 2) as [string, string];

      expect(
        await repo.reorderProductImages({
          productId,
          storeId: scaffold.storeId,
          imageIds: [a, "01955f00-0000-7000-8000-000000000002"],
        }),
      ).toEqual({ ok: false, reason: "IMAGE_SET_MISMATCH" });
      expect(sortOrdersById(productId)).toEqual({ [a]: 0, [b]: 1 });
    });

    it("rejects an image of another product and leaves every sort order untouched", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-cross-a");
      const other = seedProduct(scaffold.storeId, "reorder-cross-b");
      const [a, b] = seedGallery(productId, 2) as [string, string];
      const [c] = seedGallery(other, 1) as [string];

      expect(
        await repo.reorderProductImages({
          productId,
          storeId: scaffold.storeId,
          imageIds: [a, b, c],
        }),
      ).toEqual({ ok: false, reason: "IMAGE_SET_MISMATCH" });
      expect(sortOrdersById(productId)).toEqual({ [a]: 0, [b]: 1 });
      expect(sortOrdersById(other)).toEqual({ [c]: 0 });
    });

    it("rejects a non-empty list for a product with no images", async () => {
      const productId = seedProduct(scaffold.storeId, "reorder-empty-nonempty");

      expect(
        await repo.reorderProductImages({
          productId,
          storeId: scaffold.storeId,
          imageIds: ["01955f00-0000-7000-8000-000000000002"],
        }),
      ).toEqual({ ok: false, reason: "IMAGE_SET_MISMATCH" });
      expect(readImages(productId)).toEqual([]);
    });
  });
});
