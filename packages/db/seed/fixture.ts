/**
 * Single source of truth for the development/test marketplace fixture.
 *
 * Both the local SQLite seed (`./dev.ts`) and the remote D1 SQL generator
 * (`./d1.ts`) build their rows from these constants, so the two paths can
 * never drift apart. Every id is constructed deterministically from a fixed
 * timestamp + sequence number and satisfies `isValidId` (UUIDv7 shape), which
 * keeps the generated SQL stable and lets a re-run resolve the same rows.
 *
 * This file holds data only — no database client, no Drizzle schema objects.
 */

import type {
  CategoryStatus,
  OrderAddressKind,
  OrderItemStatus,
  OrderStatus,
  ProductStatus,
  ProductVariantStatus,
  SellerProfileStatus,
  StoreStatus,
  UserRole,
} from "../src/schema/enums";

/**
 * Fixed instant every fixture row is "created at" (2026-09-01T00:00:00.000Z),
 * so local SQLite and remote D1 rows are byte-identical and catalog ordering
 * (created_at DESC, id DESC) is deterministic.
 */
export const FIXTURE_CREATED_AT_MS = Date.UTC(2026, 8, 1);

/**
 * Deterministic UUIDv7-shaped ids. The fixed timestamp bits in the prefix
 * (upper 12 hex chars of FIXTURE_CREATED_AT_MS) keep the ids ordered and
 * stable; the per-fixture sequence number in the tail guarantees uniqueness
 * within the fixture. The result always matches `isValidId`.
 */
const FIXTURE_TIMESTAMP_HEX = FIXTURE_CREATED_AT_MS.toString(16).padStart(12, "0");
let fixtureSequence = 0;
function nextFixtureId(): string {
  const seq = fixtureSequence.toString(16).padStart(12, "0");
  fixtureSequence += 1;
  return `${FIXTURE_TIMESTAMP_HEX.slice(0, 8)}-${FIXTURE_TIMESTAMP_HEX.slice(8, 12)}-7000-8000-${seq}`;
}

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

export interface FixtureUser {
  id: string;
  email: string;
  role: UserRole;
  name: string;
}

export const FIXTURE_USERS: readonly FixtureUser[] = [
  {
    id: nextFixtureId(),
    email: "dev-customer@example.test",
    role: "customer",
    name: "Dev Customer",
  },
  {
    id: nextFixtureId(),
    email: "dev-seller@example.test",
    role: "seller",
    name: "Zelora Test Seller",
  },
];

export interface FixtureSellerProfile {
  id: string;
  userId: string;
  slug: string;
  displayName: string;
  status: SellerProfileStatus;
}

export const FIXTURE_SELLER_PROFILES: readonly FixtureSellerProfile[] = [
  {
    id: nextFixtureId(),
    userId: FIXTURE_USERS[1]!.id,
    slug: "zelora-test-seller",
    displayName: "Zelora Test Seller",
    status: "active",
  },
];

export interface FixtureStore {
  id: string;
  sellerProfileId: string;
  name: string;
  slug: string;
  description: string;
  status: StoreStatus;
}

export const FIXTURE_STORES: readonly FixtureStore[] = [
  {
    id: nextFixtureId(),
    sellerProfileId: FIXTURE_SELLER_PROFILES[0]!.id,
    name: "Zelora Test Store",
    slug: "zelora-test-store",
    description:
      "A clearly fictional store used to test the Zelora shopping experience in development. Not a real marketplace seller.",
    status: "active",
  },
];

export interface FixtureCategory {
  id: string;
  name: string;
  slug: string;
  status: CategoryStatus;
}

export const FIXTURE_CATEGORIES: readonly FixtureCategory[] = [
  { id: nextFixtureId(), name: "Audio", slug: "audio", status: "active" },
  { id: nextFixtureId(), name: "Gaming", slug: "gaming", status: "active" },
  { id: nextFixtureId(), name: "Home & Living", slug: "home-living", status: "active" },
];

export interface FixtureProduct {
  id: string;
  storeId: string;
  categoryId: string;
  name: string;
  slug: string;
  description: string;
  status: ProductStatus;
}

