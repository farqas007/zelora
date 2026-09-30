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
  assertRemoteSeedImageBaseUrlReachable,
  buildCleanupStatements,
  buildImageUrlStatement,
  buildPreflightStatement,
  buildRefreshImageStatements,
  buildSeedStatements,
  buildStorefrontStatement,
  buildVerifyStatement,
  buildVerifyStatements,
  currentFixtureImageUrl,
  decidePreflight,
  EXPECTED_PREFLIGHT,
  extractJsonArrayPayload,
  fixtureImageUrls,
  legacyFixtureImageUrls,
  parsePreflightRow,
} from "./d1";
import {
  DEFAULT_SEED_IMAGE_BASE_URL,
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
  SEED_IMAGE_BASE_URL_ENV_VAR,
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

/**
 * Apply the committed migrations to a D1 database in a single transaction.
 *
 * Each test gets a brand-new Miniflare (`d1Persist: false`), so the database
 * starts with no tables at all: there is nothing to drop first, and applying the
 * migrations through one `batch()` is both one round-trip to workerd and atomic
 * — a partially migrated schema can never be left behind for the test to
 * discover.
 */
async function applyMigrations(database: D1Binding): Promise<void> {
  const statements = await readMigrationStatements();
  await database.batch(statements.map((statement) => database.prepare(statement)));
}

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

/**
 * The committed `migrations/` folder as a flat list of single-line statements,
 * read once and memoised: every test migrates a fresh database, and the files
 * never change while the suite runs.
 *
 * Statements are collapsed onto one line because Miniflare's `exec()` rejects
 * multi-line input.
 */
let migrationStatements: Promise<string[]> | undefined;

function readMigrationStatements(): Promise<string[]> {
  migrationStatements ??= (async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
    const statements: string[] = [];
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      for (const block of sql.split("--> statement-breakpoint")) {
        const statement = block.trim().replace(/\s+/g, " ");
        if (statement !== "") {
          statements.push(statement.endsWith(";") ? statement : `${statement};`);
        }
      }
    }
    return statements;
  })();
  return migrationStatements;
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

/**
 * The URLs the fixture wrote for its images in every revision *before* the
 * current one, keyed by product slug and ordered oldest generation first:
 * `example.test` first, then `placehold.co`, then the deployed web Worker's
 * production origin (the last generation that was hardcoded rather than
 * configured).
 *
 * Pinned here as literals, keyed by product slug, so the stale-URL tests build
 * their input independently of `fixtureImageUrls` — otherwise they would just
 * assert that the implementation equals itself and could not catch a wrong or
 * over-broad allowlist. Every generation is listed because a real database can
 * be sitting at any one of them, and the tooling has to migrate each of them.
 */
const LEGACY_IMAGE_URLS_BY_SLUG: Readonly<Record<string, readonly string[]>> = {
  "wireless-headphones": [
    "https://example.test/wireless-headphones.jpg",
    "https://placehold.co/1200x900/ece6f8/1c1230.png?text=Wireless+Headphones",
    "https://zelora-web.farqas007.workers.dev/images/products/wireless-headphones.jpg",
  ],
  "gaming-keyboard": [
    "https://example.test/gaming-keyboard.jpg",
    "https://placehold.co/1200x900/ece6f8/1c1230.png?text=Gaming+Keyboard",
    "https://zelora-web.farqas007.workers.dev/images/products/gaming-keyboard.jpg",
  ],
  "gaming-mouse": [
    "https://example.test/gaming-mouse.jpg",
    "https://placehold.co/1200x900/ece6f8/1c1230.png?text=Gaming+Mouse",
    "https://zelora-web.farqas007.workers.dev/images/products/gaming-mouse.jpg",
  ],
  "led-desk-lamp": [
    "https://example.test/led-desk-lamp.jpg",
    "https://placehold.co/1200x900/ece6f8/1c1230.png?text=LED+Desk+Lamp",
    "https://zelora-web.farqas007.workers.dev/images/products/led-desk-lamp.jpg",
  ],
};

/** Every legacy generation for `image`, oldest first. */
function legacyUrlsFor(image: (typeof FIXTURE_IMAGES)[number]): readonly string[] {
  const product = FIXTURE_PRODUCTS.find((candidate) => candidate.id === image.productId);
  const urls = product === undefined ? undefined : LEGACY_IMAGE_URLS_BY_SLUG[product.slug];
  expect(urls, `no pinned legacy URLs for image ${image.id}`).toBeDefined();
  return urls!;
}

/**
 * The most recent legacy generation — the URL a database seeded one revision ago
 * actually holds. This is the realistic live drift, so the bulk of the
 * stale-URL tests stage exactly this generation.
 */
function legacyUrlFor(image: (typeof FIXTURE_IMAGES)[number]): string {
  const urls = legacyUrlsFor(image);
  expect(urls.length).toBeGreaterThan(0);
  return urls[urls.length - 1]!;
}

/** The oldest legacy generation — the first URL this fixture ever wrote. */
function oldestLegacyUrlFor(image: (typeof FIXTURE_IMAGES)[number]): string {
  const urls = legacyUrlsFor(image);
  expect(urls.length).toBeGreaterThan(0);
  return urls[0]!;
}

