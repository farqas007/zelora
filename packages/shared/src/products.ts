/**
 * Seller product contracts shared between the API and the browser.
 *
 * This module is the browser-facing vocabulary for the seller product
 * lifecycle: an approved seller (a user whose role is `seller` with an active
 * seller profile and an active store) creates a product in their own store,
 * adds variants, manages variant inventory and publishes.
 *
 * New products are created as `draft` by the database default and stay
 * invisible on the public catalog/storefront until the seller adds a sellable
 * variant (active, positive price, valid inventory) and publishes the product.
 *
 * Ownership is never accepted from the client. The `CreateProductRequest`
 * carries only visible listing fields; the API resolves the seller's own
 * store server-side from the authenticated session. Any client-supplied
 * `storeId`, `sellerProfileId`, `userId`, `status` or ownership field is
 * ignored.
 *
 * Status unions mirror the `packages/db` enums on purpose, exactly like
 * `./auth`. This module stays dependency-free (plain types/constants).
 */
import type { ApiEnvelope } from "./envelope";

export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const SELLER_PRODUCT_PAGE_LIMITS = {
  min: 1,
  max: 50,
  default: 20,
} as const;

/**
 * Validation limits applied by the API before any product mutation happens.
 * Shared so the web app can mirror them (e.g. inline hints) without
 * hardcoding. Whether a category is required/optional is a contract decision,
 * not a limit.
 */
export const PRODUCT_LIMITS = {
  nameMinLength: 1,
  nameMaxLength: 120,
  slugMinLength: 3,
  slugMaxLength: 60,
  descriptionMaxLength: 2000,
} as const;

/** Lowercase slug pattern shared with seller profiles and stores. */
export const PRODUCT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Body of the seller product-creation request. `storeId` is intentionally
 * absent: the store is resolved server-side from the authenticated seller.
 */
export interface CreateProductRequest {
  name: string;
  slug: string;
  description?: string;
  categoryId?: string;
}

/**
 * Owner view of a created product. Unlike the public catalog DTOs this
 * carries `storeId` and `status`: the listing's owner needs them (the public
 * storefront never exposes them).
 */
