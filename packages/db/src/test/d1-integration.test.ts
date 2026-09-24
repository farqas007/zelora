import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createD1Client } from "../d1";
import { createD1UserRepository } from "../users/d1-repository";
import { createD1AuthSessionRepository } from "../auth/d1-repository";
import { createD1SellerRepository } from "../seller/d1-repository";
import { createD1CatalogRepository } from "../catalog/d1-repository";
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
  "order_items",
  "order_addresses",
  "orders",
  "addresses",
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
    for (const expected of ["users", "seller_profiles", "stores", "categories", "products", "product_variants", "inventory", "orders", "order_items", "audit_logs"]) {
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
});