/**
 * The exact SQL literal list an allowlist clause should contain for `image`:
 * every pinned legacy generation, then the current URL.
 *
 * Built from the pinned constants above and `FIXTURE_IMAGES`, never from
 * `fixtureImageUrls`/`legacyFixtureImageUrls`, so asserting a generated
 * statement contains this cannot degenerate into comparing the implementation
 * with itself.
 */
function allowlistedUrlList(image: (typeof FIXTURE_IMAGES)[number]): string {
  return [...legacyUrlsFor(image), image.url].map((url) => `'${url}'`).join(", ");
}

/**
 * Reproduce the live-D1 drift exactly: the fixture's deterministic image rows
 * present, but carrying an older fixture revision's URLs (the most recent one).
 */
async function rewriteImagesToLegacyUrls(database: D1Binding): Promise<void> {
  for (const image of FIXTURE_IMAGES) {
    await database
      .prepare("UPDATE product_images SET url = ? WHERE id = ?")
      .bind(legacyUrlFor(image), image.id)
      .run();
  }
}

/**
 * The same drift, one revision further back: rows still carrying the fixture's
 * original `example.test` URLs, which never resolved in DNS.
 */
async function rewriteImagesToOldestLegacyUrls(database: D1Binding): Promise<void> {
  for (const image of FIXTURE_IMAGES) {
    await database
      .prepare("UPDATE product_images SET url = ? WHERE id = ?")
      .bind(oldestLegacyUrlFor(image), image.id)
      .run();
  }
}

async function imageUrls(database: D1Binding): Promise<string[]> {
  const result = await database
    .prepare("SELECT url FROM product_images ORDER BY url")
    .all<{ url: string }>();
  return result.results.map((row: { url: string }) => row.url);
}

/** Every user table in the database, so nothing can hide from a full dump. */
async function allTableNames(database: D1Binding): Promise<string[]> {
  const result = await database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  return result.results
    .map((row: { name: string }) => row.name)
    // SQLite internals and D1's own `_cf_*` books are unreadable (SQLITE_AUTH)
    // and are not user data in any case.
    .filter((name: string) => !name.startsWith("sqlite_") && !name.startsWith("_"));
}

/** A stable serialisation of whole tables, for proving an operation is scoped. */
async function dumpTables(database: D1Binding, tables: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const table of tables) {
    const result = await database
      .prepare(`SELECT * FROM "${table}" ORDER BY 1, 2, 3`)
      .all<Record<string, unknown>>();
    parts.push(`${table} => ${JSON.stringify(result.results)}`);
  }
  return parts.join("\n");
}

/** Every `product_images` column except `url`, so a url-only write can be proven. */
async function imageMetadataRows(database: D1Binding): Promise<string[]> {
  const result = await database
    .prepare(
      "SELECT id, product_id, alt_text, sort_order, is_primary, created_at FROM product_images ORDER BY id",
    )
    .all<Record<string, unknown>>();
  return result.results.map((row: Record<string, unknown>) => JSON.stringify(row));
}

/** Insert a non-fixture image row. `is_primary` must stay 0: the schema allows
 * only one primary image per product, which the fixture rows already use. */
async function insertRealImage(
  database: D1Binding,
  row: { id: string; productId: string; url: string },
): Promise<void> {
  await database
    .prepare(
      "INSERT INTO product_images (id, product_id, url, alt_text, sort_order, is_primary, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
    )
    .bind(row.id, row.productId, row.url, "Real merchant photo", FIXTURE_CREATED_AT_MS)
    .run();
}

/**
 * Only the `product_images` DELETEs from the cleanup file.
 *
 * Used to exercise the image guard in isolation: a full cleanup also deletes the
 * fixture products, and `product_images.product_id` is `ON DELETE CASCADE`, so
 * running everything would remove any image row via cascade and prove nothing
 * about the guard itself.
 */
function imageCleanupStatements(): string[] {
  return buildCleanupStatements().filter((statement) => statement.startsWith("DELETE FROM product_images"));
}

const REAL_IDS = {
  user: "0192a0ff-0000-7000-8000-0000000000b0",
  profile: "0192a0ff-0000-7000-8000-0000000000b1",
  store: "0192a0ff-0000-7000-8000-0000000000b2",
  product: "0192a0ff-0000-7000-8000-0000000000b3",
} as const;

/**
 * A real seller → store → product chain that no fixture guard matches, so
 * images hung off it can only be removed by cascade (if its product were ever
 * deleted) and never by a cleanup DELETE.
 */
