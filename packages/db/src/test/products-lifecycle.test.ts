import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { LocalDatabase } from "../client";
import * as schema from "../schema";
import { createLocalProductRepository } from "../products/local-repository";
import { createLocalCatalogRepository } from "../catalog/local-repository";
import { createTestDatabase } from "./helpers";

/**
 * Real-SQLite integration tests for the product variant/inventory/publish
 * lifecycle. Each test runs on an isolated in-memory database with the
 * committed migrations applied. The fixtures build an *active* store so the
 * catalog visibility of a published product can be asserted end-to-end.
 */

let seq = 0;

interface Scaffold {
  storeId: string;
  otherStoreId: string;
}

function seedScaffold(db: LocalDatabase): Scaffold {
  seq += 1;
  const userId = db
    .insert(schema.users)
    .values({ email: `lifecycle-user-${seq}@example.test`, name: "Lifecycle Seller" })
    .returning({ id: schema.users.id })
    .get().id;
  const profile = db
    .insert(schema.sellerProfiles)
    .values({ userId, slug: `lifecycle-profile-${seq}`, displayName: "Lifecycle Seller", status: "active" })
    .returning({ id: schema.sellerProfiles.id })
    .get();
  const store = db
    .insert(schema.stores)
    .values({ sellerProfileId: profile.id, name: `Store ${seq}`, slug: `lifecycle-store-${seq}`, status: "active" })
    .returning({ id: schema.stores.id })
    .get();
  const otherUserId = db
    .insert(schema.users)
    .values({ email: `lifecycle-other-${seq}@example.test`, name: "Other Seller" })
    .returning({ id: schema.users.id })
    .get().id;
  const otherProfile = db
    .insert(schema.sellerProfiles)
    .values({ userId: otherUserId, slug: `lifecycle-profile-${seq}-b`, displayName: "Other Profile" })
    .returning({ id: schema.sellerProfiles.id })
    .get();
  const otherStore = db
    .insert(schema.stores)
    .values({ sellerProfileId: otherProfile.id, name: `Other ${seq}`, slug: `lifecycle-other-${seq}` })
    .returning({ id: schema.stores.id })
    .get();

  return { storeId: store.id, otherStoreId: otherStore.id };
}

let db: LocalDatabase;
let repo: ReturnType<typeof createLocalProductRepository>;
let catalog: ReturnType<typeof createLocalCatalogRepository>;
let scaffold: Scaffold;

beforeEach(() => {
  ({ db } = createTestDatabase());
  repo = createLocalProductRepository(db);
  catalog = createLocalCatalogRepository(db);
  seq = 0;
  scaffold = seedScaffold(db);
});

async function createProduct(storeId: string, slug: string): Promise<string> {
  const result = await repo.createProduct({
    storeId,
    categoryId: null,
    name: "Vintage Camera",
    slug,
    description: null,
  });
  if (!result.ok) {
    throw new Error("expected a successful product create");
  }
  return result.product.id;
}

describe("product repository: createVariant", () => {
  it("inserts an active variant with all fields on the owner's draft product", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");

    const result = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: "CAM-BODY",
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: 59900,
      currency: "USD",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a successful variant create");
    }
    expect(result.variant).toMatchObject({
      productId,
      sku: "CAM-BODY",
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: 59900,
      currency: "USD",
      status: "active",
    });
    expect(result.variant.createdAt).toBeInstanceOf(Date);

    const product = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, productId))
      .get();
    expect(product?.status).toBe("draft");
  });

  it("maps an unknown product to PRODUCT_NOT_FOUND without leaking existence", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");

    expect(
      await repo.createVariant({
        productId: `${productId}missing`,
        storeId: scaffold.storeId,
        sku: null,
        name: "Body Only",
        priceAmountCents: 100,
        compareAtAmountCents: null,
        currency: "USD",
      }),
    ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
  });

  it("does not expose another store's product to its owner's store", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");

    expect(
      await repo.createVariant({
        productId,
        storeId: scaffold.otherStoreId,
        sku: null,
        name: "Sneaky",
        priceAmountCents: 100,
        compareAtAmountCents: null,
        currency: "USD",
      }),
    ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
  });

  it("rejects a duplicate SKU as SKU_IN_USE even across stores (globally unique)", async () => {
    const productId = await createProduct(scaffold.storeId, "mine");
    const otherProductId = await createProduct(scaffold.otherStoreId, "theirs");
    await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: "SHARED-SKU",
      name: "Mine",
      priceAmountCents: 100,
      compareAtAmountCents: null,
      currency: "USD",
    });

    expect(
      await repo.createVariant({
        productId: otherProductId,
        storeId: scaffold.otherStoreId,
        sku: "SHARED-SKU",
        name: "Theirs",
        priceAmountCents: 100,
        compareAtAmountCents: null,
        currency: "USD",
      }),
    ).toEqual({ ok: false, reason: "SKU_IN_USE" });
  });

  it("allows multiple variants with a null SKU", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");

    const first = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: null,
      name: "Body Only",
      priceAmountCents: 100,
      compareAtAmountCents: null,
      currency: "USD",
    });
    const second = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: null,
      name: "Body Only",
      priceAmountCents: 100,
      compareAtAmountCents: null,
      currency: "USD",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});

