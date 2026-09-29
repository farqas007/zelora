import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createD1Client } from "../d1";
import { createD1UserRepository } from "../users/d1-repository";
import { createD1AuthSessionRepository } from "../auth/d1-repository";
import { createD1SellerRepository } from "../seller/d1-repository";
import { createD1CatalogRepository } from "../catalog/d1-repository";
import { createD1CartRepository } from "../cart/d1-repository";
import { createD1OrderRepository } from "../orders/d1-repository";
import { createD1ProductRepository } from "../products/d1-repository";
import { createD1MediaObjectRepository } from "../media/d1-repository";
import { createId } from "../ids";
import * as schema from "../schema";
import type { DatabaseSchema } from "../client";
import type { DrizzleD1Database } from "drizzle-orm/d1";

/**
 * Integration tests for the Cloudflare D1 repositories against a real D1
 * runtime (workerd via Miniflare) with the committed `migrations/` applied.
 *
 * These close the gap the unit suites explicitly left open: Drizzle's D1
 * driver maps `transaction()` to `BEGIN`/`COMMIT`/`ROLLBACK` `run()` calls and
 * `changes()` reads `.meta.changes`, and both behaviors only exist on a true
 * D1 binding. Foreign keys stay ON (the D1 default, matching production), so
 * the tables enforce the same constraints the local SQLite tests rely on.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

interface D1Harness {
  db: DrizzleD1Database<DatabaseSchema>;
}

/** A 43-character SHA-256-style hash (base64url, unpadded) for token_hash columns. */
function tokenHash(seed: number): string {
  return Buffer.alloc(32, seed).toString("base64url");
}

type D1Binding = Awaited<ReturnType<Miniflare["getD1Database"]>>;

/** One worker hosts the single D1 database; every test resets it fresh. */
let miniflare: Miniflare;
let binding: D1Binding;

beforeAll(() => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default {}",
    d1Databases: { DB: "zelora-test" },
    d1Persist: false,
  });
});

afterAll(async () => {
  await miniflare.dispose();
});

beforeEach(async () => {
  binding = await miniflare.getD1Database("DB");
  await resetD1(binding);
});

function setup(): D1Harness {
  return { db: createD1Client(binding) };
}

/** Drop every table so `applyMigrations` rebuilds a pristine schema. */
async function resetD1(database: D1Binding): Promise<void> {
  for (const name of REVERSE_DEPENDENCY_ORDER) {
    await database.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  await applyMigrations(database);
}

/**
 * Tables created by the committed migrations, children first: D1 enforces
 * foreign keys against `DROP TABLE` via internal triggers even when
 * `PRAGMA foreign_keys` is off, so parents can only be dropped after every
 * referencing table is gone.
 */
const REVERSE_DEPENDENCY_ORDER = [
  "audit_logs",
  "auth_sessions",
  "cart_items",
  "carts",
  "order_items",
  "order_addresses",
  "orders",
  "addresses",
  "product_media",
  "media_objects",
  "product_images",
  "inventory",
  "product_variants",
  "products",
  "categories",
  "stores",
  "seller_profiles",
  "users",
] as const;

/**
 * Apply the committed `migrations/` folder to a D1 database, normalized for
 * Miniflare's `exec()` (which rejects multi-line input): each statement is
 * collapsed onto one line and terminated with a semicolon.
 */
async function applyMigrations(database: D1Binding): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    for (const block of sql.split("--> statement-breakpoint")) {
      const statement = block.trim().replace(/\s+/g, " ");
      if (statement !== "") {
        await database.exec(statement.endsWith(";") ? statement : `${statement};`);
      }
    }
  }
}

describe("D1 runtime with committed migrations", () => {
  it("runs both migrations and enforces foreign keys by default", async () => {
    const tables = await binding
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all<{ name: string }>();
    const names = tables.results.map((row: { name: string }) => row.name);
    for (const expected of ["users", "seller_profiles", "stores", "categories", "products", "product_variants", "inventory", "orders", "order_items", "audit_logs", "carts", "cart_items", "media_objects", "product_media"]) {
      expect(names).toContain(expected);
    }

    const foreignKeys = await binding.prepare("PRAGMA foreign_keys").all();
    expect(foreignKeys.results).toEqual([{ foreign_keys: 1 }]);
  });
});

