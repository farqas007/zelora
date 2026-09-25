import { pathToFileURL } from "node:url";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createLocalClient, resolveDbPath, type LocalDatabase } from "../src/client";
import { migrateLocal } from "../src/migrate";
import * as schema from "../src/schema";
import {
  type FixtureVariant,
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
  FIXTURE_ORDER_VARIANT_SKUS,
  SEED_SUMMARY,
  type SeedSummary,
} from "./fixture";

export { SEED_SUMMARY, type SeedSummary } from "./fixture";

/**
 * DEVELOPMENT / TEST SEED DATA — never present in production.
 *
 * Idempotently populates a *local development* SQLite database with the shared
 * fixture (`./fixture.ts`), a small, clearly fictional but realistic
 * marketplace so the customer shopping experience — public catalog,
 * storefront, product detail — can be exercised by hand and by tests. One
 * approved test store ("Zelora Test Store") sells a handful of products across
 * three categories, each with priced variants, inventory and a primary image,
 * plus a single checkout spanning two of those products so the order/address
 * snapshot tables stay exercised.
 *
 * Every fixture row is looked up by its natural key (email, slug or SKU)
 * before it is inserted, so running the seed twice never creates duplicate
 * test data and it can safely be re-run against a database that already holds
 * real marketplace rows. The fixture is shared with the remote D1 SQL
 * generator (`./d1.ts`), so both paths can never drift. It is NOT real
 * marketplace data and must never be presented as such. The CLI entry refuses
 * to run when `NODE_ENV = production`.
 */

const TS = FIXTURE_CREATED_AT_MS;
const SEED_AT = new Date(TS);

/**
 * Refuse to load dev/test fixture data when the runtime reports `production`.
 * Surfaced as a plain error so both the CLI (which exits non-zero) and tests
 * share the same guard.
 */
export function assertSeedAllowed(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "[dev-seed] refusing to run with NODE_ENV=production: dev/test seed data must never reach production.",
    );
  }
}

/**
 * Insert the fictional dev fixture inside a single transaction. Idempotent.
 *
 * New rows always keep the fixture's deterministic ids (so local SQLite rows
 * are byte-identical to the remote D1 generator's), but every parent foreign
 * key is resolved from the database by its natural key first — exactly like
 * the pre-fixture seed did — so a pre-existing real row that already claims a
 * fixture natural key is adopted instead of crashing on a dangling key or
 * silently writing children under an unrelated id.
 */
export function seedDev(db: LocalDatabase): SeedSummary {
  return db.transaction((tx) => {
    // Accounts: a test customer and the approved seller. Never a password hash.
    const customer = upsertUser(tx, FIXTURE_USERS[0]!);
    const seller = upsertUser(tx, FIXTURE_USERS[1]!);

    // Approved seller profile (status `active`, mirrors a reviewed application)
    // and its store.
    const sellerProfile = upsertSellerProfile(tx, seller.id, FIXTURE_SELLER_PROFILES[0]!);
    const store = upsertStore(tx, sellerProfile.id, FIXTURE_STORES[0]!);

    // Catalog tree: three root categories, four active products.
    const categoryById = new Map<string, typeof schema.categories.$inferSelect>(
      FIXTURE_CATEGORIES.map((category) => [category.id, upsertCategory(tx, category)]),
    );
    const productById = new Map<string, typeof schema.products.$inferSelect>(
      FIXTURE_PRODUCTS.map((product) => {
        const category = categoryById.get(product.categoryId);
        if (category === undefined) {
          throw new Error(`[dev-seed] missing fixture category for product ${product.slug}`);
        }
        return [product.id, upsertProduct(tx, store.id, category.id, product)];
      }),
    );

    // Sellable variants (SKU is the idempotency key, price in integer cents).
    const variantById = upsertVariant(tx, productById, FIXTURE_VARIANTS);

    // Per-variant stock.
    for (const inventory of FIXTURE_INVENTORY) {
      const variant = variantById.get(inventory.variantId);
      if (variant === undefined) {
        throw new Error(`[dev-seed] missing fixture variant for inventory row ${inventory.variantId}`);
      }
      upsertInventory(tx, variant.id, inventory);
    }

    // One primary image per product.
    for (const image of FIXTURE_IMAGES) {
      const product = productById.get(image.productId);
      if (product === undefined) {
        throw new Error(`[dev-seed] missing fixture product for image ${image.url}`);
      }
      upsertPrimaryImage(tx, product.id, image);
    }

    // One checkout exercising the order/address snapshot tables. Created only
    // when no existing order references any of the fixture variants.
    const orderVariants = FIXTURE_ORDER_VARIANT_SKUS
      .map((sku) => FIXTURE_VARIANTS.find((v) => v.sku === sku))
      .filter((variant): variant is FixtureVariant => variant !== undefined);
    upsertFixtureOrder(tx, customer, store.id, orderVariants);

    return { ...SEED_SUMMARY };
  });
}

