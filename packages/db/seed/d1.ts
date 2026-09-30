/**
 * Remote D1 seed tooling for the development/test marketplace fixture.
 *
 * Generates idempotent, insert-only SQL from the shared fixture
 * (`./fixture.ts`) and, when explicitly asked, applies it to the live
 * Cloudflare D1 database bound by `apps/api/wrangler.jsonc`.
 *
 * Safety contract (mirrors `assertSeedAllowed` for the remote path):
 *
 *   - SQL is generated from the same fixture as the local seed, so the two
 *     can never drift; every row keeps the natural-key idempotency strategy.
 *   - Apply never UPDATEs or DELETEs: every insert is guarded by `WHERE NOT
 *     EXISTS` on the row's natural key, and reads resolve parent ids from the
 *     natural keys already in the database (no id copying between tables).
 *   - Running the seed twice is a no-op; partial fixture rows in an *unrelated*
 *     state abort instead of being mutated (FKs are also enforced by D1).
 *   - The apply path is opt-in and fail-closed: it requires an explicit
 *     `--remote`, an explicit `--database zelora` that matches the committed
 *     binding, `ZELORA_REMOTE_SEED_ALLOW=1`, and `--yes` confirmation. It then
 *     runs a read-only preflight and refuses to proceed unless the database is
 *     either fully free of the fixture keys or already fully seeded.
 *   - Cleanup is a separate opt-in SQL file that deletes ONLY rows matching the
 *     fixture's deterministic ids AND a natural key, children first. Product
 *     images are additionally restricted to the URLs this fixture has actually
 *     written (the current one plus every entry in
 *     `LEGACY_FIXTURE_IMAGE_URLS`, one per past revision), so a stale-URL row of
 *     the fixture's own is removable while an unrelated row squatting a
 *     fixture id is never matched.
 *   - `refresh-images` is the narrow alternative to cleanup + apply when only the
 *     fixture image URLs have drifted: it UPDATEs nothing but `product_images.url`,
 *     and only on rows matching the deterministic image id AND product id AND a
 *     legacy fixture URL. It never deletes a product, so it cannot reach a real
 *     merchant's images through `product_images`' `ON DELETE CASCADE`.
 *
 * Never run by tests/CI: every exported builder is pure, and the CLI entry is
 * only active when the file is executed directly (`import.meta.url` check).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  FIXTURE_CATEGORIES,
  FIXTURE_CREATED_AT_MS,
  FIXTURE_IMAGES,
  FIXTURE_INVENTORY,
  FIXTURE_ORDER_ADDRESSES,
  FIXTURE_ORDER_ITEMS,
  FIXTURE_ORDERS,
  FIXTURE_PRODUCTS,
  FIXTURE_SELLER_PROFILES,
  FIXTURE_STORES,
  FIXTURE_USERS,
  FIXTURE_VARIANTS,
  SEED_IMAGE_BASE_URL_ENV_VAR,
  isLoopbackSeedImageBaseUrl,
  type FixtureImage,
} from "./fixture";

const API_BINDING = "DB";
const TARGET_DATABASE_NAME = "zelora";
const TARGET_DATABASE_ID = "245a64cf-0841-4faf-978c-171c03fd0dc8";
const REQUIRED_TABLES = [
  "users",
  "seller_profiles",
  "stores",
  "categories",
  "products",
  "product_variants",
  "inventory",
  "product_images",
  "orders",
  "order_addresses",
  "order_items",
] as const;

const TS = FIXTURE_CREATED_AT_MS;

/** Escape a string for use as a single-quoted SQL literal. */
function sqlStr(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Natural-key SKUs referenced by the fixture order, for guards. */
const ORDER_VARIANT_IDS = FIXTURE_ORDER_ITEMS.map((item) => item.variantId);

/**
 * One idempotent insert per fixture row, with FK parents resolved from the
 * database by their natural keys. Intentionally verbose/explicit: each
 * statement is a single self-contained guard that can fail loudly (a parent
 * missing is a hard error, not a silent skip).
 */
export function buildSeedStatements(): string[] {
  const statements: string[] = [];

  for (const user of FIXTURE_USERS) {
    statements.push(
      `INSERT INTO users (id, email, role, status, name, password_hash, created_at, updated_at) ` +
        `SELECT ${sqlStr(user.id)}, ${sqlStr(user.email)}, ${sqlStr(user.role)}, 'active', ${sqlStr(user.name)}, NULL, ${TS}, ${TS} ` +
        `WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ${sqlStr(user.email)})`,
    );
  }

  for (const profile of FIXTURE_SELLER_PROFILES) {
    statements.push(
      `INSERT INTO seller_profiles (id, user_id, slug, display_name, status, created_at, updated_at) ` +
        `SELECT ${sqlStr(profile.id)}, u.id, ${sqlStr(profile.slug)}, ${sqlStr(profile.displayName)}, ${sqlStr(profile.status)}, ${TS}, ${TS} ` +
        `FROM users u WHERE u.email = ${sqlStr(FIXTURE_USERS[1]!.email)} ` +
        `AND NOT EXISTS (SELECT 1 FROM seller_profiles WHERE slug = ${sqlStr(profile.slug)})`,
    );
  }

  for (const store of FIXTURE_STORES) {
    statements.push(
      `INSERT INTO stores (id, seller_profile_id, name, slug, description, status, created_at, updated_at) ` +
        `SELECT ${sqlStr(store.id)}, sp.id, ${sqlStr(store.name)}, ${sqlStr(store.slug)}, ${sqlStr(store.description)}, ${sqlStr(store.status)}, ${TS}, ${TS} ` +
        `FROM seller_profiles sp WHERE sp.slug = ${sqlStr(FIXTURE_SELLER_PROFILES[0]!.slug)} ` +
        `AND NOT EXISTS (SELECT 1 FROM stores WHERE slug = ${sqlStr(store.slug)})`,
    );
  }

  for (const category of FIXTURE_CATEGORIES) {
    statements.push(
      `INSERT INTO categories (id, parent_id, name, slug, status, created_at, updated_at) ` +
        `SELECT ${sqlStr(category.id)}, NULL, ${sqlStr(category.name)}, ${sqlStr(category.slug)}, ${sqlStr(category.status)}, ${TS}, ${TS} ` +
        `WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = ${sqlStr(category.slug)} AND parent_id IS NULL)`,
    );
  }

  for (const product of FIXTURE_PRODUCTS) {
    const category = FIXTURE_CATEGORIES.find((c) => c.id === product.categoryId)!;
    statements.push(
      `INSERT INTO products (id, store_id, category_id, name, slug, description, status, created_at, updated_at) ` +
        `SELECT ${sqlStr(product.id)}, st.id, ca.id, ${sqlStr(product.name)}, ${sqlStr(product.slug)}, ${sqlStr(product.description)}, ${sqlStr(product.status)}, ${TS}, ${TS} ` +
        `FROM stores st, categories ca ` +
        `WHERE st.slug = ${sqlStr(FIXTURE_STORES[0]!.slug)} AND ca.slug = ${sqlStr(category.slug)} AND ca.parent_id IS NULL ` +
        `AND NOT EXISTS (SELECT 1 FROM products WHERE store_id = st.id AND slug = ${sqlStr(product.slug)})`,
    );
  }

  for (const variant of FIXTURE_VARIANTS) {
    const product = FIXTURE_PRODUCTS.find((p) => p.id === variant.productId)!;
    statements.push(
      `INSERT INTO product_variants (id, product_id, sku, name, price_amount_cents, compare_at_amount_cents, currency, status, created_at, updated_at) ` +
        `SELECT ${sqlStr(variant.id)}, p.id, ${sqlStr(variant.sku)}, ${sqlStr(variant.name)}, ${variant.priceAmountCents}, ${variant.compareAtAmountCents}, ${sqlStr(variant.currency)}, ${sqlStr(variant.status)}, ${TS}, ${TS} ` +
        `FROM products p, stores st ` +
        `WHERE st.slug = ${sqlStr(FIXTURE_STORES[0]!.slug)} AND p.store_id = st.id AND p.slug = ${sqlStr(product.slug)} ` +
        `AND NOT EXISTS (SELECT 1 FROM product_variants WHERE sku = ${sqlStr(variant.sku)})`,
    );
  }

  for (const inventory of FIXTURE_INVENTORY) {
    const variant = FIXTURE_VARIANTS.find((v) => v.id === inventory.variantId)!;
    statements.push(
      `INSERT INTO inventory (variant_id, quantity, updated_at) ` +
        `SELECT v.id, ${inventory.quantity}, ${TS} ` +
        `FROM product_variants v, products p, stores st ` +
        `WHERE v.sku = ${sqlStr(variant.sku)} AND p.id = v.product_id AND st.id = p.store_id AND st.slug = ${sqlStr(FIXTURE_STORES[0]!.slug)} ` +
        `AND NOT EXISTS (SELECT 1 FROM inventory WHERE variant_id = v.id)`,
    );
  }

  for (const image of FIXTURE_IMAGES) {
    const product = FIXTURE_PRODUCTS.find((p) => p.id === image.productId)!;
    statements.push(
      `INSERT INTO product_images (id, product_id, url, alt_text, sort_order, is_primary, created_at) ` +
        `SELECT ${sqlStr(image.id)}, p.id, ${sqlStr(image.url)}, ${sqlStr(image.altText)}, 0, 1, ${TS} ` +
        `FROM products p, stores st ` +
        `WHERE st.slug = ${sqlStr(FIXTURE_STORES[0]!.slug)} AND p.store_id = st.id AND p.slug = ${sqlStr(product.slug)} ` +
        `AND NOT EXISTS (SELECT 1 FROM product_images WHERE product_id = p.id AND url = ${sqlStr(image.url)})`,
    );
  }

  for (const order of FIXTURE_ORDERS) {
    const variantIn = ORDER_VARIANT_IDS.map(sqlStr).join(", ");
    statements.push(
      `INSERT INTO orders (id, customer_user_id, idempotency_key, idempotency_fingerprint, status, currency, subtotal_amount_cents, shipping_amount_cents, discount_amount_cents, total_amount_cents, created_at, updated_at) ` +
        `SELECT ${sqlStr(order.id)}, u.id, ${sqlStr(order.idempotencyKey)}, ${sqlStr(order.idempotencyFingerprint)}, ${sqlStr(order.status)}, ${sqlStr(order.currency)}, ${order.subtotalAmountCents}, ${order.shippingAmountCents}, ${order.discountAmountCents}, ${order.totalAmountCents}, ${TS}, ${TS} ` +
        `FROM users u WHERE u.email = ${sqlStr(FIXTURE_USERS[0]!.email)} ` +
        `AND NOT EXISTS (SELECT 1 FROM order_items WHERE variant_id IN (${variantIn})) ` +
        `AND NOT EXISTS (SELECT 1 FROM orders WHERE id = ${sqlStr(order.id)})`,
    );
  }

  for (const address of FIXTURE_ORDER_ADDRESSES) {
    statements.push(
      `INSERT INTO order_addresses (id, order_id, kind, recipient_name, line1, city, country_code, created_at, updated_at) ` +
        `SELECT ${sqlStr(address.id)}, o.id, ${sqlStr(address.kind)}, ${sqlStr(address.recipientName)}, ${sqlStr(address.line1)}, ${sqlStr(address.city)}, ${sqlStr(address.countryCode)}, ${TS}, ${TS} ` +
        `FROM orders o WHERE o.id = ${sqlStr(FIXTURE_ORDERS[0]!.id)} ` +
        `AND NOT EXISTS (SELECT 1 FROM order_addresses WHERE order_id = o.id AND kind = ${sqlStr(address.kind)})`,
    );
  }

  for (const item of FIXTURE_ORDER_ITEMS) {
    const variant = FIXTURE_VARIANTS.find((v) => v.id === item.variantId)!;
    statements.push(
      `INSERT INTO order_items (id, order_id, variant_id, store_id, product_name, variant_name, sku, quantity, unit_amount_cents, line_total_amount_cents, currency, status, created_at, updated_at) ` +
        `SELECT ${sqlStr(item.id)}, o.id, v.id, st.id, ${sqlStr(item.productName)}, ${sqlStr(item.variantName)}, ${sqlStr(item.sku)}, ${item.quantity}, ${item.unitAmountCents}, ${item.lineTotalAmountCents}, ${sqlStr(item.currency)}, ${sqlStr(item.status)}, ${TS}, ${TS} ` +
        `FROM orders o, product_variants v, stores st, products p ` +
        `WHERE o.id = ${sqlStr(FIXTURE_ORDERS[0]!.id)} AND v.sku = ${sqlStr(variant.sku)} AND p.id = v.product_id AND st.id = p.store_id ` +
        `AND NOT EXISTS (SELECT 1 FROM order_items WHERE id = ${sqlStr(item.id)})`,
    );
  }

  return statements;
}

/**
 * Image URLs earlier fixture revisions wrote, keyed by product slug, oldest
 * generation first.
 *
 * `FIXTURE_IMAGES` only carries the current URL, so a database seeded from an
 * older revision still holds its image row under a legacy URL. Those rows are
 * the fixture's own — same deterministic id, same deterministic product id —
 * and cleanup must recognise them, otherwise they survive cleanup and a later
 * apply inserts a *second* image per product, two `is_primary` rows each.
 *
 * Each slug lists *every* prior generation, because a database can be at any
 * one of them: revision 1 wrote `example.test` (a reserved host that never
 * resolved in DNS), revision 2 wrote `placehold.co`, and revision 3 hardcoded
 * the deployed web Worker's production origin. The current generation is
 * whatever `ZELORA_SEED_IMAGE_BASE_URL` resolves to. `refresh-images` migrates
 * whichever generation it finds to the current one, and cleanup removes rows at
 * any generation. Generations are only ever appended — never edited or dropped —
 * so an already-migrated row stays recognisable.
 *
 * This is an explicit allowlist, never a host or prefix pattern: a row that
 * squats a fixture image id under any other URL is still left untouched, and
 * the post-cleanup preflight then reports the fixture keys as still present
 * (fail-closed) instead of quietly passing.
 */
const LEGACY_FIXTURE_IMAGE_URLS: Readonly<Record<string, readonly string[]>> = {
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

/**
 * Stale URLs this fixture wrote for `image` in an earlier revision and no
 * longer writes today, oldest first. Empty when the image's URL has never been
 * revised.
 *
 * `refresh-images` rewrites exactly this set, so a row that already carries the
 * current URL is never written at all (the UPDATE simply matches nothing). A
 * generation that has since been reinstated as the current URL is dropped here
 * rather than widening the guard to match both old and new.
 */
export function legacyFixtureImageUrls(image: FixtureImage): readonly string[] {
  const product = FIXTURE_PRODUCTS.find((candidate) => candidate.id === image.productId);
  if (!product) {
    throw new Error(`[dev-seed] fixture image ${image.id} references unknown product ${image.productId}.`);
  }
  const legacy = LEGACY_FIXTURE_IMAGE_URLS[product.slug];
  if (legacy === undefined) return [];
  return legacy.filter((url) => url !== image.url);
}

/**
 * Every URL this fixture has written for `image`, oldest first and the current
 * one last. Cleanup deletes on this set; nothing outside it is ever matched.
 */
export function fixtureImageUrls(image: FixtureImage): readonly string[] {
  return [...legacyFixtureImageUrls(image), image.url];
}

/**
 * The rows this tooling claims as the fixture's own images: each deterministic
 * image id paired with its deterministic product id.
 *
 * Shared by the preflight count and the cleanup DELETE so the two can never
 * disagree about which rows are the fixture's. Deliberately URL-agnostic —
 * recognising a stale-URL row as fixture-owned is what lets cleanup remove it
 * and lets a later apply re-insert it with the current URL.
 */
export function fixtureImageOwnershipPredicate(): string {
  const clauses = FIXTURE_IMAGES.map(
    (image) => `(id = ${sqlStr(image.id)} AND product_id = ${sqlStr(image.productId)})`,
  );
  if (clauses.length === 0) throw new Error("[dev-seed] fixture defines no images.");
  return clauses.join(" OR ");
}

/**
 * Read-only preflight: counts fixture-row presence by natural key plus the
 * total row count of every table involved (to detect foreign data), plus a
 * schema-existence check. Runs as a single SELECT so `wrangler d1 execute
 * --json` yields one row with predictable columns.
 */
export function buildPreflightStatement(): string {
  const usersEmails = FIXTURE_USERS.map((u) => sqlStr(u.email)).join(", ");
  const categorySlugs = FIXTURE_CATEGORIES.map((c) => sqlStr(c.slug)).join(", ");
  const storeSlug = sqlStr(FIXTURE_STORES[0]!.slug);
  const productSlugs = FIXTURE_PRODUCTS.map((p) => sqlStr(p.slug)).join(", ");
  const skus = FIXTURE_VARIANTS.map((v) => sqlStr(v.sku)).join(", ");
  const variantIds = FIXTURE_VARIANTS.map((v) => sqlStr(v.id)).join(", ");
  const orderId = sqlStr(FIXTURE_ORDERS[0]!.id);
  const orderVariantIn = ORDER_VARIANT_IDS.map(sqlStr).join(", ");

  return [
    "SELECT",
    `  (SELECT COUNT(*) FROM users WHERE email IN (${usersEmails})) AS users_fixture,`,
    `  (SELECT COUNT(*) FROM seller_profiles WHERE slug = ${sqlStr(FIXTURE_SELLER_PROFILES[0]!.slug)}) AS seller_profiles_fixture,`,
    `  (SELECT COUNT(*) FROM stores WHERE slug = ${storeSlug}) AS stores_fixture,`,
    `  (SELECT COUNT(*) FROM categories WHERE slug IN (${categorySlugs}) AND parent_id IS NULL) AS categories_fixture,`,
    `  (SELECT COUNT(*) FROM products WHERE store_id = ${sqlStr(FIXTURE_STORES[0]!.id)} AND slug IN (${productSlugs})) AS products_fixture,`,
    `  (SELECT COUNT(*) FROM product_variants WHERE sku IN (${skus})) AS product_variants_fixture,`,
    `  (SELECT COUNT(*) FROM inventory WHERE variant_id IN (${variantIds})) AS inventory_fixture,`,
    `  (SELECT COUNT(*) FROM product_images WHERE ${fixtureImageOwnershipPredicate()}) AS product_images_fixture,`,
    `  (SELECT COUNT(*) FROM orders WHERE id = ${orderId}) AS orders_fixture,`,
    `  (SELECT COUNT(*) FROM order_addresses WHERE order_id = ${orderId}) AS order_addresses_fixture,`,
    `  (SELECT COUNT(*) FROM order_items WHERE variant_id IN (${orderVariantIn})) AS order_items_fixture,`,
    "  (SELECT COUNT(*) FROM users) AS users_total,",
    "  (SELECT COUNT(*) FROM seller_profiles) AS seller_profiles_total,",
    "  (SELECT COUNT(*) FROM stores) AS stores_total,",
    "  (SELECT COUNT(*) FROM categories) AS categories_total,",
    "  (SELECT COUNT(*) FROM products) AS products_total,",
    "  (SELECT COUNT(*) FROM product_variants) AS product_variants_total,",
    "  (SELECT COUNT(*) FROM inventory) AS inventory_total,",
    "  (SELECT COUNT(*) FROM product_images) AS product_images_total,",
    "  (SELECT COUNT(*) FROM orders) AS orders_total,",
    "  (SELECT COUNT(*) FROM order_addresses) AS order_addresses_total,",
    "  (SELECT COUNT(*) FROM order_items) AS order_items_total,",
    `  (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(sqlStr).join(", ")})) AS tables_found`,
  ].join("\n");
}

/**
 * Expected fixture counts by preflight column, used both by `decidePreflight`
 * and the verification pass after an apply.
 */
export const EXPECTED_PREFLIGHT: Readonly<Record<string, number>> = {
  users_fixture: FIXTURE_USERS.length,
  seller_profiles_fixture: FIXTURE_SELLER_PROFILES.length,
  stores_fixture: FIXTURE_STORES.length,
  categories_fixture: FIXTURE_CATEGORIES.length,
  products_fixture: FIXTURE_PRODUCTS.length,
  product_variants_fixture: FIXTURE_VARIANTS.length,
  inventory_fixture: FIXTURE_INVENTORY.length,
  product_images_fixture: FIXTURE_IMAGES.length,
  orders_fixture: FIXTURE_ORDERS.length,
  order_addresses_fixture: FIXTURE_ORDER_ADDRESSES.length,
  order_items_fixture: FIXTURE_ORDER_ITEMS.length,
};

export interface PreflightState {
  /** Rows fully absent of fixture keys (or only foreign total data) — safe to apply. */
  ready: boolean;
  /** Fixture already fully present, matching the expected counts — no-op. */
  alreadySeeded: boolean;
  /** Some fixture keys present but not all — refuse to touch. */
  partial: boolean;
  /** One of the required tables is missing — apply migrations first. */
  tablesMissing: boolean;
  presentKeys: string[];
}

/** Interpret one preflight result row into an actionable state. */
export function decidePreflight(row: Record<string, number>): PreflightState {
  const tablesFound = Number(row.tables_found ?? 0);
  const presentKeys: string[] = [];
  let anyPresent = false;
  let allExpected = true;

  for (const [key, expected] of Object.entries(EXPECTED_PREFLIGHT)) {
    const found = Number(row[key] ?? 0);
    if (found > 0) {
      anyPresent = true;
      presentKeys.push(key);
    }
    if (found !== expected) {
      allExpected = false;
    }
  }

  return {
    ready: !anyPresent,
    alreadySeeded: anyPresent && allExpected,
    partial: anyPresent && !allExpected,
    tablesMissing: tablesFound < REQUIRED_TABLES.length,
    presentKeys,
  };
}

/**
 * Read-only verification after an apply: the fixture counts (must equal the
 * expected totals again) plus a storefront-surface query that proves the
 * seeded data is publicly visible through the exact joins the catalog repos
 * use (active store + active profile + active products, cheapest active
 * variant, primary image).
 */
export function buildStorefrontStatement(): string {
  return (
    `SELECT s.slug AS store, p.slug AS product, c.slug AS category, ` +
    `MIN(v.price_amount_cents) AS cheapest_cents, COUNT(v.id) AS active_variants ` +
    `FROM stores s ` +
    `JOIN seller_profiles sp ON sp.id = s.seller_profile_id ` +
    `JOIN products p ON p.store_id = s.id AND p.status = 'active' ` +
    `JOIN categories c ON c.id = p.category_id AND c.status = 'active' ` +
    `LEFT JOIN product_variants v ON v.product_id = p.id AND v.status = 'active' ` +
    `WHERE s.slug = ${sqlStr(FIXTURE_STORES[0]!.slug)} AND s.status = 'active' ` +
    `AND sp.status = 'active' ` +
    `GROUP BY s.id, p.id ORDER BY p.slug`
  );
}

/**
 * The two read-only statements `verify` runs, in order.
 *
 * They are executed as two separate statements rather than as one multi
 * statement `--file`: `wrangler d1 execute --file` collapses a file into a
 * single result entry holding aggregate stats (`Total queries executed`,
 * `Rows read`, ...) instead of per-statement rows, so a combined file can
 * never yield the preflight counts or the storefront rows.
 */
export function buildVerifyStatements(): readonly [string, string] {
  return [buildPreflightStatement(), buildStorefrontStatement()];
}

export function buildVerifyStatement(): string {
  return [buildPreflightStatement(), ";", buildStorefrontStatement()].join("\n");
}

/**
 * Cleanup: delete ONLY fixture rows, children first, each guarded by the
 * fixture's deterministic id AND a natural key, so real marketplace rows are
 * never touched. Run as a standalone opt-in file.
 *
 * `product_images` is the one table where the natural key has changed across
 * fixture revisions: the deterministic id + product id pin ownership, and the
 * `url IN (...)` allowlist (`fixtureImageUrls`) admits the current URL plus any
 * legacy URL, so a row seeded from an older fixture is still removed instead of
 * being stranded. The allowlist is closed — a fixture id carrying any other URL
 * is left alone and surfaces as a failed post-cleanup preflight.
 */
export function buildCleanupStatements(): string[] {
  const statements: string[] = [];

  for (const item of FIXTURE_ORDER_ITEMS) {
    statements.push(
      `DELETE FROM order_items WHERE id = ${sqlStr(item.id)} AND order_id = ${sqlStr(item.orderId)} AND variant_id = ${sqlStr(item.variantId)}`,
    );
  }
  for (const address of FIXTURE_ORDER_ADDRESSES) {
    statements.push(
      `DELETE FROM order_addresses WHERE id = ${sqlStr(address.id)} AND order_id = ${sqlStr(address.orderId)} AND kind = ${sqlStr(address.kind)}`,
    );
  }
  for (const order of FIXTURE_ORDERS) {
    statements.push(
      `DELETE FROM orders WHERE id = ${sqlStr(order.id)} AND customer_user_id = ${sqlStr(order.customerUserId)} AND total_amount_cents = ${order.totalAmountCents}`,
    );
  }
  for (const inventory of FIXTURE_INVENTORY) {
    statements.push(
      `DELETE FROM inventory WHERE variant_id = ${sqlStr(inventory.variantId)} AND quantity = ${inventory.quantity}`,
    );
  }
  for (const image of FIXTURE_IMAGES) {
    statements.push(
      `DELETE FROM product_images WHERE id = ${sqlStr(image.id)} AND product_id = ${sqlStr(image.productId)} ` +
        `AND url IN (${fixtureImageUrls(image).map(sqlStr).join(", ")})`,
    );
  }
  for (const variant of FIXTURE_VARIANTS) {
    statements.push(
      `DELETE FROM product_variants WHERE id = ${sqlStr(variant.id)} AND sku = ${sqlStr(variant.sku)} AND product_id = ${sqlStr(variant.productId)}`,
    );
  }
  for (const product of FIXTURE_PRODUCTS) {
    statements.push(
      `DELETE FROM products WHERE id = ${sqlStr(product.id)} AND store_id = ${sqlStr(product.storeId)} AND slug = ${sqlStr(product.slug)}`,
    );
  }
  for (const category of FIXTURE_CATEGORIES) {
    statements.push(
      `DELETE FROM categories WHERE id = ${sqlStr(category.id)} AND slug = ${sqlStr(category.slug)} AND parent_id IS NULL`,
    );
  }
  for (const store of FIXTURE_STORES) {
    statements.push(
      `DELETE FROM stores WHERE id = ${sqlStr(store.id)} AND slug = ${sqlStr(store.slug)} AND seller_profile_id = ${sqlStr(store.sellerProfileId)}`,
    );
  }
  for (const profile of FIXTURE_SELLER_PROFILES) {
    statements.push(
      `DELETE FROM seller_profiles WHERE id = ${sqlStr(profile.id)} AND slug = ${sqlStr(profile.slug)} AND user_id = ${sqlStr(profile.userId)}`,
    );
  }
  for (const user of FIXTURE_USERS) {
    statements.push(
      `DELETE FROM users WHERE id = ${sqlStr(user.id)} AND email = ${sqlStr(user.email)} AND role = ${sqlStr(user.role)}`,
    );
  }

  return statements;
}

/**
 * Targeted repair of the fixture's image rows: rewrite a stale fixture URL to
 * the current one, touching nothing else.
 *
 * This is the narrow alternative to a full `cleanup` + `apply` cycle. Cleanup
 * has to delete the fixture's products, and `product_images.product_id` is
 * `ON DELETE CASCADE`, so a full cycle is the wrong tool for a database that
 * also holds real sellers: it puts unrelated image rows at risk. This operation
 * leaves every other table — and every other column of `product_images` —
 * exactly as it found them.
 *
 * Each statement is guarded by all three ownership facts at once:
 *
 *   1. the exact deterministic image id,
 *   2. the exact deterministic product id, and
 *   3. a URL from `legacyFixtureImageUrls` — a stale URL this fixture wrote.
 *
 * Because the guard admits only stale URLs, a row that already carries the
 * current URL matches nothing and is never written: the operation is idempotent
 * by construction rather than by a follow-up check. A row with an unknown URL,
 * a foreign id, or a foreign product id is likewise never matched. Only `url` is
 * assigned; `alt_text`, `sort_order` and `is_primary` are left alone.
 */
export function buildRefreshImageStatements(): string[] {
  const statements: string[] = [];
  for (const image of FIXTURE_IMAGES) {
    const legacyUrls = legacyFixtureImageUrls(image);
    if (legacyUrls.length === 0) continue;
    statements.push(
      `UPDATE product_images SET url = ${sqlStr(image.url)} ` +
        `WHERE id = ${sqlStr(image.id)} AND product_id = ${sqlStr(image.productId)} ` +
        `AND url IN (${legacyUrls.map(sqlStr).join(", ")})`,
    );
  }
  return statements;
}

/**
 * Read-only per-image URL report for the fixture's deterministic image rows.
 *
 * The post-condition of `refresh-images` is "every fixture image row carries the
 * current URL", which a count cannot express: a single stale row and a fully
 * stale set both read as `4`. This returns one row per fixture image so each is
 * checked individually, before and after the write.
 */
export function buildImageUrlStatement(): string {
  return (
    `SELECT id, product_id, url FROM product_images ` +
    `WHERE ${fixtureImageOwnershipPredicate()} ORDER BY id`
  );
}

/** The URL `FIXTURE_IMAGES` writes today for `id`, or undefined if not a fixture image id. */
export function currentFixtureImageUrl(id: string): string | undefined {
  return FIXTURE_IMAGES.find((image) => image.id === id)?.url;
}

/**
 * A `product_images` row is up to date only when it is one of the fixture's own
 * image ids (the report query already filters to those) AND its URL is the one
 * the fixture writes today. An unknown id, or a null/absent URL, counts as
 * stale so it is reported rather than silently accepted.
 */
function isCurrentFixtureImageUrl(row: Record<string, unknown>): boolean {
  const expected = currentFixtureImageUrl(String(row.id));
  return expected !== undefined && row.url === expected;
}

/** Join statements into a single SQL file (each statement on its own line). */

export function toSqlFile(statements: readonly string[]): string {
  return `${statements.map((s) => `${s};`).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SEED_OUTPUT_DIR = new URL("../.data/seed/", import.meta.url);
const API_CONFIG_URL = new URL("../../../apps/api/wrangler.jsonc", import.meta.url);

interface WranglerD1Binding {
  binding: string;
  databaseName: string;
  databaseId: string;
}

/** Strip line and block comments from a JSONC file before JSON.parse. */
export function stripJsonComments(source: string): string {
  let stripped = "";
  let inString = false;
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];
    if (inString) {
      stripped += char;
      if (char === "\\") {
        stripped += next ?? "";
        i += 2;
      } else {
        if (char === '"') inString = false;
        i += 1;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stripped += char;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    stripped += char;
    i += 1;
  }
  return stripped;
}

/** Read a Wrangler binding for the DB (committed config by default) and validate its identity. */
export function loadApiBinding(configUrl: URL = API_CONFIG_URL): WranglerD1Binding {
  const configPath = configUrl;
  const source = readFileSync(configPath, "utf8");
  const config = JSON.parse(stripJsonComments(source)) as {
    d1_databases?: Array<{ binding?: string; database_name?: string; database_id?: string }>;
  };
  const db = config.d1_databases?.[0];
  if (db?.binding !== API_BINDING || db.database_name !== TARGET_DATABASE_NAME || db.database_id !== TARGET_DATABASE_ID) {
    throw new Error(
      `Refusing to seed: expected d1_databases[0] binding=${API_BINDING} name=${TARGET_DATABASE_NAME} id=${TARGET_DATABASE_ID}, ` +
        `found ${db?.binding}/${db?.database_name}/${db?.database_id}.`,
    );
  }
  return { binding: db.binding, databaseName: db.database_name, databaseId: db.database_id };
}

function writeSeedFiles(): string[] {
  const files = [
    writeSeedFile("apply.sql", toSqlFile(buildSeedStatements())),
    writeSeedFile("cleanup.sql", toSqlFile(buildCleanupStatements())),
    writeSeedFile("preflight.sql", buildPreflightStatement()),
    writeSeedFile("verify.sql", buildVerifyStatement()),
    writeSeedFile("refresh-images.sql", toSqlFile(buildRefreshImageStatements())),
  ];
  return files;
}

function writeSeedFile(name: string, contents: string): string {
  mkdirSync(SEED_OUTPUT_DIR, { recursive: true });
  const target = new URL(name, SEED_OUTPUT_DIR);
  writeFileSync(target, contents);
  return target.pathname;
}

interface WranglerResultEntry {
  results?: Array<Record<string, unknown>>;
  success?: boolean;
}

/**
 * Slice the JSON payload out of a `wrangler --json` stdout stream.
 *
 * Wrangler prints its progress/spinner rendering to **stdout** (not stderr) —
 * e.g. `├ Checking if file needs uploading` / `├ 🌀 Uploading <db>.<hash>.sql`
 * while it uploads a `--file` — so the stream cannot be parsed whole. Find the
 * array that opens a line and return just that span, discarding anything
 * printed before or after it.
 */
export function extractJsonArrayPayload(stdout: string): string {
  const start = stdout.search(/^[\t ]*\[/m);
  if (start === -1) {
    throw new Error(`Wrangler produced no JSON output:\n${stdout}`);
  }
  const from = stdout.indexOf("[", start);
  let depth = 0;
  let inString = false;
  for (let i = from; i < stdout.length; i += 1) {
    const char = stdout[i]!;
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return stdout.slice(from, i + 1);
    }
  }
  throw new Error(`Wrangler produced truncated JSON output:\n${stdout}`);
}

function parseWranglerEntries(stdout: string): WranglerResultEntry[] {
  const parsed = JSON.parse(extractJsonArrayPayload(stdout)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected wrangler JSON shape: ${JSON.stringify(parsed)}`);
  }
  return parsed as WranglerResultEntry[];
}