describe("D1 user repository", () => {
  it("creates a user with RETURNING and resolves by email/id", async () => {
    const { db } = await setup();
    const users = createD1UserRepository(db);

    const created = await users.create({
      email: "ada@example.test",
      name: "Ada Lovelace",
      passwordHash: tokenHash(1),
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.email).toBe("ada@example.test");
    expect(created.role).toBe("customer");

    const byEmail = await users.findByEmail("ada@example.test");
    expect(byEmail).not.toBeNull();
    expect(byEmail?.id).toBe(created.id);

    const byId = await users.findById(created.id);
    expect(byId?.name).toBe("Ada Lovelace");

    expect(await users.findByEmail("missing@example.test")).toBeNull();
    expect(await users.findById(createId())).toBeNull();
  });

  it("enforces the exactly-one-admin invariant via createAdmin", async () => {
    const { db } = await setup();
    const users = createD1UserRepository(db);

    // With no admin yet, a duplicate email maps deterministically to EMAIL_IN_USE.
    await users.create({ email: "customer@example.test", name: "Customer", passwordHash: tokenHash(33) });
    const customerBlocked = await users.createAdmin({
      email: "customer@example.test",
      name: "Impostor",
      passwordHash: tokenHash(34),
      role: "admin",
    });
    expect(customerBlocked).toEqual({ ok: false, reason: "EMAIL_IN_USE" });

    const first = await users.createAdmin({
      email: "root@example.test",
      name: "Root",
      passwordHash: tokenHash(30),
      role: "admin",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.user.role).toBe("admin");

    // A different-new-email bootstrap loses the single-admin slot cleanly.
    const second = await users.createAdmin({
      email: "root-2@example.test",
      name: "Root Two",
      passwordHash: tokenHash(31),
      role: "admin",
    });
    expect(second).toEqual({ ok: false, reason: "ADMIN_ALREADY_EXISTS" });
    expect(await users.findByEmail("root-2@example.test")).toBeNull();

    // A same-email race after an admin exists trips both UNIQUE constraints;
    // the exact reason is driver-nondeterministic but never duplicates a user.
    const third = await users.createAdmin({
      email: "root@example.test",
      name: "Root Duplicate",
      passwordHash: tokenHash(32),
      role: "admin",
    });
    expect(third.ok).toBe(false);

    // The email UNIQUE constraint is untouched for non-admin users.
    await users.create({ email: "plain-customer@example.test", name: "Customer 2", passwordHash: tokenHash(35) });
    expect((await users.findByEmail("plain-customer@example.test"))?.role).toBe("customer");
  });
});

describe("D1 auth session repository (changes())", () => {
  it("updates, deletes and purges sessions with correct row counts", async () => {
    const { db } = await setup();
    const users = createD1UserRepository(db);
    const sessions = createD1AuthSessionRepository(db);

    const user = await users.create({
      email: "session@example.test",
      name: "Session User",
      passwordHash: tokenHash(2),
    });

    const session = await sessions.create({
      userId: user.id,
      tokenHash: tokenHash(3),
      csrfToken: tokenHash(4),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(session.tokenHash).toBe(tokenHash(3));

    expect(await sessions.findByTokenHash(tokenHash(3))).not.toBeNull();
    expect(await sessions.findByTokenHash(tokenHash(99))).toBeNull();

    const later = new Date(Date.now() + 30_000);
    expect(await sessions.updateLastUsedAt(session.id, later)).toBe(true);
    expect(await sessions.updateLastUsedAt(createId(), later)).toBe(false);

    await sessions.create({
      userId: user.id,
      tokenHash: tokenHash(5),
      csrfToken: tokenHash(6),
      expiresAt: new Date(Date.now() + 120_000),
    });

    expect(await sessions.deleteAllForUser(user.id)).toBe(2);
    expect(await sessions.findByTokenHash(tokenHash(3))).toBeNull();
    expect(await sessions.findByTokenHash(tokenHash(5))).toBeNull();

    const expired = await sessions.create({
      userId: user.id,
      tokenHash: tokenHash(7),
      csrfToken: tokenHash(8),
      expiresAt: new Date(Date.now() - 60_000),
    });
    const live = await sessions.create({
      userId: user.id,
      tokenHash: tokenHash(9),
      csrfToken: tokenHash(10),
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(await sessions.purgeExpired(new Date())).toBe(1);
    expect(await sessions.findByTokenHash(tokenHash(7))).toBeNull();
    expect(await sessions.findByTokenHash(tokenHash(9))).not.toBeNull();

    expect(await sessions.deleteById(expired.id)).toBe(false);
    expect(await sessions.deleteById(live.id)).toBe(true);
  });
});

describe("D1 seller repository (atomic batch)", () => {
  it("atomically creates the seller profile and first store", async () => {
    const { db } = await setup();
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);

    const user = await users.create({
      email: "seller@example.test",
      name: "Seller User",
      passwordHash: tokenHash(11),
    });

    const result = await sellers.createOnboarding({
      userId: user.id,
      profileSlug: "seller-one",
      displayName: "Seller One",
      storeName: "Seller One Shop",
      storeSlug: "seller-one-shop",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sellerProfile.userId).toBe(user.id);
    expect(result.sellerProfile.status).toBe("pending");
    expect(result.store.status).toBe("draft");
    expect(result.store.sellerProfileId).toBe(result.sellerProfile.id);

    const byUser = await sellers.findByUserId(user.id);
    expect(byUser?.slug).toBe("seller-one");
    expect(await sellers.findByProfileSlug("seller-one")).not.toBeNull();
    expect(await sellers.findStoreBySlug("seller-one-shop")).not.toBeNull();
  });

  it("maps real D1 UNIQUE conflicts and rolls the whole transaction back", async () => {
    const { db } = await setup();
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);

    const [userA, userB] = [
      await users.create({ email: "a@example.test", name: "User A", passwordHash: tokenHash(12) }),
      await users.create({ email: "b@example.test", name: "User B", passwordHash: tokenHash(13) }),
    ];

    const first = await sellers.createOnboarding({
      userId: userA.id,
      profileSlug: "taken-slug",
      displayName: "User A",
      storeName: "A Shop",
      storeSlug: "a-shop",
    });
    expect(first.ok).toBe(true);

    const profileConflict = await sellers.createOnboarding({
      userId: userB.id,
      profileSlug: "taken-slug",
      displayName: "User B",
      storeName: "B Shop",
      storeSlug: "b-shop",
    });
    expect(profileConflict).toEqual({ ok: false, reason: "PROFILE_SLUG_IN_USE" });

    const sellerProfileConflict = await sellers.createOnboarding({
      userId: userA.id,
      profileSlug: "b-profile",
      displayName: "User B",
      storeName: "B Shop",
      storeSlug: "b-shop",
    });
    expect(sellerProfileConflict).toEqual({ ok: false, reason: "SELLER_PROFILE_EXISTS" });

    const storeConflict = await sellers.createOnboarding({
      userId: userB.id,
      profileSlug: "b-profile",
      displayName: "User B",
      storeName: "B Shop",
      storeSlug: "a-shop",
    });
    expect(storeConflict).toEqual({ ok: false, reason: "STORE_SLUG_IN_USE" });

    expect(await sellers.findByProfileSlug("b-profile")).toBeNull();
    expect(await sellers.findStoreBySlug("b-shop")).toBeNull();
    expect(await sellers.findStoreBySlug("a-shop")).not.toBeNull();
  });

  it("activates the profile, its store and the user role atomically", async () => {
    const { db } = await setup();
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);

    const user = await users.create({
      email: "activation@example.test",
      name: "Activation Seller",
      passwordHash: tokenHash(14),
    });
    const onboarding = await sellers.createOnboarding({
      userId: user.id,
      profileSlug: "activation-shop",
      displayName: "Activation Seller",
      storeName: "Activation Shop",
      storeSlug: "activation-shop-store",
    });
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }

    const activated = await sellers.activateSeller(user.id);

    expect(activated).not.toBeNull();
    expect(activated?.sellerProfile.id).toBe(onboarding.sellerProfile.id);
    expect(activated?.sellerProfile.status).toBe("active");
    expect(activated?.store.id).toBe(onboarding.store.id);
    expect(activated?.store.status).toBe("active");

    const persisted = await users.findById(user.id);
    expect(persisted?.role).toBe("seller");

    const repeated = await sellers.activateSeller(user.id);
    expect(repeated?.sellerProfile.id).toBe(activated?.sellerProfile.id);
    expect(repeated?.sellerProfile.status).toBe("active");
    expect(repeated?.store.status).toBe("active");
    expect(repeated?.sellerProfile.updatedAt.getTime()).toBeGreaterThanOrEqual(
      activated?.sellerProfile.updatedAt.getTime() ?? 0,
    );
  });

  it("returns null when activating a user with no seller profile", async () => {
    const { db } = await setup();
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);

    const user = await users.create({
      email: "no-profile@example.test",
      name: "No Profile",
      passwordHash: tokenHash(15),
    });

    expect(await sellers.activateSeller(user.id)).toBeNull();
  });

  it("refuses to promote an administrator and writes nothing", async () => {
    // The D1 half of the backstop. The pre-read refuses the promotion, and the
    // role update is separately conditioned on the role still being non-admin at
    // write time, so an admin is never demoted even inside the read-then-write
    // window that a `batch()` cannot roll back.
    const { db } = await setup();
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);

    const admin = await users.createAdmin({
      email: "activation-admin@example.test",
      name: "Activation Admin",
      passwordHash: tokenHash(16),
      role: "admin",
    });
    if (!admin.ok) {
      throw new Error("expected the admin to be created");
    }
    const onboarding = await sellers.createOnboarding({
      userId: admin.user.id,
      profileSlug: "admin-shop",
      displayName: "Activation Admin",
      storeName: "Admin Shop",
      storeSlug: "admin-shop-store",
    });
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }

    expect(await sellers.activateSeller(admin.user.id)).toBeNull();

    const persisted = await users.findById(admin.user.id);
    expect(persisted?.role).toBe("admin");
    expect((await sellers.findByUserId(admin.user.id))?.status).toBe("pending");
    expect((await sellers.findStoreBySlug(onboarding.store.slug))?.status).toBe("draft");
  });
});