describe("product repository: setInventory", () => {
  it("upserts inventory for the owner's variant and overwrites on a second call", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");
    const variant = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: null,
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: null,
      currency: "USD",
    });
    if (!variant.ok) {
      throw new Error("expected a successful variant create");
    }

    const first = await repo.setInventory({
      productId,
      variantId: variant.variant.id,
      storeId: scaffold.storeId,
      quantity: 7,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error("expected a successful inventory upsert");
    }
    expect(first.inventory).toMatchObject({ variantId: variant.variant.id, quantity: 7 });

    const second = await repo.setInventory({
      productId,
      variantId: variant.variant.id,
      storeId: scaffold.storeId,
      quantity: 3,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error("expected a successful inventory upsert");
    }
    expect(second.inventory.quantity).toBe(3);

    const rows = await db
      .select()
      .from(schema.inventory)
      .where(eq(schema.inventory.variantId, variant.variant.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantity).toBe(3);
  });

  it("maps an unknown variant to VARIANT_NOT_FOUND", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");

    expect(
      await repo.setInventory({
        productId,
        variantId: `${productId}missing`,
        storeId: scaffold.storeId,
        quantity: 1,
      }),
    ).toEqual({ ok: false, reason: "VARIANT_NOT_FOUND" });
  });

  it("does not expose another store's variant", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");
    const variant = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: null,
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: null,
      currency: "USD",
    });
    if (!variant.ok) {
      throw new Error("expected a successful variant create");
    }

    expect(
      await repo.setInventory({
        productId,
        variantId: variant.variant.id,
        storeId: scaffold.otherStoreId,
        quantity: 5,
      }),
    ).toEqual({ ok: false, reason: "VARIANT_NOT_FOUND" });
  });
});