export interface ProductDto {
  id: string;
  storeId: string;
  slug: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  status: ProductStatus;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

export interface SellerProductSummaryDto {
  id: string;
  slug: string;
  name: string;
  categoryId: string | null;
  status: ProductStatus;
  createdAt: string;
}

export interface SellerListProductsRequest {
  limit?: number;
  cursor?: string;
}

export interface SellerProductListData {
  items: SellerProductSummaryDto[];
  nextCursor: string | null;
}

export type ListSellerProductsEnvelope = ApiEnvelope<SellerProductListData>;

/**
 * Error codes the seller product endpoints can produce, as stable string
 * values. Auth/ownership transport errors reuse the auth vocabulary
 * (`ACCOUNT_SUSPENDED`, `ACCOUNT_DELETED`, `SLUG_IN_USE`, `RATE_LIMITED`,
 * `VALIDATION_ERROR`).
 */
export const SELLER_PRODUCT_ERROR_CODES = {
  SELLER_NOT_APPROVED: "SELLER_NOT_APPROVED",
  CATEGORY_NOT_FOUND: "CATEGORY_NOT_FOUND",
  PRODUCT_SLUG_IN_USE: "PRODUCT_SLUG_IN_USE",
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  SKU_IN_USE: "SKU_IN_USE",
  PRODUCT_ARCHIVED: "PRODUCT_ARCHIVED",
  PRODUCT_NOT_PUBLISHABLE: "PRODUCT_NOT_PUBLISHABLE",
} as const;
export type SellerProductErrorCode =
  (typeof SELLER_PRODUCT_ERROR_CODES)[keyof typeof SELLER_PRODUCT_ERROR_CODES];

/** Success payload for `POST /api/seller/products`: the created draft. */
export type CreateProductEnvelope = ApiEnvelope<ProductDto>;

/**
 * Variant statuses. Variants are inserted as `active` when created by a
 * seller; the product itself only becomes sellable once published.
 */
export const PRODUCT_VARIANT_STATUSES = ["draft", "active", "inactive"] as const;
export type ProductVariantStatus = (typeof PRODUCT_VARIANT_STATUSES)[number];

/**
 * Validation limits applied by the API before any variant/inventory mutation.
 * Money stays in integer cents. Shared so the web app can mirror them.
 */
export const PRODUCT_VARIANT_LIMITS = {
  nameMinLength: 1,
  nameMaxLength: 120,
  skuMinLength: 1,
  skuMaxLength: 64,
  priceAmountCentsMin: 1,
  priceAmountCentsMax: 100_000_000,
  compareAtAmountCentsMin: 1,
  compareAtAmountCentsMax: 100_000_000,
} as const;

/** 3-letter ISO 4217 currency code, e.g. `USD`. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Default currency applied when a variant request omits one. Kept in sync
 * with the seeded catalog data.
 */
export const DEFAULT_PRODUCT_CURRENCY = "USD";

/** SKU pattern: alphanumeric start, then alphanumerics, `.`, `_` or `-`. */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Inventory quantity bounds applied by the API. */
export const INVENTORY_LIMITS = {
  quantityMin: 0,
  quantityMax: 100_000,
} as const;

/**
 * Body of the add-variant request. `currency` is optional and defaults to
 * `DEFAULT_PRODUCT_CURRENCY` on the server. `sku` is optional but must be
 * globally unique when provided.
 */
export interface CreateProductVariantRequest {
  name: string;
  sku?: string;
  priceAmountCents: number;
  compareAtAmountCents?: number;
  currency?: string;
}

/** Owner view of a product variant. */
export interface ProductVariantDto {
  id: string;
  productId: string;
  sku: string | null;
  name: string;
  priceAmountCents: number;
  compareAtAmountCents: number | null;
  currency: string;
  status: ProductVariantStatus;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/** Success payload for `POST /api/seller/products/:id/variants`. */
export type CreateProductVariantEnvelope = ApiEnvelope<ProductVariantDto>;

/** Body of the set-inventory request for a single variant. */
export interface SetInventoryRequest {
  quantity: number;
}

/** Owner view of a variant's inventory. */
export interface InventoryDto {
  variantId: string;
  quantity: number;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/** Success payload for `POST /api/seller/products/:id/variants/:variantId/inventory`. */
export type SetInventoryEnvelope = ApiEnvelope<InventoryDto>;

export interface SellerProductVariantDetailDto extends ProductVariantDto {
  inventory: InventoryDto | null;
}

/**
 * Owner view of one product image, mirroring a `product_images` row.
 *
 * The field set is deliberately identical to the public
 * {@link CatalogProductImageDto}: an owner sees exactly what a customer sees,
 * so the media record carries no privileged data and needs no separate
 * owner-only variant. `isPrimary` is the DB flag widened to a real boolean —
 * the `product_images_product_primary_unique` partial index guarantees at most
 * one `true` per product.
 */
export interface ProductImageDto {
  id: string;
  productId: string;
  url: string;
  altText: string | null;
  /** Display position within the product, ascending. */
  sortOrder: number;
  isPrimary: boolean;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** One product's images, in the deterministic display order the API returns. */
export interface SellerProductImageListData {
  productId: string;
  images: ProductImageDto[];
}

/** Success payload for `GET /api/seller/products/:id/images`. */
export type ListSellerProductImagesEnvelope = ApiEnvelope<SellerProductImageListData>;

export interface SellerProductDetailDto extends SellerProductSummaryDto {
  description: string | null;
  variants: SellerProductVariantDetailDto[];
  /** The product's images, in the same order `GET .../images` returns. */
  images: ProductImageDto[];
}

export type GetSellerProductEnvelope = ApiEnvelope<SellerProductDetailDto>;

/** Success payload for `POST /api/seller/products/:id/publish`. */
export type PublishProductEnvelope = ApiEnvelope<ProductDto>;