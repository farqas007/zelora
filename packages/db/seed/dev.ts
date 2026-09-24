import { pathToFileURL } from "node:url";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createLocalClient, resolveDbPath, type LocalDatabase } from "../src/client";
import { migrateLocal } from "../src/migrate";
import * as schema from "../src/schema";

/**
 * DEVELOPMENT / TEST SEED DATA — never present in production.
 *
 * Idempotently populates a *local development* SQLite database with a small,
 * clearly fictional but realistic marketplace so the customer shopping
 * experience — public catalog, storefront, product detail — can be exercised
 * by hand and by tests. One approved test store ("Zelora Test Store") sells a
 * handful of products across three categories, each with priced variants,
 * inventory and a primary image, plus a single checkout spanning two of those
 * products so the order/address snapshot tables stay exercised.
 *
 * Every fixture row is looked up by its natural key (email, slug or SKU)
 * before it is inserted, so running the seed twice never creates duplicate
 * test data and it can safely be re-run against a database that already holds
 * real marketplace rows. It is NOT real marketplace data and must never be
 * presented as such. The CLI entry refuses to run when `NODE_ENV = production`.
 */

export interface SeedSummary {
  users: number;
  sellerProfiles: number;
  stores: number;
  categories: number;
  products: number;
  productVariants: number;
  productImages: number;
  orders: number;
  orderItems: number;
}

/** The fixture's expected row counts after a completed (idempotent) run. */
export const SEED_SUMMARY: SeedSummary = {
  users: 2,
  sellerProfiles: 1,
  stores: 1,
  categories: 3,
  products: 4,
  productVariants: 6,
  productImages: 4,
  orders: 1,
  orderItems: 2,
};

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