function resultRows(entries: readonly WranglerResultEntry[]): Array<Record<string, unknown>> {
  return entries.flatMap((entry) => entry.results ?? []);
}

/**
 * Fail closed when a preflight row is missing its count columns. An unexpected
 * result shape (e.g. the aggregate stats that `wrangler d1 execute --file`
 * reports instead of rows) would otherwise coerce every count to 0 and read as
 * "no fixture rows present" — a silent false negative on a safety-critical
 * decision.
 */
function assertPreflightColumns(row: Record<string, number>): void {
  const required = [
    ...Object.keys(EXPECTED_PREFLIGHT),
    ...REQUIRED_TABLES.map((table) => `${table}_total`),
    "tables_found",
  ];
  const missing = required.filter((column) => !(column in row));
  if (missing.length > 0) {
    throw new Error(
      `[dev-seed] preflight did not return the expected count columns (missing: ${missing.join(", ")}). ` +
        `Received: ${JSON.stringify(row)}. The query must run as a plain SELECT that returns the count columns.`,
    );
  }
}

export function parsePreflightRow(stdout: string): Record<string, number> {
  const row = resultRows(parseWranglerEntries(stdout))[0] ?? {};
  const counts = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)]),
  );
  assertPreflightColumns(counts);
  return counts;
}