export const FIXTURE_PRODUCTS: readonly FixtureProduct[] = [
  {
    id: nextFixtureId(),
    storeId: FIXTURE_STORES[0]!.id,
    categoryId: FIXTURE_CATEGORIES[0]!.id,
    name: "Wireless Headphones",
    slug: "wireless-headphones",
    description: "Over-ear wireless headphones with active noise cancellation.",
    status: "active",
  },
  {
    id: nextFixtureId(),
    storeId: FIXTURE_STORES[0]!.id,
    categoryId: FIXTURE_CATEGORIES[1]!.id,
    name: "Gaming Keyboard",
    slug: "gaming-keyboard",
    description: "Mechanical gaming keyboard with per-key RGB backlighting.",
    status: "active",
  },
  {
    id: nextFixtureId(),
    storeId: FIXTURE_STORES[0]!.id,
    categoryId: FIXTURE_CATEGORIES[1]!.id,
    name: "Gaming Mouse",
    slug: "gaming-mouse",
    description: "Precision optical gaming mouse with adjustable DPI.",
    status: "active",
  },
  {
    id: nextFixtureId(),
    storeId: FIXTURE_STORES[0]!.id,
    categoryId: FIXTURE_CATEGORIES[2]!.id,
    name: "LED Desk Lamp",
    slug: "led-desk-lamp",
    description: "Adjustable LED desk lamp with warm-white and daylight modes.",
    status: "active",
  },
];

export interface FixtureVariant {
  id: string;
  productId: string;
  sku: string;
  name: string;
  priceAmountCents: number;
  compareAtAmountCents: number | null;
  currency: string;
  status: ProductVariantStatus;
}

export const FIXTURE_VARIANTS: readonly FixtureVariant[] = [
  {
    id: nextFixtureId(),
    productId: FIXTURE_PRODUCTS[0]!.id,
    sku: "DEV-WH-BLK",
    name: "Matte Black",
    priceAmountCents: 129_99,
    compareAtAmountCents: 159_99,
    currency: "USD",
    status: "active",
  },
  {
    id: nextFixtureId(),
    productId: FIXTURE_PRODUCTS[0]!.id,
    sku: "DEV-WH-CRM",
    name: "Cream",
    priceAmountCents: 129_99,
    compareAtAmountCents: 159_99,
    currency: "USD",
    status: "active",
  },
  {
    id: nextFixtureId(),
    productId: FIXTURE_PRODUCTS[1]!.id,
    sku: "DEV-GK-TCT",
    name: "Tactile switches",
    priceAmountCents: 89_99,
    compareAtAmountCents: null,
    currency: "USD",
    status: "active",
  },
  {
    id: nextFixtureId(),
    productId: FIXTURE_PRODUCTS[1]!.id,
    sku: "DEV-GK-LIN",
    name: "Linear switches",
    priceAmountCents: 89_99,
    compareAtAmountCents: null,
    currency: "USD",
    status: "active",
  },
  {
    id: nextFixtureId(),
    productId: FIXTURE_PRODUCTS[2]!.id,
    sku: "DEV-GM-RGB",
    name: "Wired RGB",
    priceAmountCents: 49_99,
    compareAtAmountCents: null,
    currency: "USD",
    status: "active",
  },
  {
    id: nextFixtureId(),
    productId: FIXTURE_PRODUCTS[3]!.id,
    sku: "DEV-LD-ADJ",
    name: "Adjustable white",
    priceAmountCents: 39_99,
    compareAtAmountCents: null,
    currency: "USD",
    status: "active",
  },
];

export interface FixtureInventory {
  variantId: string;
  quantity: number;
}

export const FIXTURE_INVENTORY: readonly FixtureInventory[] = [
  { variantId: FIXTURE_VARIANTS[0]!.id, quantity: 25 },
  { variantId: FIXTURE_VARIANTS[1]!.id, quantity: 25 },
  { variantId: FIXTURE_VARIANTS[2]!.id, quantity: 20 },
  { variantId: FIXTURE_VARIANTS[3]!.id, quantity: 20 },
  { variantId: FIXTURE_VARIANTS[4]!.id, quantity: 50 },
  { variantId: FIXTURE_VARIANTS[5]!.id, quantity: 30 },
];

