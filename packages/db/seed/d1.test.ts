import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createD1Client } from "../src/d1";
import { createD1CatalogRepository } from "../src/catalog/d1-repository";
import { isValidId } from "../src/ids";
import {
  buildCleanupStatements,
  buildPreflightStatement,
  buildSeedStatements,
  buildVerifyStatement,
  decidePreflight,
  EXPECTED_PREFLIGHT,
} from "./d1";
import {
  FIXTURE_CATEGORIES,
  FIXTURE_CREATED_AT_MS,
  FIXTURE_IMAGES,
  FIXTURE_INVENTORY,
  FIXTURE_ORDER_ADDRESSES,
  FIXTURE_ORDERS,
  FIXTURE_ORDER_ITEMS,
  FIXTURE_PRODUCTS,
  FIXTURE_SELLER_PROFILES,
  FIXTURE_STORES,
  FIXTURE_USERS,
  FIXTURE_VARIANTS,
  SEED_SUMMARY,
} from "./fixture";

/**
 * Rehearsal tests for the remote D1 seed tooling (`./d1.ts`) against a real D1
 * runtime (workerd via Miniflare) with the committed `migrations/` applied.
 * Every generated SQL statement is executed verbatim — exact proof that the
 * apply/preflight/verify/cleanup files produced by `db:seed:d1:plan` will run
 * against the production D1 binding, in empty and pre-populated states, with
 * foreign keys ON.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

// --- Cross-process id determinism harness (audit A) -----------------------
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX_BIN = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const FIXTURE_TS = fileURLToPath(new URL("./fixture.ts", import.meta.url));

/** Unrelated real row id (valid UUIDv7-shaped) for collision tests. */
const FOREIGN_ROW_ID = "0192a0ff-0000-7000-8000-0000000000ab";

type D1Binding = Awaited<ReturnType<Miniflare["getD1Database"]>>;

let miniflare: Miniflare;
let binding: D1Binding;

/** Drop every table so `applyMigrations` rebuilds a pristine schema. */
async function resetD1(database: D1Binding): Promise<void> {
  for (const name of REVERSE_DEPENDENCY_ORDER) {
    await database.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  await applyMigrations(database);
}

const REVERSE_DEPENDENCY_ORDER = [
  "audit_logs",
  "auth_sessions",
  "cart_items",
  "carts",
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
 * Miniflare's `exec()` rejects multi-line input, so run each generated
 * statement single-line, exactly as the harness does for the migrations.
 */
async function applySql(database: D1Binding, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    const singleLine = statement.replace(/\s+/g, " ");
    expect(singleLine.length).toBeGreaterThan(0);
    await database.exec(singleLine.endsWith(";") ? singleLine : `${singleLine};`);
  }
}

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

async function count(database: D1Binding, table: string): Promise<number> {
  const result = await database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).all<{ n: number }>();
  return Number(result.results[0]?.n ?? 0);
}

async function preflightRow(database: D1Binding): Promise<Record<string, number>> {
  const statement = buildPreflightStatement().replace(/\s+/g, " ");
  const result = await database.prepare(statement).all<Record<string, number>>();
  const row = result.results[0] ?? {};
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)]));
}

async function counts(database: D1Binding): Promise<typeof SEED_SUMMARY> {
  return {
    users: await count(database, "users"),
    sellerProfiles: await count(database, "seller_profiles"),
    stores: await count(database, "stores"),
    categories: await count(database, "categories"),
    products: await count(database, "products"),
    productVariants: await count(database, "product_variants"),
    productImages: await count(database, "product_images"),
    orders: await count(database, "orders"),
    orderItems: await count(database, "order_items"),
  };
}