function upsertUser(
  tx: LocalDatabase,
  fixture: (typeof FIXTURE_USERS)[number],
): typeof schema.users.$inferSelect {
  const existing = tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, fixture.email))
    .get();
  return existing !== undefined
    ? existing
    : tx
        .insert(schema.users)
        .values({
          id: fixture.id,
          email: fixture.email,
          role: fixture.role,
          name: fixture.name,
          createdAt: SEED_AT,
          updatedAt: SEED_AT,
        })
        .returning()
        .get();
}

function upsertSellerProfile(
  tx: LocalDatabase,
  userId: string,
  fixture: (typeof FIXTURE_SELLER_PROFILES)[number],
): typeof schema.sellerProfiles.$inferSelect {
  const existing = tx
    .select()
    .from(schema.sellerProfiles)
    .where(eq(schema.sellerProfiles.userId, userId))
    .get();
  return existing !== undefined
    ? existing
    : tx
        .insert(schema.sellerProfiles)
        .values({
          id: fixture.id,
          userId,
          slug: fixture.slug,
          displayName: fixture.displayName,
          status: fixture.status,
          createdAt: SEED_AT,
          updatedAt: SEED_AT,
        })
        .returning()
        .get();
}

function upsertStore(
  tx: LocalDatabase,
  sellerProfileId: string,
  fixture: (typeof FIXTURE_STORES)[number],
): typeof schema.stores.$inferSelect {
  const existing = tx
    .select()
    .from(schema.stores)
    .where(eq(schema.stores.slug, fixture.slug))
    .get();
  return existing !== undefined
    ? existing
    : tx
        .insert(schema.stores)
        .values({
          id: fixture.id,
          sellerProfileId,
          name: fixture.name,
          slug: fixture.slug,
          description: fixture.description,
          status: fixture.status,
          createdAt: SEED_AT,
          updatedAt: SEED_AT,
        })
        .returning()
        .get();
}

/** Root categories only: the fixture has no children, and the partial unique
 * index enforces one slug per root level. */
function upsertCategory(
  tx: LocalDatabase,
  fixture: (typeof FIXTURE_CATEGORIES)[number],
): typeof schema.categories.$inferSelect {
  const existing = tx
    .select()
    .from(schema.categories)
    .where(and(eq(schema.categories.slug, fixture.slug), isNull(schema.categories.parentId)))
    .get();
  return existing !== undefined
    ? existing
    : tx
        .insert(schema.categories)
        .values({
          id: fixture.id,
          name: fixture.name,
          slug: fixture.slug,
          status: fixture.status,
          createdAt: SEED_AT,
          updatedAt: SEED_AT,
        })
        .returning()
        .get();
}

function upsertProduct(
  tx: LocalDatabase,
  storeId: string,
  categoryId: string,
  fixture: (typeof FIXTURE_PRODUCTS)[number],
): typeof schema.products.$inferSelect {
  const existing = tx
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.storeId, storeId), eq(schema.products.slug, fixture.slug)))
    .get();
  return existing !== undefined
    ? existing
    : tx
        .insert(schema.products)
        .values({
          id: fixture.id,
          storeId,
          categoryId,
          name: fixture.name,
          slug: fixture.slug,
          description: fixture.description,
          status: fixture.status,
          createdAt: SEED_AT,
          updatedAt: SEED_AT,
        })
        .returning()
        .get();
}

function upsertVariant(
  tx: LocalDatabase,
  productById: Map<string, typeof schema.products.$inferSelect>,
  fixtures: readonly FixtureVariant[],
): Map<string, typeof schema.productVariants.$inferSelect> {
  const resolved = new Map<string, typeof schema.productVariants.$inferSelect>();
  for (const fixture of fixtures) {
    const existing = tx
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.sku, fixture.sku))
      .get();
    if (existing !== undefined) {
      resolved.set(fixture.id, existing);
      continue;
    }
    const product = productById.get(fixture.productId);
    if (product === undefined) {
      throw new Error(`[dev-seed] missing fixture product for variant ${fixture.sku}`);
    }
    resolved.set(
      fixture.id,
      tx
        .insert(schema.productVariants)
        .values({
          id: fixture.id,
          productId: product.id,
          sku: fixture.sku,
          name: fixture.name,
          priceAmountCents: fixture.priceAmountCents,
          compareAtAmountCents: fixture.compareAtAmountCents,
          currency: fixture.currency,
          status: fixture.status,
          createdAt: SEED_AT,
          updatedAt: SEED_AT,
        })
        .returning()
        .get(),
    );
  }
  return resolved;
}