export interface FixtureImage {
  id: string;
  productId: string;
  url: string;
  altText: string;
}

export const FIXTURE_IMAGES: readonly FixtureImage[] = [
  {
    id: nextFixtureId(),
    productId: FIXTURE_PRODUCTS[0]!.id,
    url: "https://example.test/wireless-headphones.jpg",
    altText: "Wireless Headphones",
  },
  {
    id: nextFixtureId(),
    productId: FIXTURE_PRODUCTS[1]!.id,
    url: "https://example.test/gaming-keyboard.jpg",
    altText: "Gaming Keyboard",
  },
  {
    id: nextFixtureId(),
    productId: FIXTURE_PRODUCTS[2]!.id,
    url: "https://example.test/gaming-mouse.jpg",
    altText: "Gaming Mouse",
  },
  {
    id: nextFixtureId(),
    productId: FIXTURE_PRODUCTS[3]!.id,
    url: "https://example.test/led-desk-lamp.jpg",
    altText: "LED Desk Lamp",
  },
];

export interface FixtureOrder {
  id: string;
  customerUserId: string;
  status: OrderStatus;
  currency: string;
  subtotalAmountCents: number;
  shippingAmountCents: number;
  discountAmountCents: number;
  totalAmountCents: number;
}

export const FIXTURE_ORDERS: readonly FixtureOrder[] = [
  {
    id: nextFixtureId(),
    customerUserId: FIXTURE_USERS[0]!.id,
    status: "confirmed",
    currency: "USD",
    subtotalAmountCents: 179_98,
    shippingAmountCents: 0,
    discountAmountCents: 0,
    totalAmountCents: 179_98,
  },
];

export interface FixtureOrderAddress {
  id: string;
  orderId: string;
  kind: OrderAddressKind;
  recipientName: string;
  line1: string;
  city: string;
  countryCode: string;
}

export const FIXTURE_ORDER_ADDRESSES: readonly FixtureOrderAddress[] = [
  {
    id: nextFixtureId(),
    orderId: FIXTURE_ORDERS[0]!.id,
    kind: "shipping",
    recipientName: "Dev Customer",
    line1: "1 Dev Lane",
    city: "Testville",
    countryCode: "US",
  },
  {
    id: nextFixtureId(),
    orderId: FIXTURE_ORDERS[0]!.id,
    kind: "billing",
    recipientName: "Dev Customer",
    line1: "1 Dev Lane",
    city: "Testville",
    countryCode: "US",
  },
];

export interface FixtureOrderItem {
  id: string;
  orderId: string;
  variantId: string;
  storeId: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: number;
  unitAmountCents: number;
  lineTotalAmountCents: number;
  currency: string;
  status: OrderItemStatus;
}

export const FIXTURE_ORDER_ITEMS: readonly FixtureOrderItem[] = [
  {
    id: nextFixtureId(),
    orderId: FIXTURE_ORDERS[0]!.id,
    variantId: FIXTURE_VARIANTS[0]!.id,
    storeId: FIXTURE_STORES[0]!.id,
    productName: "Wireless Headphones",
    variantName: "Matte Black",
    sku: "DEV-WH-BLK",
    quantity: 1,
    unitAmountCents: 129_99,
    lineTotalAmountCents: 129_99,
    currency: "USD",
    status: "confirmed",
  },
  {
    id: nextFixtureId(),
    orderId: FIXTURE_ORDERS[0]!.id,
    variantId: FIXTURE_VARIANTS[4]!.id,
    storeId: FIXTURE_STORES[0]!.id,
    productName: "Gaming Mouse",
    variantName: "Wired RGB",
    sku: "DEV-GM-RGB",
    quantity: 1,
    unitAmountCents: 49_99,
    lineTotalAmountCents: 49_99,
    currency: "USD",
    status: "confirmed",
  },
];

/** Variant SKUs that the single fixture order references, used as an
 * idempotency guard for order creation (mirrors `seed/dev.ts`). */
export const FIXTURE_ORDER_VARIANT_SKUS: readonly string[] = ["DEV-WH-BLK", "DEV-GM-RGB"];