/** Insert the fictional dev fixture inside a single transaction. Idempotent. */
export function seedDev(db: LocalDatabase): SeedSummary {
  return db.transaction((tx) => {
    // Accounts: a test customer and the approved seller. Never a password hash.
    const customer = upsertUser(tx, {
      email: "dev-customer@example.test",
      role: "customer",
      name: "Dev Customer",
    });
    const seller = upsertUser(tx, {
      email: "dev-seller@example.test",
      role: "seller",
      name: "Zelora Test Seller",
    });

    // Approved seller profile (status `active`, mirrors a reviewed application)
    // and its store.
    const sellerProfile = upsertSellerProfile(tx, {
      userId: seller.id,
      slug: "zelora-test-seller",
      displayName: "Zelora Test Seller",
      status: "active",
    });
    const store = upsertStore(tx, {
      sellerProfileId: sellerProfile.id,
      name: "Zelora Test Store",
      slug: "zelora-test-store",
      status: "active",
      description:
        "A clearly fictional store used to test the Zelora shopping experience in development. Not a real marketplace seller.",
    });

    // Catalog tree: three root categories, four active products.
    const audio = upsertCategory(tx, { name: "Audio", slug: "audio", status: "active" });
    const gaming = upsertCategory(tx, { name: "Gaming", slug: "gaming", status: "active" });
    const home = upsertCategory(tx, { name: "Home & Living", slug: "home-living", status: "active" });

    const headphones = upsertProduct(tx, {
      storeId: store.id,
      categoryId: audio.id,
      name: "Wireless Headphones",
      slug: "wireless-headphones",
      status: "active",
      description: "Over-ear wireless headphones with active noise cancellation.",
    });
    const keyboard = upsertProduct(tx, {
      storeId: store.id,
      categoryId: gaming.id,
      name: "Gaming Keyboard",
      slug: "gaming-keyboard",
      status: "active",
      description: "Mechanical gaming keyboard with per-key RGB backlighting.",
    });
    const mouse = upsertProduct(tx, {
      storeId: store.id,
      categoryId: gaming.id,
      name: "Gaming Mouse",
      slug: "gaming-mouse",
      status: "active",
      description: "Precision optical gaming mouse with adjustable DPI.",
    });
    const lamp = upsertProduct(tx, {
      storeId: store.id,
      categoryId: home.id,
      name: "LED Desk Lamp",
      slug: "led-desk-lamp",
      status: "active",
      description: "Adjustable LED desk lamp with warm-white and daylight modes.",
    });

    // Sellable variants (SKU is the idempotency key, price in integer cents).
    const headphonesBlack = upsertVariant(tx, {
      productId: headphones.id,
      sku: "DEV-WH-BLK",
      name: "Matte Black",
      priceAmountCents: 129_99,
      compareAtAmountCents: 159_99,
      currency: "USD",
      status: "active",
    });
    const headphonesCream = upsertVariant(tx, {
      productId: headphones.id,
      sku: "DEV-WH-CRM",
      name: "Cream",
      priceAmountCents: 129_99,
      compareAtAmountCents: 159_99,
      currency: "USD",
      status: "active",
    });
    const keyboardTactile = upsertVariant(tx, {
      productId: keyboard.id,
      sku: "DEV-GK-TCT",
      name: "Tactile switches",
      priceAmountCents: 89_99,
      currency: "USD",
      status: "active",
    });
    const keyboardLinear = upsertVariant(tx, {
      productId: keyboard.id,
      sku: "DEV-GK-LIN",
      name: "Linear switches",
      priceAmountCents: 89_99,
      currency: "USD",
      status: "active",
    });
    const mouseWired = upsertVariant(tx, {
      productId: mouse.id,
      sku: "DEV-GM-RGB",
      name: "Wired RGB",
      priceAmountCents: 49_99,
      currency: "USD",
      status: "active",
    });
    const lampAdjustable = upsertVariant(tx, {
      productId: lamp.id,
      sku: "DEV-LD-ADJ",
      name: "Adjustable white",
      priceAmountCents: 39_99,
      currency: "USD",
      status: "active",
    });

    upsertInventory(tx, { variantId: headphonesBlack.id, quantity: 25 });
    upsertInventory(tx, { variantId: headphonesCream.id, quantity: 25 });
    upsertInventory(tx, { variantId: keyboardTactile.id, quantity: 20 });
    upsertInventory(tx, { variantId: keyboardLinear.id, quantity: 20 });
    upsertInventory(tx, { variantId: mouseWired.id, quantity: 50 });
    upsertInventory(tx, { variantId: lampAdjustable.id, quantity: 30 });

    // One primary image per product.
    upsertPrimaryImage(tx, {
      productId: headphones.id,
      url: "https://example.test/wireless-headphones.jpg",
      altText: "Wireless Headphones",
    });
    upsertPrimaryImage(tx, {
      productId: keyboard.id,
      url: "https://example.test/gaming-keyboard.jpg",
      altText: "Gaming Keyboard",
    });
    upsertPrimaryImage(tx, {
      productId: mouse.id,
      url: "https://example.test/gaming-mouse.jpg",
      altText: "Gaming Mouse",
    });
    upsertPrimaryImage(tx, {
      productId: lamp.id,
      url: "https://example.test/led-desk-lamp.jpg",
      altText: "LED Desk Lamp",
    });

    // One checkout exercising the order/address snapshot tables. Created only
    // when no existing order references any of the fixture variants.
    upsertFixtureOrder(tx, customer.id, store.id, headphonesBlack, mouseWired);

    return { ...SEED_SUMMARY };
  });
}

function upsertUser(
  tx: LocalDatabase,
  values: typeof schema.users.$inferInsert,
): typeof schema.users.$inferSelect {
  const existing = tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, values.email!))
    .get();
  return existing !== undefined
    ? existing
    : tx.insert(schema.users).values(values).returning().get();
}

function upsertSellerProfile(
  tx: LocalDatabase,
  values: typeof schema.sellerProfiles.$inferInsert,
): typeof schema.sellerProfiles.$inferSelect {
  const existing = tx
    .select()
    .from(schema.sellerProfiles)
    .where(eq(schema.sellerProfiles.userId, values.userId!))
    .get();
  return existing !== undefined
    ? existing
    : tx.insert(schema.sellerProfiles).values(values).returning().get();
}

function upsertStore(
  tx: LocalDatabase,
  values: typeof schema.stores.$inferInsert,
): typeof schema.stores.$inferSelect {
  const existing = tx
    .select()
    .from(schema.stores)
    .where(eq(schema.stores.slug, values.slug!))
    .get();
  return existing !== undefined
    ? existing
    : tx.insert(schema.stores).values(values).returning().get();
}