describe("D1 catalog repository (real joins and keyset pagination)", () => {
  /** User + active seller profile + active store + active category scaffolding. */
  async function seedStorefront(
    db: DrizzleD1Database<DatabaseSchema>,
    seed: number,
  ): Promise<{ storeId: string; categoryId: string }> {
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);

    const user = await users.create({
      email: `catalog-${seed}@example.test`,
      name: `Catalog Seller ${seed}`,
      passwordHash: tokenHash(60 + seed),
    });
    const onboarding = await sellers.createOnboarding({
      userId: user.id,
      profileSlug: `catalog-profile-${seed}`,
      displayName: `Catalog Seller ${seed}`,
      storeName: "Catalog Storefront",
      storeSlug: `catalog-store-${seed}`,
    });
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }
    await sellers.activateSeller(user.id);

    const category = await db
      .insert(schema.categories)
      .values({ name: `Category Seed ${seed}`, slug: `category-${seed}`, status: "active" })
      .returning()
      .get();
    return { storeId: onboarding.store.id, categoryId: category.id };
  }

  it("lists active products with cheapest active variant and primary image, then resolves detail", async () => {
    const { db } = await setup();
    const repository = createD1CatalogRepository(db);
    const { storeId, categoryId } = await seedStorefront(db, 1);

    const product = await db
      .insert(schema.products)
      .values({
        storeId,
        categoryId,
        name: "D1 Widget",
        slug: "d1-widget",
        description: "Runs on workerd",
        status: "active",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      })
      .returning()
      .get();

    await db.insert(schema.productVariants).values([
      { productId: product.id, name: "Cheap", sku: "d1-widget-cheap", priceAmountCents: 1_200, currency: "USD", status: "active", createdAt: new Date("2026-03-01T00:00:01.000Z") },
      { productId: product.id, name: "Expensive", sku: "d1-widget-expensive", priceAmountCents: 2_000, currency: "USD", status: "active", createdAt: new Date("2026-03-01T00:00:02.000Z") },
      { productId: product.id, name: "Hidden", sku: "d1-widget-draft", priceAmountCents: 500, currency: "USD", status: "draft", createdAt: new Date("2026-03-01T00:00:03.000Z") },
    ]);
    await db.insert(schema.productImages).values([
      { productId: product.id, url: "https://cdn.example.test/d1-primary.jpg", altText: "Primary", sortOrder: 0, isPrimary: 1 },
      { productId: product.id, url: "https://cdn.example.test/d1-side.jpg", altText: "Side", sortOrder: 1, isPrimary: 0 },
    ]);

    const offlineStore = await db
      .insert(schema.stores)
      .values({
        sellerProfileId: (await db.select().from(schema.sellerProfiles).get())!.id,
        name: "Offline Store",
        slug: "d1-offline-store",
        status: "closed",
      })
      .returning()
      .get();
    await db.insert(schema.products).values([
      { storeId, name: "Draft Product", slug: "d1-draft", status: "draft", createdAt: new Date("2026-03-02T00:00:00.000Z") },
      { storeId: offlineStore.id, name: "Offline Store Product", slug: "d1-offline", status: "active", createdAt: new Date("2026-03-03T00:00:00.000Z") },
    ]);

    const page = await repository.listActiveProducts({ limit: 10, cursor: null });
    expect(page.items.map((i) => i.slug)).toEqual(["d1-widget"]);
    const item = page.items[0]!;
    expect(item.priceAmountCents).toBe(1_200);
    expect(item.currency).toBe("USD");
    expect(item.image).toEqual({ url: "https://cdn.example.test/d1-primary.jpg", altText: "Primary" });
    expect(item.category).toEqual({ id: categoryId, slug: "category-1", name: "Category Seed 1" });
    expect(item.store.slug).toBe("catalog-store-1");

    const detail = await repository.findProductBySlug("d1-widget");
    expect(detail).not.toBeNull();
    expect(detail!.variants.map((v) => v.name)).toEqual(["Cheap", "Expensive"]);
    expect(detail!.images.map((i) => i.url)).toEqual([
      "https://cdn.example.test/d1-primary.jpg",
      "https://cdn.example.test/d1-side.jpg",
    ]);

    expect(await repository.findProductBySlug("d1-draft")).toBeNull();
    expect(await repository.listActiveCategories().then((c) => c.map((row) => row.slug))).toEqual(["category-1"]);
  });

  it("keeps price, compare-at and currency consistent with the cheapest active variant", async () => {
    const { db } = await setup();
    const repository = createD1CatalogRepository(db);
    const { storeId } = await seedStorefront(db, 2);

    const product = await db
      .insert(schema.products)
      .values({
        storeId,
        name: "D1 Consistent",
        slug: "d1-consistent",
        status: "active",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      })
      .returning()
      .get();

    await db.insert(schema.productVariants).values([
      // Cheapest active variant: no compare-at, GBP.
      { productId: product.id, name: "Base", sku: "d1-base", priceAmountCents: 7_500, currency: "GBP", status: "active", createdAt: new Date("2026-03-01T00:00:01.000Z") },
      // More expensive: must never leak its compare-at/currency into the summary.
      { productId: product.id, name: "Deluxe", sku: "d1-deluxe", priceAmountCents: 12_000, compareAtAmountCents: 15_000, currency: "USD", status: "active", createdAt: new Date("2026-03-01T00:00:02.000Z") },
      // Draft: excluded from the aggregation entirely.
      { productId: product.id, name: "Draft", sku: "d1-draft", priceAmountCents: 1_000, currency: "USD", status: "draft", createdAt: new Date("2026-03-01T00:00:03.000Z") },
    ]);

    const page = await repository.listActiveProducts({ limit: 10, cursor: null });
    const item = page.items.find((i) => i.slug === "d1-consistent");

    expect(item).toBeDefined();
    expect(item!.priceAmountCents).toBe(7_500);
    expect(item!.compareAtAmountCents).toBeNull();
    expect(item!.currency).toBe("GBP");
  });

  it("returns only the sellable variants among the requested ids on D1", async () => {
    const { db } = await setup();
    const repository = createD1CatalogRepository(db);
    const { storeId } = await seedStorefront(db, 20);

    const product = await db
      .insert(schema.products)
      .values({
        storeId,
        name: "D1 Sellable",
        slug: "d1-sellable",
        status: "active",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      })
      .returning()
      .get();

    const variants = await db
      .insert(schema.productVariants)
      .values([
        { productId: product.id, name: "In Stock", sku: "d1-sellable-a", priceAmountCents: 1_000, currency: "USD", status: "active" },
        { productId: product.id, name: "Sold Out", sku: "d1-sellable-b", priceAmountCents: 1_000, currency: "USD", status: "active" },
        { productId: product.id, name: "Draft", sku: "d1-sellable-c", priceAmountCents: 1_000, currency: "USD", status: "draft" },
      ])
      .returning();
    await db.insert(schema.inventory).values([
      { variantId: variants[0]!.id, quantity: 5 },
      { variantId: variants[1]!.id, quantity: 0 },
      { variantId: variants[2]!.id, quantity: 9 },
    ]);

    const sellable = await repository.listSellableVariantsByIds(variants.map((variant) => variant.id));
    expect(sellable.map((variant) => variant.id)).toEqual([variants[0]!.id]);
    expect(sellable[0]).toMatchObject({
      productId: product.id,
      productName: "D1 Sellable",
      storeId,
      priceAmountCents: 1_000,
      currency: "USD",
      availableQuantity: 5,
    });

    // An inactive category hides its variants on D1 too.
    const inactiveCategory = await db
      .insert(schema.categories)
      .values({ name: "Offline", slug: "d1-sellable-off", status: "inactive" })
      .returning()
      .get();
    const hiddenProduct = await db
      .insert(schema.products)
      .values({ storeId, categoryId: inactiveCategory.id, name: "Hidden", slug: "d1-sellable-hidden", status: "active" })
      .returning()
      .get();
    const hiddenVariant = await db
      .insert(schema.productVariants)
      .values({ productId: hiddenProduct.id, name: "Hidden", priceAmountCents: 100, currency: "USD", status: "active" })
      .returning()
      .get();
    await db.insert(schema.inventory).values({ variantId: hiddenVariant.id, quantity: 2 });

    expect(await repository.listSellableVariantsByIds([hiddenVariant.id])).toEqual([]);
    expect(await repository.listSellableVariantsByIds([])).toEqual([]);
  });
});