/**
 * Run one read-only statement through `wrangler d1 execute --command` and
 * return its result rows. `--command` is used instead of `--file` on purpose:
 * it emits no progress rendering ahead of the `--json` payload and returns the
 * statement's rows, whereas `--file` prints spinner output to stdout and
 * collapses the file into one aggregate-stats entry.
 */
function runWranglerQuery(args: string[], sql: string, label: string): Array<Record<string, unknown>> {
  const result = runWrangler([...args, "--command", sql], { json: true });
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${result.stderr}\n${result.stdout}`);
  }
  const entries = parseWranglerEntries(result.stdout);
  const failed = entries.filter((entry) => entry.success === false);
  if (failed.length > 0) throw new Error(`${label} failed: ${JSON.stringify(failed)}`);
  return resultRows(entries);
}

function runWrangler(args: string[], opts: { json?: boolean } = {}): { stdout: string; stderr: string; status: number } {
  const bin = new URL("../../../node_modules/.bin/wrangler", import.meta.url).pathname;
  const fullArgs = ["--config", API_CONFIG_URL.pathname, ...args];
  if (opts.json) fullArgs.push("--json");
  const result = spawnSync(bin, fullArgs, { encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? -1 };
}

function printSummary(row: Record<string, number>): void {
  console.log(`  users=${row.users_total} seller_profiles=${row.seller_profiles_total} stores=${row.stores_total} ` +
    `categories=${row.categories_total} products=${row.products_total} variants=${row.product_variants_total} ` +
    `inventory=${row.inventory_total} images=${row.product_images_total} orders=${row.orders_total} ` +
    `addresses=${row.order_addresses_total} order_items=${row.order_items_total}`);
}

function remoteGate(database: string, yes: boolean): void {
  const binding = loadApiBinding();
  if (database !== TARGET_DATABASE_NAME || process.env.ZELORA_REMOTE_SEED_ALLOW !== "1") {
    throw new Error(
      `[dev-seed] remote apply refused: pass --database ${TARGET_DATABASE_NAME} and set ZELORA_REMOTE_SEED_ALLOW=1. ` +
        `Target binding verified: ${binding.binding}/${binding.databaseName}/${binding.databaseId}.`,
    );
  }
  if (!yes) {
    throw new Error(
      "[dev-seed] remote apply refused: confirm with --yes after reviewing the generated SQL and this database identity.",
    );
  }
}

/**
 * Refuse to write loopback image URLs into a *remote* database.
 *
 * The seeded image base is configuration now, and its default is the local Vite
 * server. That default is right for the local SQLite file and wrong for D1:
 * every `product_images.url` written under `http://localhost:5173` is
 * unresolvable for every browser that is not the machine that ran the seed, and
 * because the row looks structurally perfect, the breakage only shows up later
 * as a broken catalog image with no obvious cause. So the remote path demands an
 * explicit, reachable origin.
 *
 * `ZELORA_SEED_IMAGE_BASE_URL` is read once at fixture import, so a run that
 * sets it is the same run whose URLs are checked here — the two cannot disagree.
 */
export function assertRemoteSeedImageBaseUrlReachable(
  images: readonly FixtureImage[] = FIXTURE_IMAGES,
): void {
  const first = images[0];
  // No images means nothing to write, so there is no unreachable URL to refuse.
  if (first === undefined) return;
  // Derived from the rows themselves rather than from the environment, so the
  // check is against exactly the URLs that would be written even if a caller
  // passes a hand-built list.
  const base = new URL(first.url).origin;
  if (!isLoopbackSeedImageBaseUrl(base)) return;
  throw new Error(
    `[dev-seed] refusing to seed image URLs from a loopback origin into the remote database: ` +
      `images would resolve to ${base}, which only exists on the machine running the seed. ` +
      `Set ${SEED_IMAGE_BASE_URL_ENV_VAR} to the deployed web origin (the host serving ` +
      `/images/products/*.jpg) before applying remotely.`,
  );
}

export interface CliOptions {
  mode: "plan" | "apply" | "cleanup" | "verify" | "refresh-images";
  local: boolean;
  database: string;
  yes: boolean;
  /** Optional layout dir for local D1 writes, keeping CLI runs hermetic. */
  persistTo?: string;
}

function usage(): void {
  console.log(
    [
      "Remote D1 seed tool for the dev/test marketplace fixture.",
      "",
      "  pnpm db:seed:d1 [command] [--database zelora] [--local] [--persist-to <dir>] [--yes]",
      "",
      "Commands:",
      "  plan      generate apply/cleanup/preflight/verify SQL into .data/seed/ (default; no remote access)",
      "  apply     run preflight then apply the fixture to the target database (remote unless --local)",
      "  cleanup   delete ONLY the fixture rows from the target database (children first, id+key guarded)",
      "  verify    run the read-only preflight + storefront verification",
      "  refresh-images  rewrite ONLY stale fixture image URLs to the current ones (id + product id +",
      "                 legacy URL guarded; touches no other table and no other column)",
      "",
      "Options:",
      "  --database zelora   target database name (must match the committed binding)",
      "  --local             rehearse against a local D1 database instead of the remote one",
      "  --persist-to <dir>  with --local, keep the DB state in <dir> for hermetic runs",
      "  --yes               confirm an apply/cleanup after reviewing the generated SQL",
      "",
      "Remote safety gates: --database must equal the committed binding name (zelora),",
      "ZELORA_REMOTE_SEED_ALLOW=1 must be set, and --yes must be passed. The CLI never",
      "updates/deletes real marketplace rows: apply is insert-only and idempotent.",
    ].join("\n"),
  );
}

/**
 * Run the read-only preflight against a database and classify its state. A
 * "no such table" error is surfaced as the missing-migrations hint instead of
 * a raw D1 error, matching the preflight's `tablesMissing` branch (which can
 * only be reached when every required table already exists).
 */
function preflightOrThrow(
  dbArg: string[],
  locationArgs: string[],
): { row: Record<string, number>; state: PreflightState } {
  const result = runWrangler([...dbArg, ...locationArgs, "--command", buildPreflightStatement()], { json: true });
  if (result.status !== 0) {
    const output = `${result.stderr}\n${result.stdout}`;
    if (/no such table/i.test(output)) {
      throw new Error(
        `[dev-seed] target is missing required tables (preflight could not run: "no such table"). ` +
          `Apply the committed migrations first: wrangler d1 migrations apply zelora ${locationArgs[0]} --config apps/api/wrangler.jsonc`,
      );
    }
    throw new Error(`Preflight failed:\n${output}`);
  }
  const row = parsePreflightRow(result.stdout);
  return { row, state: decidePreflight(row) };
}

/** CLI entry, only active when this file is executed directly. */
function devCli(): void {
  const args = process.argv.slice(2);
  const modeArg = args.find(
    (a) => a === "plan" || a === "apply" || a === "cleanup" || a === "verify" || a === "refresh-images",
  );
  const mode: CliOptions["mode"] = (modeArg ?? "plan") as CliOptions["mode"];
  const local = args.includes("--local");
  const yes = args.includes("--yes");
  const databaseArg = args.find((_arg, i) => args[i - 1] === "--database");
  const database = databaseArg ?? TARGET_DATABASE_NAME;
  const persistToArg = args.find((_arg, i) => args[i - 1] === "--persist-to");
  const persistTo = persistToArg ?? undefined;

  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  try {
    if (mode === "plan") {
      const files = writeSeedFiles();
      console.log(`[dev-seed] generated remote fixture SQL into .data/seed/:`);
      for (const file of files) console.log(`  ${file}`);
      console.log("\nReview these files first. To apply against the live D1 database:");
      console.log(`  ZELORA_REMOTE_SEED_ALLOW=1 pnpm db:seed:d1 apply --database zelora --yes`);
      return;
    }

    const remote = !local;
    if (remote) {
      remoteGate(database, yes);
      assertRemoteSeedImageBaseUrlReachable();
    } else {
      if (database !== TARGET_DATABASE_NAME) {
        throw new Error(`[dev-seed] local rehearsal requires --database ${TARGET_DATABASE_NAME}.`);
      }
      loadApiBinding();
    }

    const location = local ? "--local" : "--remote";
    const locationArgs: string[] = persistTo && local ? ["--local", "--persist-to", persistTo] : [location];
    const dbArg = ["d1", "execute", database];

    if (mode === "verify") {
      const { row, state } = preflightOrThrow(dbArg, locationArgs);
      console.log(
        state.alreadySeeded
          ? "[dev-seed] verification: fixture fully present."
          : state.ready
            ? "[dev-seed] verification: no fixture rows present."
            : `[dev-seed] verification: fixture keys partially present (${state.presentKeys.join(", ")}) — expected the full fixture.`,
      );
      printSummary(row);
      const storefront = runWranglerQuery(
        [...dbArg, ...locationArgs],
        buildStorefrontStatement(),
        "Storefront verification",
      );
      console.log("\nStorefront surface (catalog joins, active rows only):");
      if (storefront.length === 0) console.log("  (no visible products)");
      for (const product of storefront) {
        console.log(
          `  ${product.store} / ${product.product} in ${product.category}: cheapest ${product.cheapest_cents}c, ${product.active_variants} active variant(s)`,
        );
      }
      return;
    }

    if (mode === "refresh-images") {
      const { state } = preflightOrThrow(dbArg, locationArgs);
      if (state.tablesMissing) {
        throw new Error(
          `[dev-seed] target is missing required tables (found preflight where tables_found < ${REQUIRED_TABLES.length}). ` +
            `Apply the committed migrations first: wrangler d1 migrations apply zelora ${location} --config apps/api/wrangler.jsonc`,
        );
      }

      // Read-only per-image report first, so exactly what would change is
      // visible before the write, and so "nothing to do" needs no write at all.
      const before = runWranglerQuery(
        [...dbArg, ...locationArgs],
        buildImageUrlStatement(),
        "Fixture image URL check",
      );
      const stale = before.filter((row) => !isCurrentFixtureImageUrl(row));
      if (stale.length === 0) {
        console.log(
          `[dev-seed] all ${before.length} fixture image row(s) already carry the current URL; nothing to refresh.`,
        );
        return;
      }
      console.log(`[dev-seed] ${stale.length} fixture image row(s) carry a stale URL:`);
      for (const row of stale) {
        console.log(`  ${row.id} (product ${row.product_id}): ${row.url} -> ${currentFixtureImageUrl(String(row.id))}`);
      }

      const file = writeSeedFile(`refresh-images-${Date.now()}.sql`, toSqlFile(buildRefreshImageStatements()));
      const result = runWrangler([...dbArg, ...locationArgs, "--file", file]);
      if (result.status !== 0) throw new Error(`Image refresh failed:\n${result.stderr}`);

      const after = runWranglerQuery(
        [...dbArg, ...locationArgs],
        buildImageUrlStatement(),
        "Fixture image URL check",
      );
      // Fail closed on both halves of the post-condition: every fixture image
      // row must exist, and each must carry the current URL. A row the guard
      // declined to touch (a foreign URL squatting a fixture id) leaves this
      // failing instead of being reported as a success.
      const stillStale = after.filter((row) => !isCurrentFixtureImageUrl(row));
      if (after.length !== FIXTURE_IMAGES.length || stillStale.length > 0) {
        throw new Error(
          `[dev-seed] post-refresh verification failed: expected ${FIXTURE_IMAGES.length} fixture image row(s) ` +
            `on the current URL, found ${after.length}; still stale: ${JSON.stringify(stillStale)}.`,
        );
      }
      console.log(`[dev-seed] refreshed ${stale.length} fixture image row(s) to the current URL; no other row changed.`);
      return;
    }

    const { row, state } = preflightOrThrow(dbArg, locationArgs);
    printSummary(row);
    if (state.tablesMissing) {
      throw new Error(
        `[dev-seed] target is missing required tables (found preflight where tables_found < ${REQUIRED_TABLES.length}). ` +
          `Apply the committed migrations first: wrangler d1 migrations apply zelora ${location} --config apps/api/wrangler.jsonc`,
      );
    }

    if (mode === "apply") {
      if (state.alreadySeeded) {
        console.log("[dev-seed] fixture already fully present; nothing to do.");
        return;
      }
      if (!state.ready) {
        throw new Error(
          `[dev-seed] refusing to apply: fixture keys are partially present (${state.presentKeys.join(", ")}). ` +
            `Inspect the database; run cleanup only after confirming those rows are the fixture's.`,
        );
      }
      const file = writeSeedFile(`apply-${Date.now()}.sql`, toSqlFile(buildSeedStatements()));
      const result = runWrangler([...dbArg, ...locationArgs, "--file", file]);
      if (result.status !== 0) throw new Error(`Apply failed:\n${result.stderr}`);
      const verified = preflightOrThrow(dbArg, locationArgs);
      if (!verified.state.alreadySeeded) {
        throw new Error(`[dev-seed] post-apply verification failed: ${JSON.stringify(verified.row)}`);
      }
      console.log("[dev-seed] applied fixture; verification matches the expected counts.");
      return;
    }

    if (mode === "cleanup") {
      if (state.ready) {
        console.log("[dev-seed] no fixture rows present; nothing to clean.");
        return;
      }
      const file = writeSeedFile(`cleanup-${Date.now()}.sql`, toSqlFile(buildCleanupStatements()));
      const result = runWrangler([...dbArg, ...locationArgs, "--file", file]);
      if (result.status !== 0) throw new Error(`Cleanup failed:\n${result.stderr}`);
      const verified = preflightOrThrow(dbArg, locationArgs);
      if (!verified.state.ready) {
        throw new Error(`[dev-seed] post-cleanup verification failed: ${JSON.stringify(verified.row)}`);
      }
      console.log("[dev-seed] fixture cleaned; verification shows no fixture keys remain.");
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

const isCliEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) {
  devCli();
}