describe("product repository: publishProduct", () => {
  it("rejects publishing without any variant as NOT_PUBLISHABLE", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");

    expect(await repo.publishProduct(productId, scaffold.storeId)).toEqual({
      ok: false,
      reason: "NOT_PUBLISHABLE",
    });
  });

  it("rejects publishing with a variant but no inventory as NOT_PUBLISHABLE", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");
    await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: null,
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: null,
      currency: "USD",
    });

    expect(await repo.publishProduct(productId, scaffold.storeId)).toEqual({
      ok: false,
      reason: "NOT_PUBLISHABLE",
    });
  });

  it("rejects publishing a zero-price variant as NOT_PUBLISHABLE", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");
    const variant = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: null,
      name: "Free",
      priceAmountCents: 0,
      compareAtAmountCents: null,
      currency: "USD",
    });
    if (!variant.ok) {
      throw new Error("expected a successful variant create");
    }
    await repo.setInventory({
      productId,
      variantId: variant.variant.id,
      storeId: scaffold.storeId,
      quantity: 5,
    });

    expect(await repo.publishProduct(productId, scaffold.storeId)).toEqual({
      ok: false,
      reason: "NOT_PUBLISHABLE",
    });
  });

  it("rejects publishing a variant with zero stock as NOT_PUBLISHABLE", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");
    const variant = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: null,
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: null,
      currency: "USD",
    });
    if (!variant.ok) {
      throw new Error("expected a successful variant create");
    }
    await repo.setInventory({
      productId,
      variantId: variant.variant.id,
      storeId: scaffold.storeId,
      quantity: 0,
    });

    expect(await repo.publishProduct(productId, scaffold.storeId)).toEqual({
      ok: false,
      reason: "NOT_PUBLISHABLE",
    });
  });

  it("publishes a draft to active once a sellable variant has inventory", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");
    const variant = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: "CAM-BODY",
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: 59900,
      currency: "USD",
    });
    if (!variant.ok) {
      throw new Error("expected a successful variant create");
    }
    await repo.setInventory({
      productId,
      variantId: variant.variant.id,
      storeId: scaffold.storeId,
      quantity: 3,
    });

    const result = await repo.publishProduct(productId, scaffold.storeId);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a successful publish");
    }
    expect(result.product.status).toBe("active");
  });

  it("publishing an already-active product is idempotent", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");
    const variant = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: "CAM-BODY",
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: null,
      currency: "USD",
    });
    if (!variant.ok) {
      throw new Error("expected a successful variant create");
    }
    await repo.setInventory({
      productId,
      variantId: variant.variant.id,
      storeId: scaffold.storeId,
      quantity: 3,
    });
    await repo.publishProduct(productId, scaffold.storeId);

    const again = await repo.publishProduct(productId, scaffold.storeId);

    expect(again.ok).toBe(true);
    if (!again.ok) {
      throw new Error("expected a successful re-publish");
    }
    expect(again.product.status).toBe("active");
  });

  it("rejects publishing an archived product as PRODUCT_ARCHIVED", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");
    const variant = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: null,
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: null,
      currency: "USD",
    });
    if (!variant.ok) {
      throw new Error("expected a successful variant create");
    }
    await repo.setInventory({
      productId,
      variantId: variant.variant.id,
      storeId: scaffold.storeId,
      quantity: 3,
    });
    await db
      .update(schema.products)
      .set({ status: "archived" })
      .where(eq(schema.products.id, productId))
      .run();

    expect(await repo.publishProduct(productId, scaffold.storeId)).toEqual({
      ok: false,
      reason: "PRODUCT_ARCHIVED",
    });
  });

  it("maps an unknown product to PRODUCT_NOT_FOUND", async () => {
    expect(await repo.publishProduct("unknown-product", scaffold.storeId)).toEqual({
      ok: false,
      reason: "PRODUCT_NOT_FOUND",
    });
  });

  it("does not expose another store's product to its owner's store", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");
    const variant = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: null,
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: null,
      currency: "USD",
    });
    if (!variant.ok) {
      throw new Error("expected a successful variant create");
    }
    await repo.setInventory({
      productId,
      variantId: variant.variant.id,
      storeId: scaffold.storeId,
      quantity: 3,
    });

    expect(await repo.publishProduct(productId, scaffold.otherStoreId)).toEqual({
      ok: false,
      reason: "PRODUCT_NOT_FOUND",
    });
  });

  it("a published product becomes visible on the public catalog", async () => {
    const productId = await createProduct(scaffold.storeId, "vintage-camera");
    const variant = await repo.createVariant({
      productId,
      storeId: scaffold.storeId,
      sku: "CAM-BODY",
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: null,
      currency: "USD",
    });
    if (!variant.ok) {
      throw new Error("expected a successful variant create");
    }
    await repo.setInventory({
      productId,
      variantId: variant.variant.id,
      storeId: scaffold.storeId,
      quantity: 3,
    });

    const before = await catalog.listActiveProducts({ limit: 10, cursor: null });
    expect(before.items.map((item) => item.slug)).not.toContain("vintage-camera");

    await repo.publishProduct(productId, scaffold.storeId);

    const after = await catalog.listActiveProducts({ limit: 10, cursor: null });
    const item = after.items.find((candidate) => candidate.slug === "vintage-camera");
    expect(item).toBeDefined();
    expect(item?.priceAmountCents).toBe(49900);
    expect(item?.currency).toBe("USD");
  });
});