describe("D1 product repository (variant lifecycle, inventory and publish)", () => {
  /** User + active seller profile + active store (no category). */
  async function seedSeller(db: DrizzleD1Database<DatabaseSchema>, seed: number): Promise<string> {
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);

    const user = await users.create({
      email: `variant-${seed}@example.test`,
      name: `Variant Seller ${seed}`,
      passwordHash: tokenHash(70 + seed),
    });
    const onboarding = await sellers.createOnboarding({
      userId: user.id,
      profileSlug: `variant-profile-${seed}`,
      displayName: `Variant Seller ${seed}`,
      storeName: "Variant Storefront",
      storeSlug: `variant-store-${seed}`,
    });
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }
    await sellers.activateSeller(user.id);
    return onboarding.store.id;
  }

  async function seedProduct(
    db: DrizzleD1Database<DatabaseSchema>,
    storeId: string,
    slug: string,
  ): Promise<string> {
    const row = await db
      .insert(schema.products)
      .values({ storeId, categoryId: null, name: "D1 Camera", slug, status: "draft" })
      .returning()
      .get();
    return row.id;
  }

  it("creates an active variant and upserts inventory on the owner's draft product", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 1);
    const productId = await seedProduct(db, storeId, "d1-camera");

    const created = await repo.createVariant({
      productId,
      storeId,
      sku: "d1-cam-body",
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: 59900,
      currency: "USD",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("expected a successful variant create");
    }
    expect(created.variant).toMatchObject({
      productId,
      sku: "d1-cam-body",
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: 59900,
      currency: "USD",
      status: "active",
    });

    const first = await repo.setInventory({
      productId,
      variantId: created.variant.id,
      storeId,
      quantity: 7,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error("expected a successful inventory upsert");
    }
    expect(first.inventory).toMatchObject({ variantId: created.variant.id, quantity: 7 });

    const second = await repo.setInventory({
      productId,
      variantId: created.variant.id,
      storeId,
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
      .where(eq(schema.inventory.variantId, created.variant.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantity).toBe(3);
  });

  it("maps a global SKU collision to SKU_IN_USE on D1", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 2);
    const otherStoreId = await seedSeller(db, 3);
    const productId = await seedProduct(db, storeId, "d1-mine");
    const otherProductId = await seedProduct(db, otherStoreId, "d1-theirs");

    expect(
      await repo.createVariant({
        productId,
        storeId,
        sku: "SHARED",
        name: "Mine",
        priceAmountCents: 100,
        compareAtAmountCents: null,
        currency: "USD",
      }),
    ).toMatchObject({ ok: true });

    expect(
      await repo.createVariant({
        productId: otherProductId,
        storeId: otherStoreId,
        sku: "SHARED",
        name: "Theirs",
        priceAmountCents: 100,
        compareAtAmountCents: null,
        currency: "USD",
      }),
    ).toEqual({ ok: false, reason: "SKU_IN_USE" });
  });

  it("only publishes the owner's product once it has a sellable variant with stock", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 4);
    const productId = await seedProduct(db, storeId, "d1-publish");

    expect(await repo.publishProduct(productId, storeId)).toEqual({ ok: false, reason: "NOT_PUBLISHABLE" });

    const created = await repo.createVariant({
      productId,
      storeId,
      sku: "d1-pub-body",
      name: "Body Only",
      priceAmountCents: 49900,
      compareAtAmountCents: null,
      currency: "USD",
    });
    if (!created.ok) {
      throw new Error("expected a successful variant create");
    }

    expect(await repo.publishProduct(productId, storeId)).toEqual({ ok: false, reason: "NOT_PUBLISHABLE" });

    await repo.setInventory({
      productId,
      variantId: created.variant.id,
      storeId,
      quantity: 2,
    });

    const published = await repo.publishProduct(productId, storeId);
    expect(published.ok).toBe(true);
    if (!published.ok) {
      throw new Error("expected a successful publish");
    }
    expect(published.product.status).toBe("active");

    expect(await repo.publishProduct(productId, storeId)).toMatchObject({ ok: true });
  });

  it("keeps the product invisible until published, then surfaces it on the catalog", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const catalogRepo = createD1CatalogRepository(db);
    const storeId = await seedSeller(db, 5);
    const productId = await seedProduct(db, storeId, "d1-visible");

    const created = await repo.createVariant({
      productId,
      storeId,
      sku: "d1-vis-body",
      name: "Body Only",
      priceAmountCents: 5_500,
      compareAtAmountCents: null,
      currency: "USD",
    });
    if (!created.ok) {
      throw new Error("expected a successful variant create");
    }
    await repo.setInventory({
      productId,
      variantId: created.variant.id,
      storeId,
      quantity: 9,
    });

    const before = await catalogRepo.listActiveProducts({ limit: 50, cursor: null });
    expect(before.items.map((item) => item.slug)).not.toContain("d1-visible");

    await repo.publishProduct(productId, storeId);

    const after = await catalogRepo.listActiveProducts({ limit: 50, cursor: null });
    const item = after.items.find((candidate) => candidate.slug === "d1-visible");
    expect(item).toBeDefined();
    expect(item?.priceAmountCents).toBe(5_500);
    expect(item?.currency).toBe("USD");
  });

  it("does not expose another store's product or variant on D1", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 6);
    const otherStoreId = await seedSeller(db, 7);
    const productId = await seedProduct(db, storeId, "d1-private");

    expect(
      await repo.createVariant({
        productId,
        storeId: otherStoreId,
        sku: "SNEAKY",
        name: "Sneaky",
        priceAmountCents: 100,
        compareAtAmountCents: null,
        currency: "USD",
      }),
    ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
    expect(await repo.publishProduct(productId, otherStoreId)).toEqual({
      ok: false,
      reason: "PRODUCT_NOT_FOUND",
    });
  });

  it("paginates only the owner's D1 products with the same keyset cursor", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 8);
    const otherStoreId = await seedSeller(db, 9);
    await db.insert(schema.products).values([
      {
        storeId,
        name: "Draft",
        slug: "d1-list-draft",
        status: "draft",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        storeId,
        name: "Archived",
        slug: "d1-list-archived",
        status: "archived",
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
      {
        storeId,
        name: "Active",
        slug: "d1-list-active",
        status: "active",
        createdAt: new Date("2026-04-03T00:00:00.000Z"),
      },
      {
        storeId: otherStoreId,
        name: "Other",
        slug: "d1-list-other",
        status: "active",
        createdAt: new Date("2026-04-04T00:00:00.000Z"),
      },
    ]);

    const first = await repo.listByStore(storeId, { limit: 2, cursor: null });
    expect(first.items.map((product) => product.slug)).toEqual([
      "d1-list-active",
      "d1-list-archived",
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await repo.listByStore(storeId, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((product) => product.slug)).toEqual(["d1-list-draft"]);
    expect(second.nextCursor).toBeNull();
  });

  it("returns D1 owner detail with inventory and hides another store's product", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 10);
    const otherStoreId = await seedSeller(db, 11);
    const product = await db
      .insert(schema.products)
      .values({
        storeId,
        name: "D1 Detail",
        slug: "d1-detail",
        description: "Owned detail",
      })
      .returning()
      .get();
    const variants = await db
      .insert(schema.productVariants)
      .values([
        {
          productId: product.id,
          name: "No Stock",
          priceAmountCents: 1000,
          currency: "USD",
          status: "active",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
        {
          productId: product.id,
          name: "In Stock",
          priceAmountCents: 2000,
          currency: "USD",
          status: "inactive",
          createdAt: new Date("2026-05-02T00:00:00.000Z"),
        },
      ])
      .returning();
    await db.insert(schema.inventory).values({
      variantId: variants[1]!.id,
      quantity: 6,
      updatedAt: new Date("2026-05-02T01:00:00.000Z"),
    });

    const detail = await repo.findByStoreAndId(storeId, product.id);
    expect(detail?.description).toBe("Owned detail");
    expect(detail?.variants.map((variant) => variant.name)).toEqual(["No Stock", "In Stock"]);
    expect(detail?.variants[0]?.inventory).toBeNull();
    expect(detail?.variants[1]?.inventory).toMatchObject({ quantity: 6 });
    expect(await repo.findByStoreAndId(otherStoreId, product.id)).toBeNull();
  });
});

describe("D1 product repository: addProductImages", () => {
  /**
   * Two independent sellers, so ownership can be checked against a real
   * `products.storeId` rather than a fabricated id.
   */
  async function seedSeller(db: DrizzleD1Database<DatabaseSchema>, seed: number): Promise<string> {
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);
    const user = await users.create({
      email: `append-${seed}@example.test`,
      name: `Append Seller ${seed}`,
      passwordHash: tokenHash(90 + seed),
    });
    const onboarding = await sellers.createOnboarding({
      userId: user.id,
      profileSlug: `append-profile-${seed}`,
      displayName: `Append Seller ${seed}`,
      storeName: "Append Storefront",
      storeSlug: `append-store-${seed}`,
    });
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }
    return onboarding.store.id;
  }

  async function seedProduct(
    db: DrizzleD1Database<DatabaseSchema>,
    storeId: string,
    slug: string,
  ): Promise<string> {
    const row = await db
      .insert(schema.products)
      .values({ storeId, categoryId: null, name: "D1 Camera", slug, status: "draft" })
      .returning()
      .get();
    return row.id;
  }

  async function countImages(db: DrizzleD1Database<DatabaseSchema>, productId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.productImages.id })
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, productId));
    return rows.length;
  }

  it("persists url and storage key, forcing every appended row non-primary", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 1);
    const productId = await seedProduct(db, storeId, "append-d1");

    const result = await repo.addProductImages({
      productId,
      storeId,
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
    expect(result.images.map((image) => image.storageKey)).toEqual([
      "products/p/front.jpg",
      "products/p/back.jpg",
    ]);
    expect(result.images.every((image) => image.isPrimary === false)).toBe(true);
    expect(await countImages(db, productId)).toBe(2);
  });

  it("round-trips an explicit null storage key for a URL-only image", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 2);
    const productId = await seedProduct(db, storeId, "append-d1-url-only");

    await repo.addProductImages({
      productId,
      storeId,
      images: [{ url: "https://cdn.test/external.jpg", storageKey: null, altText: null, sortOrder: 0 }],
    });

    const listed = await repo.listImagesByProduct(productId, storeId);
    expect(listed[0]?.storageKey).toBeNull();
  });

  it("appends beside an existing primary without disturbing it", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 3);
    const productId = await seedProduct(db, storeId, "append-d1-primary");
    await db
      .insert(schema.productImages)
      .values({ productId, url: "https://cdn.test/hero.jpg", isPrimary: 1 });

    await repo.addProductImages({
      productId,
      storeId,
      images: [{ url: "https://media.test/new.jpg", storageKey: "new.jpg", altText: null, sortOrder: 0 }],
    });

    const listed = await repo.listImagesByProduct(productId, storeId);
    // Same canonical ordering as the local driver: primary first, then sortOrder.
    expect(listed.map((image) => image.url)).toEqual([
      "https://cdn.test/hero.jpg",
      "https://media.test/new.jpg",
    ]);
    expect(listed.map((image) => image.isPrimary)).toEqual([true, false]);
    expect(listed[1]?.storageKey).toBe("new.jpg");
  });

  it("rejects a foreign product and writes nothing", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const ownStoreId = await seedSeller(db, 4);
    const foreignStoreId = await seedSeller(db, 5);
    const foreignProductId = await seedProduct(db, foreignStoreId, "append-d1-foreign");

    const result = await repo.addProductImages({
      productId: foreignProductId,
      storeId: ownStoreId,
      images: [{ url: "https://media.test/x.jpg", storageKey: "x.jpg", altText: null, sortOrder: 0 }],
    });

    expect(result).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
    expect(await countImages(db, foreignProductId)).toBe(0);
  });

  it("makes an empty batch a checked no-op, so a foreign product is still rejected", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const ownStoreId = await seedSeller(db, 6);
    const foreignStoreId = await seedSeller(db, 7);
    const ownProductId = await seedProduct(db, ownStoreId, "append-d1-empty-own");
    const foreignProductId = await seedProduct(db, foreignStoreId, "append-d1-empty-foreign");

    expect(
      await repo.addProductImages({ productId: ownProductId, storeId: ownStoreId, images: [] }),
    ).toEqual({ ok: true, images: [] });
    expect(
      await repo.addProductImages({ productId: foreignProductId, storeId: ownStoreId, images: [] }),
    ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
  });
});

