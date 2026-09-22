import * as schema from "../schema";
import type { LocalDatabase } from "../client";

export interface Chain {
  customerUserId: string;
  sellerAUserId: string;
  sellerBUserId: string;
  storeAId: string;
  storeBId: string;
  categoryId: string;
  cameraProductId: string;
  lensProductId: string;
  cameraVariantId: string;
  lensVariantId: string;
  orderId?: string;
}

/**
 * Build a minimal but complete multi-vendor row graph:
 *
 *   customer           seller A               seller B
 *      │                 │                      │
 *      └── stores?   profile A                profile B
 *      └ order?    store A                    store B
 *                     │ camera product          │ lens product
 *                     └ camera variant          └ lens variant
 *
 * With `{ order: true }`, a single customer order contains one line from each
 * store. All amounts are integer cents (USD).
 */
export function createChain(db: LocalDatabase, opts: { order?: boolean } = {}): Chain {
  const [customerUserId, sellerAUserId, sellerBUserId] = db
    .insert(schema.users)
    .values([
      { email: "chain-customer@example.test", name: "Chain Customer" },
      { email: "chain-seller-a@example.test", role: "seller", name: "Chain Seller A" },
      { email: "chain-seller-b@example.test", role: "seller", name: "Chain Seller B" },
    ])
    .returning({ id: schema.users.id })
    .all()
    .map((row) => row.id) as [string, string, string];

  const [profileAId, profileBId] = db
    .insert(schema.sellerProfiles)
    .values([
      { userId: sellerAUserId, slug: "chain-seller-a", displayName: "Chain Seller A", status: "active" },
      { userId: sellerBUserId, slug: "chain-seller-b", displayName: "Chain Seller B", status: "active" },
    ])
    .returning({ id: schema.sellerProfiles.id })
    .all()
    .map((row) => row.id) as [string, string];

  const [storeAId, storeBId] = db
    .insert(schema.stores)
    .values([
      { sellerProfileId: profileAId, name: "Chain Store A", slug: "chain-store-a", status: "active" },
      { sellerProfileId: profileBId, name: "Chain Store B", slug: "chain-store-b", status: "active" },
    ])
    .returning({ id: schema.stores.id })
    .all()
    .map((row) => row.id) as [string, string];

  const categoryId = db
    .insert(schema.categories)
    .values({ name: "Cameras", slug: "cameras", status: "active" })
    .returning({ id: schema.categories.id })
    .get().id;

  const [cameraProductId, lensProductId] = db
    .insert(schema.products)
    .values([
      { storeId: storeAId, categoryId, name: "Chain Camera", slug: "chain-camera", status: "active" },
      { storeId: storeBId, categoryId, name: "Chain Lens", slug: "chain-lens", status: "active" },
    ])
    .returning({ id: schema.products.id })
    .all()
    .map((row) => row.id) as [string, string];

  const [cameraVariantId, lensVariantId] = db
    .insert(schema.productVariants)
    .values([
      {
        productId: cameraProductId,
        sku: "CHAIN-CAM-BODY",
        name: "Body only",
        priceAmountCents: 59_999,
        currency: "USD",
        status: "active",
      },
      {
        productId: lensProductId,
        sku: "CHAIN-LEN-50MM",
        name: "50mm prime",
        priceAmountCents: 24_999,
        currency: "USD",
        status: "active",
      },
    ])
    .returning({ id: schema.productVariants.id })
    .all()
    .map((row) => row.id) as [string, string];

  db.insert(schema.inventory).values([
    { variantId: cameraVariantId, quantity: 10 },
    { variantId: lensVariantId, quantity: 5 },
  ]).run();

  db.insert(schema.productImages).values([
    { productId: cameraProductId, url: "https://example.test/camera.jpg", isPrimary: 1 },
    { productId: lensProductId, url: "https://example.test/lens.jpg", isPrimary: 1 },
  ]).run();

  const chain: Chain = {
    customerUserId,
    sellerAUserId,
    sellerBUserId,
    storeAId,
    storeBId,
    categoryId,
    cameraProductId,
    lensProductId,
    cameraVariantId,
    lensVariantId,
  };

  if (opts.order === true) {
    const orderId = createMultiVendorOrder(db, chain);
    chain.orderId = orderId;
  }

  return chain;
}

export function createMultiVendorOrder(db: LocalDatabase, chain: Chain): string {
  const order = db
    .insert(schema.orders)
    .values({
      customerUserId: chain.customerUserId,
      status: "confirmed",
      subtotalAmountCents: 84_998,
      totalAmountCents: 84_998,
      currency: "USD",
    })
    .returning({ id: schema.orders.id })
    .get();

  db.insert(schema.orderAddresses).values([
    {
      orderId: order.id,
      kind: "shipping",
      recipientName: "Chain Customer",
      line1: "1 Chain Way",
      city: "Testville",
      countryCode: "US",
    },
  ]).run();

  db.insert(schema.orderItems).values([
    {
      orderId: order.id,
      variantId: chain.cameraVariantId,
      storeId: chain.storeAId,
      productName: "Chain Camera",
      variantName: "Body only",
      sku: "CHAIN-CAM-BODY",
      quantity: 1,
      unitAmountCents: 59_999,
      lineTotalAmountCents: 59_999,
      currency: "USD",
    },
    {
      orderId: order.id,
      variantId: chain.lensVariantId,
      storeId: chain.storeBId,
      productName: "Chain Lens",
      variantName: "50mm prime",
      sku: "CHAIN-LEN-50MM",
      quantity: 1,
      unitAmountCents: 24_999,
      lineTotalAmountCents: 24_999,
      currency: "USD",
    },
  ]).run();

  return order.id;
}