describe("remote D1 seed tooling (rehearsal, generated SQL verbatim)", () => {
  /** A fresh Miniflare instance per test: workerd never leaks a write lock
   * from an earlier test's deliberate D1 error into the next test's reset. */
  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default {}",
      d1Databases: { DB: "zelora-test" },
      d1Persist: false,
    });
    binding = await miniflare.getD1Database("DB");
    await resetD1(binding);
  }, 30_000);

  afterEach(async () => {
    await miniflare.dispose();
  }, 30_000);

  it("assigns deterministic UUIDv7-shaped ids and a fixed creation instant", () => {
    for (const variant of FIXTURE_VARIANTS) {
      expect(isValidId(variant.id)).toBe(true);
    }
    for (const item of FIXTURE_ORDER_ITEMS) {
      expect(isValidId(item.id)).toBe(true);
    }
    expect(isValidId(FIXTURE_ORDERS[0]!.id)).toBe(true);
    expect(FIXTURE_CREATED_AT_MS).toBe(Date.UTC(2026, 8, 1));
  });

  it("every fixture id is a valid, unique UUIDv7 (exhaustive)", () => {
    const rows = [
      ...FIXTURE_USERS,
      ...FIXTURE_SELLER_PROFILES,
      ...FIXTURE_STORES,
      ...FIXTURE_CATEGORIES,
      ...FIXTURE_PRODUCTS,
      ...FIXTURE_VARIANTS,
      ...FIXTURE_IMAGES,
      ...FIXTURE_ORDERS,
      ...FIXTURE_ORDER_ADDRESSES,
      ...FIXTURE_ORDER_ITEMS,
    ];
    const primaryIds = rows.map((row) => row.id).filter((id): id is string => id !== undefined);
    const variantIds = FIXTURE_VARIANTS.map((row) => row.id);

    expect(primaryIds.length).toBeGreaterThan(20);
    for (const id of primaryIds) {
      expect(isValidId(id), `id ${id}`).toBe(true);
    }
    expect(new Set(primaryIds).size).toBe(primaryIds.length);

    // Inventory rows carry no id of their own: their variant_id is a foreign
    // key that must resolve to an existing fixture variant id.
    const inventoryIds = FIXTURE_INVENTORY.map((row) => row.variantId);
    for (const id of inventoryIds) {
      expect(isValidId(id), `inventory variant id ${id}`).toBe(true);
      expect(variantIds).toContain(id);
    }
  });

  it("produces byte-identical fixture ids from a separate Node process", () => {
    // Re-import the fixture in a fresh process via tsx and dump every id; the
    // ids must never drift by process, since migrate/apply/cleanup/cleanup all
    // derive their rows from the same module.
    const probe = join(tmpdir(), `zelora-id-probe-${process.pid}-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(
      probe,
      [
        `import * as fixture from ${JSON.stringify(FIXTURE_TS)};`,
        "const arrays = (Object.keys(fixture) as Array<keyof typeof fixture>).filter((key) =>",
        "  key.startsWith('FIXTURE_') && Array.isArray(fixture[key] as unknown),",
        ");",
        "const ids = Object.fromEntries(arrays.map((key) => [key, (fixture[key] as Array<{ id?: string; variantId?: string }>).map((row) => row.id ?? row.variantId).filter(Boolean)]));",
        "process.stdout.write(JSON.stringify(ids));",
      ].join("\n"),
    );
    try {
      const stdout = execFileSync(TSX_BIN, [probe], { encoding: "utf8", cwd: REPO_ROOT }).trim();
      const fresh = JSON.parse(stdout) as Record<string, string[]>;

      const inProcess: Record<string, string[]> = {
        FIXTURE_USERS: FIXTURE_USERS.map((row) => row.id),
        FIXTURE_SELLER_PROFILES: FIXTURE_SELLER_PROFILES.map((row) => row.id),
        FIXTURE_STORES: FIXTURE_STORES.map((row) => row.id),
        FIXTURE_CATEGORIES: FIXTURE_CATEGORIES.map((row) => row.id),
        FIXTURE_PRODUCTS: FIXTURE_PRODUCTS.map((row) => row.id),
        FIXTURE_VARIANTS: FIXTURE_VARIANTS.map((row) => row.id),
        FIXTURE_INVENTORY: FIXTURE_INVENTORY.map((row) => row.variantId),
        FIXTURE_IMAGES: FIXTURE_IMAGES.map((row) => row.id),
        FIXTURE_ORDERS: FIXTURE_ORDERS.map((row) => row.id),
        FIXTURE_ORDER_ADDRESSES: FIXTURE_ORDER_ADDRESSES.map((row) => row.id),
        FIXTURE_ORDER_ITEMS: FIXTURE_ORDER_ITEMS.map((row) => row.id),
      };
      for (const [key, expected] of Object.entries(inProcess)) {
        expect(fresh[key], `fresh ids for ${key}`).toEqual(expected);
        expect(fresh[key]).toHaveLength(expected.length);
      }
    } finally {
      unlinkSync(probe);
    }
  }, 30_000);

  it("preflight on a fresh schema reports ready with all required tables", async () => {
    const row = await preflightRow(binding);

    expect(decidePreflight(row)).toMatchObject({
      ready: true,
      alreadySeeded: false,
      partial: false,
      tablesMissing: false,
    });
    expect(row.tables_found).toBe(11); // the 11 fixture tables, not the 16 total
  });

  it("applies the fixture and makes it visible through the catalog repository", async () => {
    await applySql(binding, buildSeedStatements());

    const row = await preflightRow(binding);
    expect(decidePreflight(row).alreadySeeded).toBe(true);
    for (const [key, expected] of Object.entries(EXPECTED_PREFLIGHT)) {
      expect(row[key]).toBe(expected);
    }
    expect(await counts(binding)).toEqual(SEED_SUMMARY);

    const catalog = createD1CatalogRepository(createD1Client(binding));

    expect((await catalog.listActiveCategories()).map((c) => c.slug).sort()).toEqual([
      "audio",
      "gaming",
      "home-living",
    ]);

    const page = await catalog.listActiveProducts({ limit: 20, cursor: null });
    expect(page.items.map((i) => i.slug).sort()).toEqual([
      "gaming-keyboard",
      "gaming-mouse",
      "led-desk-lamp",
      "wireless-headphones",
    ]);
    const headphones = page.items.find((i) => i.slug === "wireless-headphones");
    expect(headphones?.store).toMatchObject({ slug: "zelora-test-store", name: "Zelora Test Store" });
    expect(headphones?.category).toMatchObject({ slug: "audio", name: "Audio" });
    expect(headphones?.priceAmountCents).toBe(129_99);
    expect(headphones?.image).toEqual({
      url: "https://example.test/wireless-headphones.jpg",
      altText: "Wireless Headphones",
    });

    const detail = await catalog.findProductBySlug("wireless-headphones");
    expect(detail?.variants.map((v) => v.name).sort()).toEqual(["Cream", "Matte Black"]);
    expect(detail?.images.filter((i) => i.isPrimary)).toHaveLength(1);
  });

  it("generates valid verify SQL that runs against the applied fixture", async () => {
    await applySql(binding, buildSeedStatements());
    await applySql(binding, [buildVerifyStatement()]);

    const row = await preflightRow(binding);
    expect(decidePreflight(row).alreadySeeded).toBe(true);
    expect(await count(binding, "product_images")).toBe(SEED_SUMMARY.productImages);
  });

  it("is strictly insert-only: no update/delete/replace/drop/alter anywhere in the seed", () => {
    const statements = buildSeedStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.trimStart().toUpperCase().startsWith("INSERT INTO")).toBe(true);
    }
    const forbidden = ["UPDATE ", "DELETE FROM", "REPLACE INTO", " DROP ", "ALTER ", "TRUNCATE", "CREATE "];
    for (const statement of statements) {
      const upper = statement.toUpperCase();
      for (const token of forbidden) {
        expect(upper).not.toContain(token);
      }
    }
    // Cleanup is guarded DELETE-only against the deterministic ids + natural keys.
    for (const statement of buildCleanupStatements()) {
      expect(statement.trimStart().toUpperCase().startsWith("DELETE FROM")).toBe(true);
      expect(statement).toContain("AND");
    }
  });

  it("is idempotent: a second apply is a no-op and never duplicates rows", async () => {
    await applySql(binding, buildSeedStatements());
    const before = await counts(binding);

    await applySql(binding, buildSeedStatements());

    expect(await counts(binding)).toEqual(before);
    expect(decidePreflight(await preflightRow(binding)).alreadySeeded).toBe(true);
    expect(await count(binding, "stores")).toBe(SEED_SUMMARY.stores);
  });

  it("does not create the fixture order when a real order already references the fixture variants", async () => {
    await applySql(binding, buildSeedStatements());

    // A separate real customer places an order on the SAME fixture variants.
    const foreign = "0192a0ff-0000-0000-0000-000000000001";
    const foreignOrder = "0192a0ff-0000-0000-0000-000000000002";
    const variantId = FIXTURE_VARIANTS.find((v) => v.sku === "DEV-WH-BLK")!.id;
    await binding.exec(
      [
        `INSERT INTO users (id, email, role, status, name, password_hash, created_at, updated_at) VALUES ('${foreign}', 'other-customer@example.com', 'customer', 'active', 'Other Customer', NULL, ${FIXTURE_CREATED_AT_MS}, ${FIXTURE_CREATED_AT_MS})`,
        `INSERT INTO orders (id, customer_user_id, status, currency, subtotal_amount_cents, shipping_amount_cents, discount_amount_cents, total_amount_cents, created_at, updated_at) VALUES ('${foreignOrder}', '${foreign}', 'confirmed', 'USD', 12999, 0, 0, 12999, ${FIXTURE_CREATED_AT_MS}, ${FIXTURE_CREATED_AT_MS})`,
        `INSERT INTO order_items (id, order_id, variant_id, store_id, product_name, variant_name, sku, quantity, unit_amount_cents, line_total_amount_cents, currency, status, created_at, updated_at) VALUES ('0192a0ff-0000-0000-0000-000000000003', '${foreignOrder}', '${variantId}', (SELECT id FROM stores WHERE slug = 'zelora-test-store'), 'Wireless Headphones', 'Matte Black', 'DEV-WH-BLK', 1, 12999, 12999, 'USD', 'confirmed', ${FIXTURE_CREATED_AT_MS}, ${FIXTURE_CREATED_AT_MS})`,
      ].join("; "),
    );

    await applySql(binding, buildSeedStatements());

    // The order guard skips a second fixture checkout; only the real order is new.
    expect(await count(binding, "orders")).toBe(2);
    expect(await count(binding, "order_addresses")).toBe(SEED_SUMMARY.orderItems);
    // Partial state is surfaced by preflight (fixture keys present but now with
    // foreign order items on the same variants) — re-apply must not proceed.
    expect(decidePreflight(await preflightRow(binding)).ready).toBe(false);
  });

  it("keeps growing a database that already holds real marketplace rows", async () => {
    await binding.exec(
      `INSERT INTO users (id, email, role, status, name, password_hash, created_at, updated_at) VALUES ('0192a0ff-0000-0000-0000-000000000011', 'real-customer@example.com', 'customer', 'active', 'Real Customer', NULL, ${FIXTURE_CREATED_AT_MS}, ${FIXTURE_CREATED_AT_MS})`,
    );

    await applySql(binding, buildSeedStatements());

    expect(await count(binding, "users")).toBe(SEED_SUMMARY.users + 1);
    expect((await preflightRow(binding)).users_fixture).toBe(SEED_SUMMARY.users);

    await applySql(binding, buildSeedStatements());
    expect(await count(binding, "users")).toBe(SEED_SUMMARY.users + 1);
  });

  it("detects a natural-key collision with an unrelated real row by fixture email or store slug", async () => {
    // A real customer has already claimed the fixture's dev email (distinct id).
    await binding.exec(
      `INSERT INTO users (id, email, role, status, name, password_hash, created_at, updated_at) VALUES ('${FOREIGN_ROW_ID}', '${FIXTURE_USERS[0]!.email}', 'customer', 'active', 'Real Customer With The Same Email', NULL, ${FIXTURE_CREATED_AT_MS}, ${FIXTURE_CREATED_AT_MS})`,
    );
    let state = decidePreflight(await preflightRow(binding));
    expect(state.ready).toBe(false);
    expect(state.alreadySeeded).toBe(false);
    expect(state.partial).toBe(true);
    expect(state.presentKeys).toContain("users_fixture");

    // Same guard for the store slug: an unrelated real store owns the slug.
    await binding.exec(
      `INSERT INTO seller_profiles (id, user_id, slug, display_name, status, created_at, updated_at) VALUES ('${FOREIGN_ROW_ID}', '${FOREIGN_ROW_ID}', 'zelora-test-seller', 'Real Seller', 'active', ${FIXTURE_CREATED_AT_MS}, ${FIXTURE_CREATED_AT_MS})`,
    );
    await binding.exec(
      `INSERT INTO stores (id, seller_profile_id, name, slug, description, status, created_at, updated_at) VALUES ('${FOREIGN_ROW_ID}', '${FOREIGN_ROW_ID}', 'Real Store', 'zelora-test-store', 'Real', 'active', ${FIXTURE_CREATED_AT_MS}, ${FIXTURE_CREATED_AT_MS})`,
    );
    state = decidePreflight(await preflightRow(binding));
    expect(state.partial).toBe(true);
    expect(state.presentKeys).toContain("stores_fixture");
    // Apply must never run in this state — the CLI refuses below.
    expect(state.ready).toBe(false);
  });

  it("cleanup removes only the fixture rows, children first, and keeps foreign data", async () => {
    await binding.exec(
      `INSERT INTO users (id, email, role, status, name, password_hash, created_at, updated_at) VALUES ('0192a0ff-0000-0000-0000-000000000011', 'real-customer@example.com', 'customer', 'active', 'Real Customer', NULL, ${FIXTURE_CREATED_AT_MS}, ${FIXTURE_CREATED_AT_MS})`,
    );
    await applySql(binding, buildSeedStatements());

    await applySql(binding, buildCleanupStatements());

    expect(decidePreflight(await preflightRow(binding)).ready).toBe(true);
    expect(await count(binding, "users")).toBe(1);
    expect(await count(binding, "stores")).toBe(0);
    expect(await count(binding, "order_items")).toBe(0);
    expect(await count(binding, "order_addresses")).toBe(0);

    // Cleanup is itself idempotent.
    await applySql(binding, buildCleanupStatements());
    expect(await count(binding, "users")).toBe(1);
  });

  it("surfaces a partial fixture after an interrupted apply and lets cleanup finish it", async () => {
    // Catalog row statements only — leave the order/address/item tail off, as
    // if the apply was interrupted mid-way.
    const trimmed = buildSeedStatements().filter(
      (s) =>
        !s.startsWith("INSERT INTO orders") &&
        !s.startsWith("INSERT INTO order_addresses") &&
        !s.startsWith("INSERT INTO order_items"),
    );
    await applySql(binding, trimmed);

    const row = await preflightRow(binding);
    expect(decidePreflight(row).partial).toBe(true);

    await applySql(binding, buildCleanupStatements());
    expect(decidePreflight(await preflightRow(binding)).ready).toBe(true);
    expect(await count(binding, "users")).toBe(0);
  });

  it("enforces foreign keys loudly: a dangling reference throws, never silently skips", async () => {
    await applySql(binding, buildSeedStatements());

    // Deleting the customer is blocked by RESTRICT (orders reference it).
    await expect(
      binding.exec(`DELETE FROM users WHERE id = '${FIXTURE_ORDERS[0]!.customerUserId}'`),
    ).rejects.toThrow();

    // An order_item pointing at a non-existent variant is rejected, not ignored.
    await expect(
      binding.exec(
        `INSERT INTO order_items (id, order_id, variant_id, store_id, product_name, variant_name, sku, quantity, unit_amount_cents, line_total_amount_cents, currency, status, created_at, updated_at) VALUES ('0192a0ff-0000-0000-0000-000000000021', '${FIXTURE_ORDERS[0]!.id}', '${isValidIdForTest()}', (SELECT id FROM stores WHERE slug = 'zelora-test-store'), 'Ghost', 'Ghost', 'GHOST', 1, 100, 100, 'USD', 'confirmed', ${FIXTURE_CREATED_AT_MS}, ${FIXTURE_CREATED_AT_MS})`,
      ),
    ).rejects.toThrow();
  });

  it("decidePreflight classifies ready, already-seeded, partial and missing tables", () => {
    const ready = Object.fromEntries(Object.keys(EXPECTED_PREFLIGHT).map((key) => [key, 0])) as Record<string, number>;
    const seeded = Object.fromEntries(Object.entries(EXPECTED_PREFLIGHT).map(([key, value]) => [key, value])) as Record<string, number>;
    const partial = { ...ready, users_fixture: 1 } as Record<string, number>;

    expect(decidePreflight({ ...ready, tables_found: 16 })).toMatchObject({
      ready: true,
      alreadySeeded: false,
      partial: false,
      tablesMissing: false,
    });
    expect(decidePreflight({ ...seeded, tables_found: 16 })).toMatchObject({
      ready: false,
      alreadySeeded: true,
      partial: false,
    });
    expect(decidePreflight({ ...partial, tables_found: 16 })).toMatchObject({
      ready: false,
      alreadySeeded: false,
      partial: true,
      presentKeys: ["users_fixture"],
    });
    expect(decidePreflight({ ...ready, tables_found: 10 })).toMatchObject({ tablesMissing: true });
  });
});

/** A valid UUIDv7-shaped id that references no existing product_variant row. */
function isValidIdForTest(): string {
  const id = "0192a0ff-0000-7000-8000-000000000000";
  expect(isValidId(id)).toBe(true);
  return id;
}