describe("D1 product repository: reorderProductImages", () => {
  /**
   * One approved seller. Ownership needs a real `products.storeId`, and every
   * case here is about the caller's *own* gallery, so a second seller only
   * appears in the cross-store test.
   */
  async function seedSeller(db: DrizzleD1Database<DatabaseSchema>, seed: number): Promise<string> {
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);
    const user = await users.create({
      email: `reorder-${seed}@example.test`,
      name: `Reorder Seller ${seed}`,
      passwordHash: tokenHash(120 + seed),
    });
    const onboarding = await sellers.createOnboarding({
      userId: user.id,
      profileSlug: `reorder-profile-${seed}`,
      displayName: `Reorder Seller ${seed}`,
      storeName: "Reorder Storefront",
      storeSlug: `reorder-store-${seed}`,
    });
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }
    return onboarding.store.id;
  }

  async function seedProduct(
    db: DrizzleD1Database<DatabaseSchema>,
    storeId: string,
    slug: string,
  ): Promise<string> {
    const row = await db
      .insert(schema.products)
      .values({ storeId, categoryId: null, name: "D1 Camera", slug, status: "draft" })
      .returning()
      .get();
    return row.id;
  }

  /** Insert `count` images at ascending sort orders and return their ids. */
  async function seedGallery(
    db: DrizzleD1Database<DatabaseSchema>,
    productId: string,
    count: number,
  ): Promise<string[]> {
    const rows = await db
      .insert(schema.productImages)
      .values(
        Array.from({ length: count }, (_unused, index) => ({
          productId,
          url: `https://cdn.test/${index}.jpg`,
          sortOrder: index,
        })),
      )
      .returning();
    return rows.map((row) => row.id);
  }

  /** Promote one image without going through the driver. */
  async function markPrimary(
    db: DrizzleD1Database<DatabaseSchema>,
    imageId: string,
  ): Promise<void> {
    await db
      .update(schema.productImages)
      .set({ isPrimary: 1 })
      .where(eq(schema.productImages.id, imageId));
  }

  /** `{ imageId: sortOrder }` read straight from the table. */
  async function sortOrdersById(
    db: DrizzleD1Database<DatabaseSchema>,
    productId: string,
  ): Promise<Record<string, number>> {
    const rows = await db
      .select({ id: schema.productImages.id, sortOrder: schema.productImages.sortOrder })
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, productId));
    return Object.fromEntries(rows.map((row) => [row.id, row.sortOrder]));
  }

  /** `is_primary` for a product's images, in canonical read order. */
  async function primaryFlags(
    db: DrizzleD1Database<DatabaseSchema>,
    productId: string,
  ): Promise<number[]> {
    const rows = await db
      .select({ isPrimary: schema.productImages.isPrimary })
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, productId))
      .orderBy(schema.productImages.sortOrder);
    return rows.map((row) => row.isPrimary);
  }

  it("applies the submitted order and returns it", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 1);
    const productId = await seedProduct(db, storeId, "reorder-d1");
    const [a, b, c] = (await seedGallery(db, productId, 3)) as [string, string, string];

    const result = await repo.reorderProductImages({
      productId,
      storeId,
      imageIds: [c, a, b],
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.images.map((image) => image.id)).toEqual([c, a, b]);
    expect(await sortOrdersById(db, productId)).toEqual({ [a]: 1, [b]: 2, [c]: 0 });
  });

  it("rewrites a descending order to a dense ascending sequence", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 2);
    const productId = await seedProduct(db, storeId, "reorder-d1-dense");
    const [a, b, c, d] = (await seedGallery(db, productId, 4)) as [string, string, string, string];

    await repo.reorderProductImages({ productId, storeId, imageIds: [d, c, b, a] });

    // Dense 0..n-1, not the submitted 3,2,1,0: the contract is relative order,
    // and the canonical read order depends on those values being a clean run.
    expect(await sortOrdersById(db, productId)).toEqual({ [a]: 3, [b]: 2, [c]: 1, [d]: 0 });
  });

  it("scopes the write to the product", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 3);
    const productId = await seedProduct(db, storeId, "reorder-d1-scope");
    const otherProductId = await seedProduct(db, storeId, "reorder-d1-scope-other");
    const [a, b] = (await seedGallery(db, productId, 2)) as [string, string];
    const [c, d] = (await seedGallery(db, otherProductId, 2)) as [string, string];

    await repo.reorderProductImages({ productId, storeId, imageIds: [b, a] });

    // A second product's gallery is not merely absent from the result: its rows
    // are physically unchanged, which is what the `where product_id` bound
    // buys. A `where id in (...)` write would not be safe here.
    expect(await sortOrdersById(db, otherProductId)).toEqual({ [c]: 0, [d]: 1 });
  });

  it("does not touch primary state, even when the primary is submitted last", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 4);
    const productId = await seedProduct(db, storeId, "reorder-d1-primary");
    const [primary, first, second] = (await seedGallery(db, productId, 3)) as [string, string, string];
    await markPrimary(db, primary);

    const result = await repo.reorderProductImages({
      productId,
      storeId,
      imageIds: [first, second, primary],
    });

    expect(await primaryFlags(db, productId)).toEqual([0, 0, 1]);
    expect(result.ok && result.images.map((image) => image.id)).toEqual([primary, first, second]);
  });

  it("does not create a primary when the product has none", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 5);
    const productId = await seedProduct(db, storeId, "reorder-d1-no-primary");
    const [a, b] = (await seedGallery(db, productId, 2)) as [string, string];

    await repo.reorderProductImages({ productId, storeId, imageIds: [b, a] });

    expect(await primaryFlags(db, productId)).toEqual([0, 0]);
  });

  it("accepts an empty list for a product with no images as a no-op", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 6);
    const productId = await seedProduct(db, storeId, "reorder-d1-empty");

    const result = await repo.reorderProductImages({ productId, storeId, imageIds: [] });

    // An empty `CASE` is not valid SQL, so the driver skips the write entirely.
    expect(result).toEqual({ ok: true, images: [] });
  });

  it("reports a product owned by another store as PRODUCT_NOT_FOUND and writes nothing", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 7);
    const otherStoreId = await seedSeller(db, 8);
    const foreignProductId = await seedProduct(db, otherStoreId, "reorder-d1-foreign");
    const [a, b] = (await seedGallery(db, foreignProductId, 2)) as [string, string];

    expect(
      await repo.reorderProductImages({
        productId: foreignProductId,
        storeId,
        imageIds: [b, a],
      }),
    ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
    expect(await sortOrdersById(db, foreignProductId)).toEqual({ [a]: 0, [b]: 1 });
  });

  it("reports an unknown product as PRODUCT_NOT_FOUND", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 9);

    expect(
      await repo.reorderProductImages({
        productId: "01955f00-0000-7000-8000-00000000dead",
        storeId,
        imageIds: [],
      }),
    ).toEqual({ ok: false, reason: "PRODUCT_NOT_FOUND" });
  });

  it("rejects a partial list, a duplicate, an unknown id and a cross-product id, writing nothing", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 10);
    const productId = await seedProduct(db, storeId, "reorder-d1-reject");
    const bareProductId = await seedProduct(db, storeId, "reorder-d1-reject-bare");
    const otherProductId = await seedProduct(db, storeId, "reorder-d1-reject-other");
    const [a, b, c] = (await seedGallery(db, productId, 3)) as [string, string, string];
    const [otherImage] = (await seedGallery(db, otherProductId, 1)) as [string];
    const unknown = "01955f00-0000-7000-8000-00000000beef";

    const attempts: Array<{ label: string; productId: string; imageIds: string[] }> = [
      { label: "partial list", productId, imageIds: [c, a] },
      { label: "duplicated id", productId, imageIds: [a, a, b] },
      { label: "unknown id", productId, imageIds: [a, b, unknown] },
      { label: "another product's image", productId, imageIds: [a, b, otherImage] },
      { label: "non-empty list for a product with no images", productId: bareProductId, imageIds: [unknown] },
    ];

    for (const attempt of attempts) {
      expect(
        await repo.reorderProductImages({
          productId: attempt.productId,
          storeId,
          imageIds: attempt.imageIds,
        }),
        attempt.label,
      ).toEqual({ ok: false, reason: "IMAGE_SET_MISMATCH" });
    }

    // The no-partial-mutation guarantee, asserted across every rejection: not
    // one gallery moved a single row.
    expect(await sortOrdersById(db, productId)).toEqual({ [a]: 0, [b]: 1, [c]: 2 });
    expect(await sortOrdersById(db, otherProductId)).toEqual({ [otherImage]: 0 });
  });

  it("reads the product's real image set rather than trusting the caller's list", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 11);
    const productId = await seedProduct(db, storeId, "reorder-d1-readset");
    const [a, b] = (await seedGallery(db, productId, 2)) as [string, string];
    // A third image lands after the caller built its list, so that list is
    // stale by the time it arrives. The driver re-reads, so it is refused.
    const [late] = (await seedGallery(db, productId, 1)) as [string];

    expect(
      await repo.reorderProductImages({ productId, storeId, imageIds: [b, a] }),
    ).toEqual({ ok: false, reason: "IMAGE_SET_MISMATCH" });
    // And the refusal is not "repair the list silently": the late image keeps
    // its position rather than being pushed to the end.
    expect(await sortOrdersById(db, productId)).toEqual({ [a]: 0, [b]: 1, [late]: 0 });
  });

  it("reorders the same gallery twice, so the second order is not a no-op by accident", async () => {
    const { db } = await setup();
    const repo = createD1ProductRepository(db);
    const storeId = await seedSeller(db, 12);
    const productId = await seedProduct(db, storeId, "reorder-d1-twice");
    const [a, b, c] = (await seedGallery(db, productId, 3)) as [string, string, string];

    await repo.reorderProductImages({ productId, storeId, imageIds: [b, c, a] });
    const second = await repo.reorderProductImages({
      productId,
      storeId,
      imageIds: [a, b, c],
    });

    expect(second.ok && second.images.map((image) => image.id)).toEqual([a, b, c]);
    expect(await sortOrdersById(db, productId)).toEqual({ [a]: 0, [b]: 1, [c]: 2 });
  });
});

