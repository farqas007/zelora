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