async function insertRealProduct(database: D1Binding): Promise<string> {
  const ts = FIXTURE_CREATED_AT_MS;
  await database
    .prepare(
      "INSERT INTO users (id, email, role, status, name, password_hash, created_at, updated_at) VALUES (?, 'real-seller@zelora.example', 'seller', 'active', 'Real Seller', NULL, ?, ?)",
    )
    .bind(REAL_IDS.user, ts, ts)
    .run();
  await database
    .prepare(
      "INSERT INTO seller_profiles (id, user_id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, 'real-seller-shop', 'Real Seller Shop', 'active', ?, ?)",
    )
    .bind(REAL_IDS.profile, REAL_IDS.user, ts, ts)
    .run();
  await database
    .prepare(
      "INSERT INTO stores (id, seller_profile_id, name, slug, description, status, created_at, updated_at) VALUES (?, ?, 'Real Store', 'real-store', 'Not the fixture', 'active', ?, ?)",
    )
    .bind(REAL_IDS.store, REAL_IDS.profile, ts, ts)
    .run();
  // category_id stays NULL so the row is coupled to no fixture category.
  await database
    .prepare(
      "INSERT INTO products (id, store_id, category_id, name, slug, description, status, created_at, updated_at) VALUES (?, ?, NULL, 'Real Product', 'real-product', 'Not the fixture', 'active', ?, ?)",
    )
    .bind(REAL_IDS.product, REAL_IDS.store, ts, ts)
    .run();
  return REAL_IDS.product;
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
   * from an earlier test's deliberate D1 error into the next test's reset.
   * The instance is empty, so migrating it is all the setup a test needs. */
  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default {}",
      d1Databases: { DB: "zelora-test" },
      d1Persist: false,
    });
    binding = await miniflare.getD1Database("DB");
    await applyMigrations(binding);
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
      url: `${DEFAULT_SEED_IMAGE_BASE_URL}/images/products/wireless-headphones.jpg`,
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

  it("recognises stale-URL fixture image rows as the fixture's own rows", async () => {
    await applySql(binding, buildSeedStatements());
    await rewriteImagesToLegacyUrls(binding);
    expect(await imageUrls(binding)).toEqual(FIXTURE_IMAGES.map((image) => legacyUrlFor(image)).sort());

    // Every image row is the fixture's, just under an older URL. The preflight
    // must count them as present: reading them as absent is what made the live
    // database look "partially seeded" and blocked cleanup/apply.
    const row = await preflightRow(binding);
    expect(row.product_images_fixture).toBe(FIXTURE_IMAGES.length);
    expect(row.product_images_fixture).toBe(EXPECTED_PREFLIGHT.product_images_fixture);
    expect(decidePreflight(row)).toMatchObject({ alreadySeeded: true, partial: false, ready: false });
  });

  it("cleanup removes stale-URL fixture image rows, and a later apply restores the current URLs", async () => {
    await applySql(binding, buildSeedStatements());
    await rewriteImagesToLegacyUrls(binding);

    await applySql(binding, buildCleanupStatements());

    expect(decidePreflight(await preflightRow(binding)).ready).toBe(true);
    expect(await count(binding, "product_images")).toBe(0);

    // Re-applying is what converges the database onto the current URLs. It also
    // proves the stale rows were genuinely gone: had any survived, the new
    // primary image would collide with the one-primary-per-product index.
    await applySql(binding, buildSeedStatements());
    expect(await imageUrls(binding)).toEqual(FIXTURE_IMAGES.map((image) => image.url).sort());
    expect(decidePreflight(await preflightRow(binding)).alreadySeeded).toBe(true);
  });

  it("cleanup removes the current fixture image rows too, without any legacy rewrite", async () => {
    await applySql(binding, buildSeedStatements());
    expect(await imageUrls(binding)).toEqual(FIXTURE_IMAGES.map((image) => image.url).sort());

    await applySql(binding, buildCleanupStatements());

    expect(await count(binding, "product_images")).toBe(0);
    expect(decidePreflight(await preflightRow(binding)).ready).toBe(true);
  });

  it("never removes an image row that is not the fixture's own, whatever it happens to share", async () => {
    // The decoys hang off a real (non-fixture) product on purpose.
    // `product_images.product_id` is `ON DELETE CASCADE`, so a real image
    // attached to a *fixture* product is unavoidably removed when cleanup
    // deletes that product — that is the schema's cascade, not the image
    // guard, and it would mask what these assertions are actually checking.
    const realProductId = await insertRealProduct(binding);
    await applySql(binding, buildSeedStatements());
    await rewriteImagesToLegacyUrls(binding);

    const legacyUrl = legacyUrlFor(FIXTURE_IMAGES[0]!);
    // A real photo that reuses a legacy fixture URL verbatim but has its own id:
    // only the id guard can keep it.
    const realWithLegacyUrl = legacyUrl;
    // A real photo on a host this fixture has used, but at a URL that is not
    // itself allowlisted: only the closed equality allowlist can keep it.
    const realOnLegacyHost = "https://example.test/merchant-real-photo.jpg";
    // An ordinary real photo: shares nothing with the fixture.
    const realPhoto = "https://cdn.zelora.example/merchant-headphones.jpg";

    await insertRealImage(binding, {
      id: FOREIGN_ROW_ID,
      productId: realProductId,
      url: realWithLegacyUrl,
    });
    await insertRealImage(binding, {
      id: "0192a0ff-0000-7000-8000-0000000000c2",
      productId: realProductId,
      url: realOnLegacyHost,
    });
    await insertRealImage(binding, {
      id: "0192a0ff-0000-7000-8000-0000000000c3",
      productId: realProductId,
      url: realPhoto,
    });

    await applySql(binding, buildCleanupStatements());

    // Every real row survives, including the one whose URL is byte-identical to
    // a legacy fixture URL: ownership is the id + product id pair, not the URL.
    expect(await imageUrls(binding)).toEqual([legacyUrl, realOnLegacyHost, realPhoto].sort());
    for (const image of FIXTURE_IMAGES) {
      const remaining = await binding
        .prepare("SELECT COUNT(*) AS n FROM product_images WHERE id = ?")
        .bind(image.id)
        .first<{ n: number }>();
      expect(Number(remaining?.n ?? 0), `fixture image ${image.id} survived cleanup`).toBe(0);
    }
    // The real chain is intact, and the fixture keys are genuinely gone.
    expect(await count(binding, "products")).toBe(1);
    expect(decidePreflight(await preflightRow(binding)).ready).toBe(true);
  });

  it("leaves a row that claims a fixture image id but is not the fixture's, and fails closed", async () => {
    const realProductId = await insertRealProduct(binding);
    await applySql(binding, buildSeedStatements());

    // Case A: the fixture's own id and product id, but a URL the fixture never
    // wrote. Only the closed allowlist can keep it.
    const squatted = "https://cdn.zelora.example/taken-over-headphones.jpg";
    await binding
      .prepare("UPDATE product_images SET url = ? WHERE id = ?")
      .bind(squatted, FIXTURE_IMAGES[0]!.id)
      .run();

    // Case B: a fixture image id carrying a real fixture URL, but belonging to
    // a different product. Only the id + product id pairing can keep it.
    await binding
      .prepare("UPDATE product_images SET product_id = ? WHERE id = ?")
      .bind(realProductId, FIXTURE_IMAGES[1]!.id)
      .run();

    // Image guard only. A full cleanup also deletes the fixture products, and
    // `product_images.product_id` is ON DELETE CASCADE, which would remove both
    // rows regardless of the guard under test.
    await applySql(binding, imageCleanupStatements());

    expect(await imageUrls(binding)).toEqual([squatted, FIXTURE_IMAGES[1]!.url].sort());
    expect(await count(binding, "product_images")).toBe(2);

    // Failing closed is the point: the fixture's first image key is still
    // claimed, so cleanup must not report success and let a later apply insert
    // a second primary image for the same product.
    const row = await preflightRow(binding);
    expect(row.product_images_fixture).toBe(1);
    expect(decidePreflight(row).ready).toBe(false);
  });

  it("refresh-images: rewrites a stale fixture image URL to the current one, and touches nothing else", async () => {
    const otherTables = (await allTableNames(binding)).filter((name) => name !== "product_images");
    await applySql(binding, buildSeedStatements());
    await rewriteImagesToLegacyUrls(binding);

    const beforeOtherTables = await dumpTables(binding, otherTables);
    const beforeImageMetadata = await imageMetadataRows(binding);
    expect(await imageUrls(binding)).toEqual(FIXTURE_IMAGES.map((image) => legacyUrlFor(image)).sort());

    await applySql(binding, buildRefreshImageStatements());

    expect(await imageUrls(binding)).toEqual(FIXTURE_IMAGES.map((image) => image.url).sort());
    // Not one other table moved — critically, no product row was deleted, so
    // nothing could reach a real merchant's images through ON DELETE CASCADE.
    expect(await dumpTables(binding, otherTables)).toBe(beforeOtherTables);
    // And within product_images, only the url column moved.
    expect(await imageMetadataRows(binding)).toEqual(beforeImageMetadata);
  });

  it("refresh-images: migrates a database still on the oldest legacy generation, in one run", async () => {
    // A database seeded from the fixture's *first* revision carries the original
    // `example.test` URLs, not the later `placehold.co` ones. Both generations
    // stay in the allowlist, so a single run converges either starting point
    // rather than needing one run per revision.
    await applySql(binding, buildSeedStatements());
    await rewriteImagesToOldestLegacyUrls(binding);
    expect(await imageUrls(binding)).toEqual(FIXTURE_IMAGES.map((image) => oldestLegacyUrlFor(image)).sort());

    await applySql(binding, buildRefreshImageStatements());

    expect(await imageUrls(binding)).toEqual(FIXTURE_IMAGES.map((image) => image.url).sort());
    // Still a url-only write: no product deleted, so nothing could have reached
    // a real merchant's images through ON DELETE CASCADE.
    expect(await count(binding, "products")).toBe(FIXTURE_PRODUCTS.length);
  });

  it("cleanup removes fixture image rows at the oldest legacy generation too", async () => {
    await applySql(binding, buildSeedStatements());
    await rewriteImagesToOldestLegacyUrls(binding);

    await applySql(binding, buildCleanupStatements());

    expect(await count(binding, "product_images")).toBe(0);
    expect(decidePreflight(await preflightRow(binding)).ready).toBe(true);
  });

  it("refresh-images: is a no-op when the URLs are already current, and stays a no-op when repeated", async () => {
    await applySql(binding, buildSeedStatements());
    const before = await imageUrls(binding);
    expect(before).toEqual(FIXTURE_IMAGES.map((image) => image.url).sort());

    // The guard admits only stale URLs, so these UPDATEs match nothing at all.
    await applySql(binding, buildRefreshImageStatements());
    expect(await imageUrls(binding)).toEqual(before);

    await applySql(binding, buildRefreshImageStatements());
    expect(await imageUrls(binding)).toEqual(before);
  });

  it("refresh-images: never touches a row that is not the fixture's own", async () => {
    const realProductId = await insertRealProduct(binding);
    await applySql(binding, buildSeedStatements());
    await rewriteImagesToLegacyUrls(binding);

    // (a) unrelated id, unrelated product, ordinary real photo.
    const realPhoto = "https://cdn.zelora.example/merchant-headphones.jpg";
    // (b) unrelated id and product, but reusing a legacy fixture URL verbatim:
    // only the id + product id guard can keep it.
    const realWithLegacyUrl = legacyUrlFor(FIXTURE_IMAGES[0]!);
    await insertRealImage(binding, { id: FOREIGN_ROW_ID, productId: realProductId, url: realPhoto });
    await insertRealImage(binding, {
      id: "0192a0ff-0000-7000-8000-0000000000c1",
      productId: realProductId,
      url: realWithLegacyUrl,
    });
    // (c) the fixture's own image id carrying a URL the fixture never wrote:
    // only the closed allowlist can keep it.
    const squatted = "https://cdn.zelora.example/squatted-headphones.jpg";
    await binding
      .prepare("UPDATE product_images SET url = ? WHERE id = ?")
      .bind(squatted, FIXTURE_IMAGES[0]!.id)
      .run();
    // (d) the fixture's own image id and legacy URL, but a real product:
    // only the id + product id pairing can keep it.
    await binding
      .prepare("UPDATE product_images SET product_id = ? WHERE id = ?")
      .bind(realProductId, FIXTURE_IMAGES[1]!.id)
      .run();

    await applySql(binding, buildRefreshImageStatements());

    // Images 2 and 3 are the only rows that moved: (a)-(d) are all still exactly
    // as they were, including the one whose URL matched the allowlist byte for byte.
    expect(await imageUrls(binding)).toEqual(
      [
        squatted,
        legacyUrlFor(FIXTURE_IMAGES[1]!),
        realPhoto,
        realWithLegacyUrl,
        FIXTURE_IMAGES[2]!.url,
        FIXTURE_IMAGES[3]!.url,
      ].sort(),
    );
    // The real seller chain is intact and so is the whole fixture catalog:
    // refreshing URLs must not have cost a single product, variant or store.
    expect(await count(binding, "products")).toBe(FIXTURE_PRODUCTS.length + 1);
    expect(await count(binding, "product_variants")).toBe(FIXTURE_VARIANTS.length);
    expect(await count(binding, "stores")).toBe(FIXTURE_STORES.length + 1);
    const row = await preflightRow(binding);
    expect(row.products_fixture).toBe(FIXTURE_PRODUCTS.length);
    // Case (d) moved one image row onto a real product, so the fixture owns
    // three of its four image keys — down one, and only by that deliberate move.
    expect(row.product_images_fixture).toBe(FIXTURE_IMAGES.length - 1);
  });

  it("refresh-images: reports every fixture image row individually, not as a count", async () => {
    await applySql(binding, buildSeedStatements());
    await rewriteImagesToLegacyUrls(binding);

    const statement = buildImageUrlStatement();
    expect(statement.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
    const rows = await binding
      .prepare(statement)
      .all<{ id: string; product_id: string; url: string }>();

    // One row per fixture image: a count could not tell "all four stale" from
    // "one stale", which is exactly the distinction the refresh has to make.
    expect(rows.results).toHaveLength(FIXTURE_IMAGES.length);
    for (const row of rows.results) {
      const image = FIXTURE_IMAGES.find((candidate) => candidate.id === row.id)!;
      expect(image).toBeDefined();
      expect(row.product_id).toBe(image.productId);
      expect(row.url).toBe(legacyUrlFor(image));
      expect(currentFixtureImageUrl(row.id)).toBe(image.url);
    }
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

/**
 * Wrangler `--json` output handling.
 *
 * Regression coverage for the remote `verify` failure: `wrangler d1 execute
 * --file … --json` prints its progress rendering (`├ Checking if file needs
 * uploading`, `├ 🌀 Uploading …`) to **stdout** ahead of the payload, so
 * `JSON.parse(stdout)` threw `Unexpected token '├'`. The fixture below is a
 * verbatim capture of that real remote output.
 *
 * Pure string tests — no Miniflare, no wrangler, no network.
 */
describe("wrangler --json output parsing", () => {
  const SPINNER_PREFIX =
    "├ Checking if file needs uploading\n" +
    "│\n" +
    "├ 🌀 Uploading 245a64cf-0841-4faf-978c-171c03fd0dc8.29b09cf0cdd0e622.sql\n" +
    "│ 🌀 Uploading complete.\n" +
    "│\n";

  /** The exact shape `d1 execute --file --json` returns: one entry, stats only. */
  const FILE_STATS_STDOUT = `${SPINNER_PREFIX}${JSON.stringify(
    [
      {
        results: [
          {
            "Total queries executed": 2,
            "Rows read": 196,
            "Rows written": 0,
            "Database size (MB)": "0.32",
          },
        ],
        success: true,
        finalBookmark: "0000006e-00000004-000050f1-c95ee698aa55ad9f1295f4856311ca7f",
        meta: { rows_read: 196, rows_written: 0 },
      },
    ],
    null,
    2,
  )}\n`;

  it("skips wrangler's spinner/progress lines written to stdout before the payload", () => {
    const payload = extractJsonArrayPayload(FILE_STATS_STDOUT);
    expect(payload.startsWith("[")).toBe(true);
    expect(payload).not.toContain("Uploading");
    expect(JSON.parse(payload)).toEqual([
      expect.objectContaining({ success: true, finalBookmark: expect.any(String) }),
    ]);
  });

  it("passes through a payload that already starts the stream", () => {
    const bare = JSON.stringify([{ results: [{ a: 1 }] }]);
    expect(extractJsonArrayPayload(bare)).toBe(bare);
    expect(extractJsonArrayPayload(`  ${bare}\n`)).toBe(bare);
  });

  it("ignores anything printed after the payload and keeps nesting/string braces intact", () => {
    const payload = JSON.stringify([
      {
        results: [{ url: "https://placehold.co/a.png?text=Wireless+[Headphones]", nested: [1, [2, 3]] }],
      },
    ]);
    expect(extractJsonArrayPayload(`${SPINNER_PREFIX}${payload}\nDone in 42ms.\n`)).toBe(payload);
  });

  it("fails loudly when the stream holds no JSON array or is truncated", () => {
    expect(() => extractJsonArrayPayload("")).toThrow(/no JSON output/);
    expect(() => extractJsonArrayPayload("Error: something went wrong")).toThrow(/no JSON output/);
    expect(() => extractJsonArrayPayload('[\n  { "results": [\n')).toThrow(/truncated JSON/);
  });

  it("parses a preflight row out of a spinner-prefixed stream", () => {
    const row = Object.fromEntries([
      ...Object.entries(EXPECTED_PREFLIGHT).map(([key, value]) => [key, value]),
      ...Object.keys(EXPECTED_PREFLIGHT).map((key) => [key.replace(/_fixture$/, "_total"), 0]),
      ["tables_found", 11],
    ]);
    const stdout = `${SPINNER_PREFIX}${JSON.stringify([{ results: [row], success: true }], null, 2)}\n`;
    const parsed = parsePreflightRow(stdout);
    expect(parsed.users_fixture).toBe(EXPECTED_PREFLIGHT.users_fixture);
    expect(parsed.tables_found).toBe(11);
    expect(decidePreflight(parsed)).toMatchObject({ alreadySeeded: true, partial: false });
  });

  it("refuses to read counts out of the aggregate stats a --file run returns", () => {
    // Regression guard for the silent false negative: stats coerce to all-zero
    // counts, which would read as "no fixture rows present" and could wrongly
    // authorise a write. parsePreflightRow must fail closed instead.
    expect(() => parsePreflightRow(FILE_STATS_STDOUT)).toThrow(/expected count columns/);
  });
});

/**
 * The generated `product_images` cleanup guard, checked on the SQL text alone.
 *
 * `product_images` is the one table whose natural key has changed across
 * fixture revisions, so its guard is the one place where a stale row must still
 * be removable. These assertions pin that the widened URL set is a *closed
 * allowlist on top of* the deterministic id + product id — never a widening of
 * ownership.
 */
describe("remote image base gate", () => {
  it("refuses loopback image URLs, which no remote browser can load", () => {
    // The default base is the local Vite server. Seeding those URLs into D1
    // would write rows that look structurally perfect and render as broken
    // images for everyone except the machine that ran the seed.
    expect(() => assertRemoteSeedImageBaseUrlReachable()).toThrowError(
      /refusing to seed image URLs from a loopback origin/,
    );
    expect(() => assertRemoteSeedImageBaseUrlReachable()).toThrowError(
      new RegExp(SEED_IMAGE_BASE_URL_ENV_VAR),
    );
  });

  it("accepts a reachable image origin", () => {
    const reachable = FIXTURE_IMAGES.map((image) => ({
      ...image,
      url: image.url.replace(DEFAULT_SEED_IMAGE_BASE_URL, "https://web.example.com"),
    }));
    expect(() => assertRemoteSeedImageBaseUrlReachable(reachable)).not.toThrow();
  });

  it("accepts an empty image list, which has nothing to write", () => {
    expect(() => assertRemoteSeedImageBaseUrlReachable([])).not.toThrow();
  });
});

describe("product_images cleanup guard (generated SQL, no database)", () => {
  const imageDeletes = (): string[] =>
    buildCleanupStatements().filter((statement) => statement.startsWith("DELETE FROM product_images"));

  it("emits one guarded DELETE per fixture image", () => {
    expect(imageDeletes()).toHaveLength(FIXTURE_IMAGES.length);
  });

  it("pins the deterministic image id and product id and admits only the known fixture URLs", () => {
    for (const image of FIXTURE_IMAGES) {
      const statement = imageDeletes().find((candidate) => candidate.includes(`id = '${image.id}'`));
      expect(statement, `no DELETE for fixture image ${image.id}`).toBeDefined();
      // Ownership is still the deterministic id + product id pair.
      expect(statement).toContain(`id = '${image.id}'`);
      expect(statement).toContain(`AND product_id = '${image.productId}'`);
      // The URL set is exactly every legacy generation plus the current one,
      // and nothing else.
      expect(statement).toContain(`url IN (${allowlistedUrlList(image)})`);
      expect(statement).not.toContain("example.test/merchant");
    }
  });

  it("uses a closed equality allowlist, never a wildcard or an OR-chain", () => {
    for (const statement of imageDeletes()) {
      expect(statement).toContain("url IN (");
      expect(statement).not.toContain("LIKE");
      expect(statement).not.toContain("GLOB");
      expect(statement).not.toContain("%");
      // No OR-chain: each DELETE can only ever address its own one image.
      expect(statement).not.toContain(" OR ");
    }
  });

  it("fixtureImageUrls lists every legacy generation then the current one, per image", () => {
    for (const image of FIXTURE_IMAGES) {
      expect(fixtureImageUrls(image)).toEqual([...legacyUrlsFor(image), image.url]);
    }
  });

  it("every legacy generation belongs to a fixture product, and the whole set is unique", () => {
    const legacy = FIXTURE_IMAGES.flatMap((image) => legacyUrlsFor(image));
    // Every past generation stays recognisable, so a database sitting at any of
    // them can still be migrated by refresh-images and cleaned up — including
    // the production-origin generation this fixture used to hardcode.
    expect(legacy).toHaveLength(FIXTURE_IMAGES.length * 3);
    for (const url of legacy) {
      expect(url).toMatch(
        /^https:\/\/(placehold\.co|example\.test|zelora-web\.farqas007\.workers\.dev)\//,
      );
    }

    const allowed = FIXTURE_IMAGES.flatMap((image) => fixtureImageUrls(image));
    expect(new Set(allowed).size).toBe(allowed.length);
  });

  it("every current image URL is an absolute URL on the configured image origin", () => {
    // The demo artwork is served as static assets by the web deployment: the
    // four files live in `apps/web/public/images/products/` and Vite copies
    // `public/` to the build root, so each URL is that deployment's origin plus
    // the file's public path. The origin is configuration
    // (`ZELORA_SEED_IMAGE_BASE_URL`), not a hardcoded deployment. A reserved
    // host here would render a broken image, and a root-relative path would
    // violate the "fetched directly, no rewrite" contract the catalog mapping
    // relies on.
    const seen = new Set<string>();
    for (const image of FIXTURE_IMAGES) {
      const url = new URL(image.url);
      expect(url.protocol === "http:" || url.protocol === "https:").toBe(true);
      expect(url.origin).toBe(DEFAULT_SEED_IMAGE_BASE_URL);
      expect(url.pathname).toMatch(/^\/images\/products\/[a-z0-9-]+\.jpg$/);
      seen.add(url.pathname);
    }
    // One distinct asset per fixture image — no two products share a file.
    expect(seen.size).toBe(FIXTURE_IMAGES.length);
  });

  it("the preflight counts image rows by id + product id, never narrowed by URL", () => {
    const line = buildPreflightStatement()
      .split("\n")
      .find((candidate) => candidate.includes("AS product_images_fixture"));
    expect(line).toBeDefined();
    for (const image of FIXTURE_IMAGES) {
      expect(line).toContain(`(id = '${image.id}' AND product_id = '${image.productId}')`);
    }
    // A URL predicate here would hide a stale-URL row as "absent" again.
    expect(line).not.toContain("url");
  });

  it("keeps the preflight and the cleanup in agreement about what a fixture image row is", () => {
    // Both derive the same ownership pairs (the preflight parenthesises them for
    // its OR-chain, the DELETE inlines them), so cleanup can never be blocked by
    // a preflight that disagrees, nor pass a check it does not satisfy.
    const preflight = buildPreflightStatement().replace(/\s+/g, " ");
    for (const image of FIXTURE_IMAGES) {
      const id = `id = '${image.id}'`;
      const productId = `product_id = '${image.productId}'`;
      expect(preflight).toContain(`(${id} AND ${productId})`);
      const statement = imageDeletes().find((candidate) => candidate.includes(id));
      expect(statement).toContain(`${id} AND ${productId}`);
    }
  });
});

/**
 * The generated `refresh-images` SQL, checked on the text alone.
 *
 * `refresh-images` is the only builder in this file that writes an UPDATE, so
 * its blast radius is asserted explicitly: one statement per fixture image, one
 * column assigned, one table named, and a guard that is a closed conjunction.
 */
describe("refresh-images SQL (generated, no database)", () => {
  const FORBIDDEN = [
    "DELETE ",
    "INSERT ",
    "ALTER ",
    "DROP ",
    "CREATE ",
    "TRUNCATE",
    "REPLACE ",
    "LIKE",
    "GLOB",
    "%",
    " OR ",
  ];

  it("emits exactly one statement per fixture image", () => {
    expect(buildRefreshImageStatements()).toHaveLength(FIXTURE_IMAGES.length);
  });

  it("assigns only product_images.url, on the exact id + product id + legacy URLs", () => {
    for (const image of FIXTURE_IMAGES) {
      const statement = buildRefreshImageStatements().find((candidate) => candidate.includes(`id = '${image.id}'`));
      expect(statement, `no UPDATE for fixture image ${image.id}`).toBeDefined();
      // Every past generation is admitted, so a database sitting at any of them
      // converges in one run; the current URL is not among them.
      expect(statement).toBe(
        `UPDATE product_images SET url = '${image.url}' ` +
          `WHERE id = '${image.id}' AND product_id = '${image.productId}' ` +
          `AND url IN (${legacyUrlsFor(image).map((url) => `'${url}'`).join(", ")})`,
      );
    }
  });

  it("never writes a column other than url, nor touches another table", () => {
    for (const statement of buildRefreshImageStatements()) {
      const setList = statement.slice(statement.indexOf(" SET ") + 5, statement.indexOf(" WHERE "));
      expect(setList).toMatch(/^url = '[^']*'$/);
      expect(setList).not.toContain("alt_text");
      expect(setList).not.toContain("sort_order");
      expect(setList).not.toContain("is_primary");
      // product_images is the only table named anywhere in the statement.
      expect(statement.match(/product_images/g)).toHaveLength(1);
    }
  });

  it("keeps every write keyword out of the statement but its single UPDATE", () => {
    for (const statement of buildRefreshImageStatements()) {
      const upper = statement.toUpperCase();
      for (const token of FORBIDDEN) {
        expect(upper, `token ${JSON.stringify(token)}`).not.toContain(token);
      }
      expect(upper.match(/UPDATE/g)).toHaveLength(1);
    }
  });

  it("admits only stale URLs, so a row already on the current URL is never written", () => {
    // This is the whole idempotency mechanism: the current URL is absent from
    // every guard, so re-running matches zero rows without needing a check.
    for (const image of FIXTURE_IMAGES) {
      const guard = legacyFixtureImageUrls(image);
      expect(guard).toEqual([...legacyUrlsFor(image)]);
      expect(guard).not.toContain(image.url);
      const statement = buildRefreshImageStatements().find((candidate) =>
        candidate.includes(`id = '${image.id}'`),
      )!;
      const guardList = statement.slice(statement.indexOf("url IN (") + "url IN (".length);
      expect(guardList).toBe(`${legacyUrlsFor(image).map((url) => `'${url}'`).join(", ")})`);
      expect(guardList).not.toContain(image.url);
    }
  });

  it("is the only builder that writes an UPDATE, leaving apply insert-only and cleanup delete-only", () => {
    expect(buildRefreshImageStatements().every((s) => s.startsWith("UPDATE product_images"))).toBe(true);
    expect(buildSeedStatements().every((s) => s.startsWith("INSERT INTO"))).toBe(true);
    expect(buildCleanupStatements().every((s) => s.startsWith("DELETE FROM"))).toBe(true);
    expect(buildSeedStatements().some((s) => s.toUpperCase().includes("UPDATE "))).toBe(false);
  });

  it("exposes the image URL report as a single read-only SELECT", () => {
    const statement = buildImageUrlStatement();
    expect(statement.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
    const upper = statement.toUpperCase();
    for (const token of ["UPDATE", "DELETE", "INSERT", "ALTER", "DROP", "CREATE"]) {
      expect(upper).not.toContain(token);
    }
    // Filtered to the fixture's own rows, so the report can only ever see them.
    for (const image of FIXTURE_IMAGES) {
      expect(statement).toContain(`id = '${image.id}' AND product_id = '${image.productId}'`);
    }
  });

  it("exposes the current URL per fixture image id and nothing else", () => {
    for (const image of FIXTURE_IMAGES) {
      expect(currentFixtureImageUrl(image.id)).toBe(image.url);
    }
    expect(currentFixtureImageUrl(FOREIGN_ROW_ID)).toBeUndefined();
    expect(currentFixtureImageUrl("")).toBeUndefined();
  });
});

/** The read-only shape of the two statements `verify` runs. */
describe("verify statements", () => {
  const FORBIDDEN = ["UPDATE ", "DELETE FROM", "INSERT INTO", "REPLACE INTO", "DROP ", "ALTER ", "CREATE ", "TRUNCATE"];

  it("buildVerifyStatements returns the preflight and storefront SELECTs separately", () => {
    const [preflight, storefront] = buildVerifyStatements();
    expect(preflight).toBe(buildPreflightStatement());
    expect(storefront).toBe(buildStorefrontStatement());
    // Two discrete statements: `wrangler d1 execute --file` collapses a
    // multi-statement file into one aggregate-stats entry, so verify must run
    // them one `--command` at a time to get per-statement rows.
    expect(buildVerifyStatements()).toHaveLength(2);
  });

  it("every verify statement is a single read-only SELECT", () => {
    for (const statement of buildVerifyStatements()) {
      expect(statement.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
      expect(statement).not.toContain(";");
      const upper = statement.toUpperCase();
      for (const token of FORBIDDEN) {
        expect(upper, `token ${token} in ${statement.slice(0, 40)}`).not.toContain(token);
      }
    }
  });

  it("the combined verify.sql artifact still contains both statements", () => {
    const combined = buildVerifyStatement();
    expect(combined).toContain(buildPreflightStatement());
    expect(combined).toContain(buildStorefrontStatement());
    expect(combined).toContain(";\n");
  });
});

/** A valid UUIDv7-shaped id that references no existing product_variant row. */
function isValidIdForTest(): string {
  const id = "0192a0ff-0000-7000-8000-000000000000";
  expect(isValidId(id)).toBe(true);
  return id;
}