describe("D1 media object repository (raw BLOB statements)", () => {
  /**
   * Every byte of a value `0..255`, in an order that would not survive any
   * text round-trip or accidental stringification: a null byte, the high-bit
   * bytes, a lone `0x0a` and a trailing `0x00`. Any encoding mistake shows up
   * as a mismatch rather than as a plausible-looking image.
   */
  const BINARY_BYTES = Uint8Array.from([
    0x00, 0x01, 0x7f, 0x80, 0x89, 0x0a, 0x0d, 0xff, 0xfe, 0xc3, 0xa9, 0x00,
  ]);

  /** User + active seller profile + active store, so a real product can exist. */
  async function seedSeller(db: DrizzleD1Database<DatabaseSchema>, seed: number): Promise<string> {
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);
    const user = await users.create({
      email: `media-${seed}@example.test`,
      name: `Media Seller ${seed}`,
      passwordHash: tokenHash(120 + seed),
    });
    const onboarding = await sellers.createOnboarding({
      userId: user.id,
      profileSlug: `media-profile-${seed}`,
      displayName: `Media Seller ${seed}`,
      storeName: "Media Storefront",
      storeSlug: `media-store-${seed}`,
    });
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }
    await sellers.activateSeller(user.id);
    return onboarding.store.id;
  }

  it("stores and reads back byte-identical bytes, content type and byte size", async () => {
    const repository = createD1MediaObjectRepository(binding);
    const storageKey = "products/abc/0123.png";

    const created = await repository.create({
      storageKey,
      contentType: "image/png",
      bytes: BINARY_BYTES,
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.storageKey).toBe(storageKey);
    expect(created.contentType).toBe("image/png");
    expect(created.byteSize).toBe(BINARY_BYTES.byteLength);
    expect(created.checksum).toBeNull();
    expect([...created.bytes]).toEqual([...BINARY_BYTES]);

    const byId = await repository.findById(created.id);
    expect(byId).not.toBeNull();
    expect([...byId!.bytes]).toEqual([...BINARY_BYTES]);
    expect(byId!.contentType).toBe("image/png");
    expect(byId!.byteSize).toBe(BINARY_BYTES.byteLength);
    expect(byId!.createdAt.getTime()).toBe(created.createdAt.getTime());

    const byKey = await repository.findByStorageKey(storageKey);
    expect([...byKey!.bytes]).toEqual([...BINARY_BYTES]);
  });

  it("returns the repository's not-found result for a missing object", async () => {
    const repository = createD1MediaObjectRepository(binding);

    expect(await repository.findById(createId())).toBeNull();
    expect(await repository.findByStorageKey("products/never/written.jpg")).toBeNull();
    // Deleting something that does not exist is a no-op, not a silent success.
    expect(await repository.delete(createId())).toBe(false);
  });

  it("deletes an object and reports the removal", async () => {
    const repository = createD1MediaObjectRepository(binding);
    const created = await repository.create({
      storageKey: "products/abc/delete-me.jpg",
      contentType: "image/jpeg",
      bytes: Uint8Array.from([1, 2, 3]),
    });

    expect(await repository.delete(created.id)).toBe(true);
    expect(await repository.findById(created.id)).toBeNull();
    // A second delete is a no-op, so upload compensation is safe to retry.
    expect(await repository.delete(created.id)).toBe(false);
  });

  it("accepts ArrayBuffer bytes and round-trips them unchanged", async () => {
    const repository = createD1MediaObjectRepository(binding);
    const source = Uint8Array.from([9, 8, 7, 0, 6]);

    const created = await repository.create({
      storageKey: "products/abc/from-array-buffer.webp",
      contentType: "image/webp",
      bytes: source.buffer,
    });

    const found = await repository.findById(created.id);
    expect(found!.byteSize).toBe(5);
    expect([...found!.bytes]).toEqual([...source]);
  });

  it("unlinks product_media when a product is deleted but keeps the shared object", async () => {
    const { db } = setup();
    const repository = createD1MediaObjectRepository(binding);
    const storeId = await seedSeller(db, 1);
    const product = await db
      .insert(schema.products)
      .values({ storeId, name: "D1 Media", slug: "d1-media-product" })
      .returning()
      .get();
    const object = await repository.create({
      storageKey: "products/d1-media/photo.jpg",
      contentType: "image/jpeg",
      bytes: Uint8Array.from([0xff, 0xd8, 0xff]),
    });
    await db
      .insert(schema.productMedia)
      .values({ productId: product.id, mediaObjectId: object.id });

    await db.delete(schema.products).where(eq(schema.products.id, product.id));

    // The join row goes with the product, but the object stays: one object may
    // legitimately back several listings, so unlinking a product must not
    // destroy bytes another product still points at.
    expect(await db.select().from(schema.productMedia).all()).toHaveLength(0);
    expect(await repository.findById(object.id)).not.toBeNull();
  });

  it("cascades a media object delete through product_media", async () => {
    const { db } = setup();
    const repository = createD1MediaObjectRepository(binding);
    const storeId = await seedSeller(db, 2);
    const product = await db
      .insert(schema.products)
      .values({ storeId, name: "D1 Media Two", slug: "d1-media-product-two" })
      .returning()
      .get();
    const object = await repository.create({
      storageKey: "products/d1-media-two/photo.jpg",
      contentType: "image/jpeg",
      bytes: Uint8Array.from([0xff, 0xd8, 0xff]),
    });
    await db
      .insert(schema.productMedia)
      .values({ productId: product.id, mediaObjectId: object.id });

    await repository.delete(object.id);

    expect(await repository.findById(object.id)).toBeNull();
    expect(await db.select().from(schema.productMedia).all()).toHaveLength(0);
  });

  it("stores and reads bytes without ever exposing a Node Buffer to callers", async () => {
    const repository = createD1MediaObjectRepository(binding);
    const fromNodeBuffer = await repository.create({
      storageKey: "products/abc/from-node-buffer.jpg",
      contentType: "image/jpeg",
      // A Node Buffer is an accepted input shape, but it must not survive as
      // the stored representation: callers get bytes, never a Node-only type.
      bytes: Buffer.from([0xff, 0xd8, 0xff]),
    });
    expect(Buffer.isBuffer(fromNodeBuffer.bytes)).toBe(false);
    // `instanceof Uint8Array` is not enough to prove this: `Buffer` extends
    // `Uint8Array`, so only the prototype identity rules a Node type out.
    expect(Object.getPrototypeOf(fromNodeBuffer.bytes)).toBe(Uint8Array.prototype);

    // The Worker-shaped input: an `ArrayBuffer`, with no Buffer involved at all.
    const created = await repository.create({
      storageKey: "products/abc/no-buffer.jpg",
      contentType: "image/jpeg",
      bytes: BINARY_BYTES.buffer,
    });
    const found = await repository.findById(created.id);
    expect([...found!.bytes]).toEqual([...BINARY_BYTES]);
    expect(Object.getPrototypeOf(found!.bytes)).toBe(Uint8Array.prototype);
    expect(await repository.delete(created.id)).toBe(true);
  });

  it("rejects a byte size that disagrees with the stored bytes", async () => {
    // The CHECK is the last line of defence against a driver that computed
    // `byte_size` from anything other than the bytes it bound, so it is
    // exercised with hand-written SQL rather than through the repository.
    await expect(
      binding
        .prepare(
          "INSERT INTO media_objects (id, storage_key, content_type, byte_size, bytes, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          createId(),
          "products/abc/lying-size.jpg",
          "image/jpeg",
          99,
          new Uint8Array([1, 2, 3]).buffer,
          Date.now(),
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });
});

describe("D1 cart repository (unique conflicts + cascade)", () => {
  /**
   * A user with an active store and one sellable variant plus a fresh cart,
   * so item inserts have a real cart and variant to reference.
   */
  async function seedCart(
    db: DrizzleD1Database<DatabaseSchema>,
    seed: number,
  ): Promise<{ userId: string; cartId: string; variantId: string }> {
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);
    const carts = createD1CartRepository(db);

    const user = await users.create({
      email: `cart-${seed}@example.test`,
      name: `Cart User ${seed}`,
      passwordHash: tokenHash(70 + seed),
    });
    const onboarding = await sellers.createOnboarding({
      userId: user.id,
      profileSlug: `cart-profile-${seed}`,
      displayName: `Cart ${seed}`,
      storeName: `Cart Store ${seed}`,
      storeSlug: `cart-store-${seed}`,
    });
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }
    await sellers.activateSeller(user.id);

    const product = await db
      .insert(schema.products)
      .values({ storeId: onboarding.store.id, name: `Cart Product ${seed}`, slug: `cart-product-${seed}`, status: "active" })
      .returning()
      .get();
    const variant = await db
      .insert(schema.productVariants)
      .values({ productId: product.id, name: `Variant ${seed}`, sku: `cart-variant-${seed}`, priceAmountCents: 1_000, currency: "USD", status: "active" })
      .returning()
      .get();

    const created = await carts.createCart(user.id);
    if (!created.ok) {
      throw new Error("expected a successful cart creation");
    }
    return { userId: user.id, cartId: created.cart.id, variantId: variant.id };
  }

  it("creates a cart lazily and resolves it with items in order", async () => {
    const { db } = await setup();
    const carts = createD1CartRepository(db);
    const { userId, cartId, variantId } = await seedCart(db, 1);

    const resolved = await carts.getCartByUserId(userId);
    expect(resolved?.cart.id).toBe(cartId);
    expect(resolved?.items).toEqual([]);

    const catalog = createD1CatalogRepository(db);
    expect(await catalog.findVariantById(variantId)).toMatchObject({ id: variantId, priceAmountCents: 1_000 });
    expect(await catalog.findVariantById(createId())).toBeNull();

    const added = await carts.addItem({ cartId, variantId, quantity: 2 });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.item.quantity).toBe(2);

    const withItem = await carts.getCartByUserId(userId);
    expect(withItem?.items.map((i) => i.variantId)).toEqual([variantId]);
    expect(await carts.getCartByUserId(createId())).toBeNull();
  });

  it("maps real D1 UNIQUE conflicts for carts and cart items", async () => {
    const { db } = await setup();
    const carts = createD1CartRepository(db);
    const { userId, cartId, variantId } = await seedCart(db, 2);

    const duplicate = await carts.createCart(userId);
    expect(duplicate).toEqual({ ok: false, reason: "CART_EXISTS" });

    const first = await carts.addItem({ cartId, variantId, quantity: 1 });
    expect(first.ok).toBe(true);

    const duplicateItem = await carts.addItem({ cartId, variantId, quantity: 7 });
    expect(duplicateItem).toEqual({ ok: false, reason: "CART_ITEM_EXISTS" });
    expect((await carts.getCartByUserId(userId))?.items[0]?.quantity).toBe(1);
  });

  it("updates, removes and clears items scoped to the owning cart", async () => {
    const { db } = await setup();
    const users = createD1UserRepository(db);
    const carts = createD1CartRepository(db);
    const { cartId } = await seedCart(db, 3);

    const interloper = await users.create({ email: "cart-interloper@example.test", name: "Interloper", passwordHash: tokenHash(79) });
    const other = await carts.createCart(interloper.id);
    if (!other.ok) {
      throw new Error("expected a successful cart creation");
    }

    const item = await carts.addItem({ cartId, variantId: (await db.select().from(schema.productVariants).get())!.id, quantity: 1 });
    if (!item.ok) {
      throw new Error("expected a successful item insert");
    }

    // Scoped to the owning cart: the interloper's cart id is a miss.
    expect(await carts.updateItemQuantity(other.cart.id, item.item.id, 9)).toBeNull();
    expect(await carts.removeItem(other.cart.id, item.item.id)).toBe(false);

    const updated = await carts.updateItemQuantity(cartId, item.item.id, 4);
    expect(updated?.quantity).toBe(4);

    expect(await carts.removeItem(cartId, item.item.id)).toBe(true);
    await carts.addItem({ cartId, variantId: item.item.variantId, quantity: 3 });

    expect(await carts.clearCart(cartId)).toBe(1);
    expect((await carts.getCartByUserId(interloper.id))).not.toBeNull();
  });

  it("cascades a user delete through the cart and its items", async () => {
    const { db } = await setup();
    const users = createD1UserRepository(db);
    const carts = createD1CartRepository(db);
    // The seedCart owner holds a seller profile (RESTRICT on delete), so the
    // cascade consumer is a separate plain customer.
    const { variantId } = await seedCart(db, 4);

    const customer = await users.create({
      email: "cart-cascade@example.test",
      name: "Cascade Customer",
      passwordHash: tokenHash(80),
    });
    const created = await carts.createCart(customer.id);
    if (!created.ok) {
      throw new Error("expected a successful cart creation");
    }
    await carts.addItem({ cartId: created.cart.id, variantId, quantity: 1 });

    await db.delete(schema.users).where(eq(schema.users.id, customer.id));

    expect(await carts.getCartByUserId(customer.id)).toBeNull();
    expect(await db.select().from(schema.cartItems).all()).toHaveLength(0);
  });
});