function upsertInventory(
  tx: LocalDatabase,
  variantId: string,
  fixture: (typeof FIXTURE_INVENTORY)[number],
): void {
  const existing = tx
    .select()
    .from(schema.inventory)
    .where(eq(schema.inventory.variantId, variantId))
    .get();
  if (existing === undefined) {
    tx.insert(schema.inventory)
      .values({ variantId, quantity: fixture.quantity, updatedAt: SEED_AT })
      .run();
  }
}

function upsertPrimaryImage(
  tx: LocalDatabase,
  productId: string,
  fixture: (typeof FIXTURE_IMAGES)[number],
): void {
  // A product may carry at most one primary image (partial unique index), so a
  // real marketplace product that already owns its primary image is adopted as
  // is — the seed never overwrites it or adds a second primary row.
  const existingPrimary = tx
    .select()
    .from(schema.productImages)
    .where(
      and(
        eq(schema.productImages.productId, productId),
        eq(schema.productImages.isPrimary, 1),
      ),
    )
    .get();
  if (existingPrimary !== undefined) {
    return;
  }

  // No primary image yet: adopt the fixture image only if it is not already
  // present (idempotency), so a re-run never duplicates the row.
  const existing = tx
    .select()
    .from(schema.productImages)
    .where(
      and(
        eq(schema.productImages.productId, productId),
        eq(schema.productImages.url, fixture.url),
      ),
    )
    .get();
  if (existing === undefined) {
    tx.insert(schema.productImages)
      .values({
        id: fixture.id,
        productId,
        url: fixture.url,
        altText: fixture.altText,
        isPrimary: 1,
        sortOrder: 0,
        createdAt: SEED_AT,
      })
      .run();
  }
}

/** Create the fixture order once — only when no order references a fixture variant. */
function upsertFixtureOrder(
  tx: LocalDatabase,
  customer: typeof schema.users.$inferSelect,
  storeId: string,
  orderVariants: readonly FixtureVariant[],
): void {
  const existing = tx
    .select({ id: schema.orderItems.id })
    .from(schema.orderItems)
    .where(inArray(schema.orderItems.variantId, orderVariants.map((v) => v.id)))
    .limit(1)
    .all();
  if (existing.length > 0) {
    return;
  }

  const order = tx
    .insert(schema.orders)
    .values({
      id: FIXTURE_ORDERS[0]!.id,
      customerUserId: customer.id,
      status: FIXTURE_ORDERS[0]!.status,
      currency: FIXTURE_ORDERS[0]!.currency,
      subtotalAmountCents: FIXTURE_ORDERS[0]!.subtotalAmountCents,
      shippingAmountCents: FIXTURE_ORDERS[0]!.shippingAmountCents,
      discountAmountCents: FIXTURE_ORDERS[0]!.discountAmountCents,
      totalAmountCents: FIXTURE_ORDERS[0]!.totalAmountCents,
      createdAt: SEED_AT,
      updatedAt: SEED_AT,
    })
    .returning()
    .get();

  tx.insert(schema.orderAddresses)
    .values(
      FIXTURE_ORDER_ADDRESSES.map((address) => ({
        id: address.id,
        orderId: order.id,
        kind: address.kind,
        recipientName: address.recipientName,
        line1: address.line1,
        city: address.city,
        countryCode: address.countryCode,
        createdAt: SEED_AT,
        updatedAt: SEED_AT,
      })),
    )
    .run();

  tx.insert(schema.orderItems)
    .values(
      FIXTURE_ORDER_ITEMS.map((item) => ({
        id: item.id,
        orderId: order.id,
        variantId: item.variantId,
        storeId,
        productName: item.productName,
        variantName: item.variantName,
        sku: item.sku,
        quantity: item.quantity,
        unitAmountCents: item.unitAmountCents,
        lineTotalAmountCents: item.lineTotalAmountCents,
        currency: item.currency,
        status: item.status,
        createdAt: SEED_AT,
        updatedAt: SEED_AT,
      })),
    )
    .run();
}

/** CLI entry, used by `pnpm db:seed`. Never runs against production. */
function devCli(): void {
  try {
    assertSeedAllowed();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  const { db } = createLocalClient(resolveDbPath());
  migrateLocal(db);
  const summary = seedDev(db);
  console.log(`[dev-seed] loaded dev/test fixture: ${JSON.stringify(summary)}`);
}

const isCliEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) {
  devCli();
}