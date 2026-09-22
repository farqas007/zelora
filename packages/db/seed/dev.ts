import { pathToFileURL } from "node:url";
import { createLocalClient, resolveDbPath, type LocalDatabase } from "../src/client";
import { migrateLocal } from "../src/migrate";
import * as schema from "../src/schema";

/**
 * DEVELOPMENT / TEST SEED DATA — never present in production.
 *
 * Populates a *local development* SQLite database with a small, clearly
 * fictional multi-vendor fixture so the schema (multi-store orders, address
 * snapshots, per-line status, partial unique indexes) can be exercised by hand
 * and by tests. It is NOT real marketplace data and must never be presented as
 * such. The CLI entry refuses to run when `NODE_ENV = production`.
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

/**
 * Insert the fictional dev fixture inside a single transaction. Refuses to
 * run against a non-empty database so it can never corrupt existing rows.
 */
export function seedDev(db: LocalDatabase): SeedSummary {
  const existing = db.select({ id: schema.users.id }).from(schema.users).limit(1).all();
  if (existing.length > 0) {
    throw new Error(
      "dev seed refused: database is not empty. Use a fresh database (e.g. remove .data/zelora.db).",
    );
  }

  return db.transaction((tx) => {
    // Users
    const [customerUserId, sellerAUserId, sellerBUserId] = tx
      .insert(schema.users)
      .values([
        { email: "dev-customer@example.test", name: "Dev Customer" },
        { email: "dev-seller-a@example.test", role: "seller", name: "Dev Seller A" },
        { email: "dev-seller-b@example.test", role: "seller", name: "Dev Seller B" },
      ])
      .returning({ id: schema.users.id })
      .all()
      .map((row) => row.id) as [string, string, string];

    // Seller profiles + stores
    const [profileAId, profileBId] = tx
      .insert(schema.sellerProfiles)
      .values([
        { userId: sellerAUserId, slug: "dev-seller-a", displayName: "Dev Seller A", status: "active" },
        { userId: sellerBUserId, slug: "dev-seller-b", displayName: "Dev Seller B", status: "active" },
      ])
      .returning({ id: schema.sellerProfiles.id })
      .all()
      .map((row) => row.id) as [string, string];

    const [storeAId, storeBId] = tx
      .insert(schema.stores)
      .values([
        { sellerProfileId: profileAId, name: "Dev Store A", slug: "dev-store-a", status: "active" },
        { sellerProfileId: profileBId, name: "Dev Store B", slug: "dev-store-b", status: "active" },
      ])
      .returning({ id: schema.stores.id })
      .all()
      .map((row) => row.id) as [string, string];

    // Catalog: one category, one product per store, one variant each
    const categoryId = tx
      .insert(schema.categories)
      .values({ name: "Photography", slug: "photography", status: "active" })
      .returning({ id: schema.categories.id })
      .get().id;

    const [cameraProductId, lensProductId] = tx
      .insert(schema.products)
      .values([
        { storeId: storeAId, categoryId, name: "Dev Camera", slug: "dev-camera", status: "active" },
        { storeId: storeBId, categoryId, name: "Dev Lens", slug: "dev-lens", status: "active" },
      ])
      .returning({ id: schema.products.id })
      .all()
      .map((row) => row.id) as [string, string];

    const [cameraVariantId, lensVariantId] = tx
      .insert(schema.productVariants)
      .values([
        {
          productId: cameraProductId,
          sku: "DEV-CAM-BODY",
          name: "Body only",
          priceAmountCents: 59_999,
          currency: "USD",
          status: "active",
        },
        {
          productId: lensProductId,
          sku: "DEV-LEN-50MM",
          name: "50mm prime",
          priceAmountCents: 24_999,
          currency: "USD",
          status: "active",
        },
      ])
      .returning({ id: schema.productVariants.id })
      .all()
      .map((row) => row.id) as [string, string];

    tx.insert(schema.inventory).values([
      { variantId: cameraVariantId, quantity: 10 },
      { variantId: lensVariantId, quantity: 5 },
    ]).run();

    // One primary image per product (partial unique index at work)
    tx.insert(schema.productImages).values([
      { productId: cameraProductId, url: "https://example.test/dev-camera.jpg", altText: "Dev Camera", isPrimary: 1 },
      { productId: lensProductId, url: "https://example.test/dev-lens.jpg", altText: "Dev Lens", isPrimary: 1 },
    ]).run();

    // One order containing lines from BOTH stores (multi-vendor checkout)
    const order = tx
      .insert(schema.orders)
      .values({
        customerUserId,
        status: "confirmed",
        subtotalAmountCents: 84_998,
        totalAmountCents: 84_998,
        currency: "USD",
      })
      .returning({ id: schema.orders.id })
      .get();

    tx.insert(schema.orderAddresses).values([
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
    ]).run();

    tx.insert(schema.orderItems).values([
      {
        orderId: order.id,
        variantId: cameraVariantId,
        storeId: storeAId,
        productName: "Dev Camera",
        variantName: "Body only",
        sku: "DEV-CAM-BODY",
        quantity: 1,
        unitAmountCents: 59_999,
        lineTotalAmountCents: 59_999,
        currency: "USD",
      },
      {
        orderId: order.id,
        variantId: lensVariantId,
        storeId: storeBId,
        productName: "Dev Lens",
        variantName: "50mm prime",
        sku: "DEV-LEN-50MM",
        quantity: 1,
        unitAmountCents: 24_999,
        lineTotalAmountCents: 24_999,
        currency: "USD",
      },
    ]).run();

    return {
      users: 3,
      sellerProfiles: 2,
      stores: 2,
      categories: 1,
      products: 2,
      productVariants: 2,
      productImages: 2,
      orders: 1,
      orderItems: 2,
    };
  });
}

/** CLI entry, used by `pnpm db:seed`. Never runs against production. */
function devCli(): void {
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[dev-seed] refusing to run with NODE_ENV=production: dev/test seed data must never reach production.",
    );
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