describe("D1 order repository (atomic batch + inventory CHECK guard)", () => {
  /**
   * An approved seller with an active product/variant plus a separate plain
   * customer to buy it, so order reads have real users/stores to reference.
   */
  async function seedSellable(
    db: DrizzleD1Database<DatabaseSchema>,
    seed: number,
    quantity: number,
  ): Promise<{ customerUserId: string; storeId: string; variantId: string; priceAmountCents: number }> {
    const users = createD1UserRepository(db);
    const sellers = createD1SellerRepository(db);
    const seller = await users.create({
      email: `order-seller-${seed}@example.test`,
      name: `Order Seller ${seed}`,
      passwordHash: tokenHash(200 + seed),
    });
    const onboarding = await sellers.createOnboarding({
      userId: seller.id,
      profileSlug: `order-profile-${seed}`,
      displayName: `Order Seller ${seed}`,
      storeName: `Order Store ${seed}`,
      storeSlug: `order-store-${seed}`,
    });
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }
    await sellers.activateSeller(seller.id);

    const customer = await users.create({
      email: `order-customer-${seed}@example.test`,
      name: `Order Customer ${seed}`,
      passwordHash: tokenHash(220 + seed),
    });

    const product = await db
      .insert(schema.products)
      .values({
        storeId: onboarding.store.id,
        name: `Order Product ${seed}`,
        slug: `order-product-${seed}`,
        status: "active",
      })
      .returning()
      .get();
    const variant = await db
      .insert(schema.productVariants)
      .values({
        productId: product.id,
        name: `Order Variant ${seed}`,
        sku: `order-variant-${seed}`,
        priceAmountCents: 1_500,
        currency: "USD",
        status: "active",
      })
      .returning()
      .get();
    await db.insert(schema.inventory).values({ variantId: variant.id, quantity });

    return {
      customerUserId: customer.id,
      storeId: onboarding.store.id,
      variantId: variant.id,
      priceAmountCents: variant.priceAmountCents,
    };
  }

  it("creates the order, its snapshots and lines and decrements inventory on D1", async () => {
    const { db } = await setup();
    const repo = createD1OrderRepository(db);
    const { customerUserId, storeId, variantId, priceAmountCents } = await seedSellable(db, 1, 5);

    const result = await repo.createOrder({
      customerUserId,
      currency: "USD",
      subtotalAmountCents: priceAmountCents * 2,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: priceAmountCents * 2,
      addresses: [
        { kind: "shipping", recipientName: "Order Customer 1", phone: null, line1: "1 D1 Way", line2: null, city: "Workerd", region: null, postalCode: null, countryCode: "US" },
        { kind: "billing", recipientName: "Order Customer 1", phone: null, line1: "1 D1 Way", line2: null, city: "Workerd", region: null, postalCode: null, countryCode: "US" },
      ],
      lines: [
        {
          variantId,
          storeId,
          productName: "Order Product 1",
          variantName: "Order Variant 1",
          sku: "order-variant-1",
          quantity: 2,
          unitAmountCents: priceAmountCents,
          lineTotalAmountCents: priceAmountCents * 2,
          currency: "USD",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toMatchObject({
      customerUserId,
      status: "pending",
      currency: "USD",
      subtotalAmountCents: priceAmountCents * 2,
      totalAmountCents: priceAmountCents * 2,
    });
    expect(result.addresses).toHaveLength(2);
    expect(result.items).toHaveLength(1);

    const persisted = await db.select().from(schema.inventory).where(eq(schema.inventory.variantId, variantId)).get();
    expect(persisted?.quantity).toBe(3);
    expect(await db.select().from(schema.orders).where(eq(schema.orders.id, result.order.id)).get()).not.toBeNull();
    expect(await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, result.order.id)).all()).toHaveLength(1);
    expect(await db.select().from(schema.orderAddresses).where(eq(schema.orderAddresses.orderId, result.order.id)).all()).toHaveLength(2);
  });

  it("rolls the whole batch back when a variant would go negative (INSUFFICIENT_STOCK)", async () => {
    const { db } = await setup();
    const repo = createD1OrderRepository(db);
    const { customerUserId, storeId, variantId, priceAmountCents } = await seedSellable(db, 2, 5);

    const result = await repo.createOrder({
      customerUserId,
      currency: "USD",
      subtotalAmountCents: priceAmountCents * 6,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: priceAmountCents * 6,
      addresses: [{ kind: "shipping", recipientName: "Order Customer 2", phone: null, line1: "1 D1 Way", line2: null, city: "Workerd", region: null, postalCode: null, countryCode: "US" }],
      lines: [
        {
          variantId,
          storeId,
          productName: "Order Product 2",
          variantName: "Order Variant 2",
          sku: "order-variant-2",
          quantity: 6,
          unitAmountCents: priceAmountCents,
          lineTotalAmountCents: priceAmountCents * 6,
          currency: "USD",
        },
      ],
    });

    expect(result).toEqual({ ok: false, reason: "INSUFFICIENT_STOCK" });
    // The batch never committed: no order rows, no snapshots, no lines.
    expect(await db.select().from(schema.orders).all()).toHaveLength(0);
    expect(await db.select().from(schema.orderAddresses).all()).toHaveLength(0);
    expect(await db.select().from(schema.orderItems).all()).toHaveLength(0);
    expect((await db.select().from(schema.inventory).where(eq(schema.inventory.variantId, variantId)).get())?.quantity).toBe(5);
  });

  it("resolves a foreign-key violation to VARIANT_NOT_FOUND and writes nothing on D1", async () => {
    const { db } = await setup();
    const repo = createD1OrderRepository(db);
    const { customerUserId, variantId } = await seedSellable(db, 3, 5);

    const result = await repo.createOrder({
      customerUserId,
      currency: "USD",
      subtotalAmountCents: 1_500,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: 1_500,
      addresses: [{ kind: "shipping", recipientName: "Order Customer 3", phone: null, line1: "1 D1 Way", line2: null, city: "Workerd", region: null, postalCode: null, countryCode: "US" }],
      lines: [
        {
          variantId: createId(),
          storeId: createId(),
          productName: "Ghost",
          variantName: "Ghost",
          sku: null,
          quantity: 1,
          unitAmountCents: 1_500,
          lineTotalAmountCents: 1_500,
          currency: "USD",
        },
      ],
    });

    expect(result).toEqual({ ok: false, reason: "VARIANT_NOT_FOUND" });
    expect(await db.select().from(schema.orders).all()).toHaveLength(0);
    expect(await db.select().from(schema.orderItems).all()).toHaveLength(0);
    expect((await db.select().from(schema.inventory).where(eq(schema.inventory.variantId, variantId)).get())?.quantity).toBe(5);
  });

  it("lists a customer's orders newest-first and resolves them by id, scoped to the customer", async () => {
    const { db } = await setup();
    const repo = createD1OrderRepository(db);
    const { customerUserId, storeId, variantId, priceAmountCents } = await seedSellable(db, 4, 100);

    async function place(id: string, createdAt: Date) {
      const result = await repo.createOrder({
        customerUserId,
        currency: "USD",
        subtotalAmountCents: priceAmountCents,
        shippingAmountCents: 0,
        discountAmountCents: 0,
        totalAmountCents: priceAmountCents,
        addresses: [{ kind: "shipping", recipientName: "Order Customer 4", phone: null, line1: `1 D1 Way ${id}`, line2: null, city: "Workerd", region: null, postalCode: null, countryCode: "US" }],
        lines: [
          {
            variantId,
            storeId,
            productName: "Order Product 4",
            variantName: "Order Variant 4",
            sku: null,
            quantity: 1,
            unitAmountCents: priceAmountCents,
            lineTotalAmountCents: priceAmountCents,
            currency: "USD",
          },
        ],
      });
      if (!result.ok) {
        throw new Error("expected a successful order create");
      }
      await db.update(schema.orders).set({ createdAt }).where(eq(schema.orders.id, result.order.id));
      return result.order.id;
    }

    const third = await place("third", new Date("2026-02-01T00:00:00.000Z"));
    const second = await place("second", new Date("2026-02-02T00:00:00.000Z"));
    const first = await place("first", new Date("2026-02-03T00:00:00.000Z"));

    const page = await repo.listByCustomer(customerUserId, { limit: 2, cursor: null });
    expect(page.items.map((item) => item.order.id)).toEqual([first, second]);
    expect(page.items[0]!.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();

    const rest = await repo.listByCustomer(customerUserId, { limit: 2, cursor: page.nextCursor });
    expect(rest.items.map((item) => item.order.id)).toEqual([third]);
    expect(rest.nextCursor).toBeNull();

    const detail = await repo.findByIdForCustomer(customerUserId, first);
    expect(detail?.items).toHaveLength(1);
    expect(detail?.addresses[0]?.line1).toBe("1 D1 Way first");

    // A different customer (or an unknown id) sees nothing.
    const interloper = await repo.listByCustomer(createId(), { limit: 10, cursor: null });
    expect(interloper.items).toEqual([]);
    expect(await repo.findByIdForCustomer(createId(), first)).toBeNull();
  });
});