/** Root categories only: the fixture has no children, and the partial unique
 * index enforces one slug per root level. */
function upsertCategory(
  tx: LocalDatabase,
  values: typeof schema.categories.$inferInsert,
): typeof schema.categories.$inferSelect {
  const existing = tx
    .select()
    .from(schema.categories)
    .where(and(eq(schema.categories.slug, values.slug!), isNull(schema.categories.parentId)))
    .get();
  return existing !== undefined
    ? existing
    : tx.insert(schema.categories).values(values).returning().get();
}

function upsertProduct(
  tx: LocalDatabase,
  values: typeof schema.products.$inferInsert,
): typeof schema.products.$inferSelect {
  const existing = tx
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.storeId, values.storeId!), eq(schema.products.slug, values.slug!)))
    .get();
  return existing !== undefined
    ? existing
    : tx.insert(schema.products).values(values).returning().get();
}

function upsertVariant(
  tx: LocalDatabase,
  values: typeof schema.productVariants.$inferInsert,
): typeof schema.productVariants.$inferSelect {
  const existing =
    values.sku == null
      ? undefined
      : tx
          .select()
          .from(schema.productVariants)
          .where(eq(schema.productVariants.sku, values.sku))
          .get();
  return existing !== undefined
    ? existing
    : tx.insert(schema.productVariants).values(values).returning().get();
}

function upsertInventory(
  tx: LocalDatabase,
  values: typeof schema.inventory.$inferInsert,
): void {
  const existing = tx
    .select()
    .from(schema.inventory)
    .where(eq(schema.inventory.variantId, values.variantId!))
    .get();
  if (existing === undefined) {
    tx.insert(schema.inventory).values(values).run();
  }
}

function upsertPrimaryImage(
  tx: LocalDatabase,
  values: typeof schema.productImages.$inferInsert,
): void {
  const existing = tx
    .select()
    .from(schema.productImages)
    .where(
      and(
        eq(schema.productImages.productId, values.productId!),
        eq(schema.productImages.url, values.url!),
      ),
    )
    .get();
  if (existing === undefined) {
    tx.insert(schema.productImages).values({ ...values, isPrimary: 1, sortOrder: 0 }).run();
  }
}

/** Create the fixture order once — only when no order references a fixture variant. */
function upsertFixtureOrder(
  tx: LocalDatabase,
  customerUserId: string,
  storeId: string,
  headphonesVariant: typeof schema.productVariants.$inferSelect,
  mouseVariant: typeof schema.productVariants.$inferSelect,
): void {
  const existing = tx
    .select({ id: schema.orderItems.id })
    .from(schema.orderItems)
    .where(inArray(schema.orderItems.variantId, [headphonesVariant.id, mouseVariant.id]))
    .limit(1)
    .all();
  if (existing.length > 0) {
    return;
  }

  const order = tx
    .insert(schema.orders)
    .values({
      customerUserId,
      status: "confirmed",
      currency: "USD",
      subtotalAmountCents: 179_98,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: 179_98,
    })
    .returning()
    .get();

  tx.insert(schema.orderAddresses)
    .values([
      {
        orderId: order.id,
        kind: "shipping",
        recipientName: "Dev Customer",
        line1: "1 Dev Lane",
        city: "Testville",
        countryCode: "US",
      },
      {
        orderId: order.id,
        kind: "billing",
        recipientName: "Dev Customer",
        line1: "1 Dev Lane",
        city: "Testville",
        countryCode: "US",
      },
    ])
    .run();

  tx.insert(schema.orderItems)
    .values([
      {
        orderId: order.id,
        variantId: headphonesVariant.id,
        storeId,
        productName: "Wireless Headphones",
        variantName: headphonesVariant.name,
        sku: headphonesVariant.sku,
        quantity: 1,
        unitAmountCents: 129_99,
        lineTotalAmountCents: 129_99,
        currency: "USD",
        status: "confirmed",
      },
      {
        orderId: order.id,
        variantId: mouseVariant.id,
        storeId,
        productName: "Gaming Mouse",
        variantName: mouseVariant.name,
        sku: mouseVariant.sku,
        quantity: 1,
        unitAmountCents: 49_99,
        lineTotalAmountCents: 49_99,
        currency: "USD",
        status: "confirmed",
      },
    ])
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