/**
 * Seller product contracts shared between the API and the browser.
 *
 * This module is the browser-facing vocabulary for the Seller Product Create
 * phase: an approved seller (a user whose role is `seller` with an active
 * seller profile and an active store) creates a product in their own store.
 *
 * Only product-row creation happens here: no variants, pricing, publishing,
 * editing or deletion yet. New products are created as `draft` by the database
 * default, so they never appear on the public catalog/storefront until a later
 * publishing phase flips the status.
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

/**
 * Error codes the seller product-creation endpoint can produce, as stable
 * string values. Auth/ownership transport errors reuse the auth vocabulary
 * (`ACCOUNT_SUSPENDED`, `ACCOUNT_DELETED`, `SLUG_IN_USE`, `RATE_LIMITED`,
 * `VALIDATION_ERROR`).
 */
export const SELLER_PRODUCT_ERROR_CODES = {
  SELLER_NOT_APPROVED: "SELLER_NOT_APPROVED",
  CATEGORY_NOT_FOUND: "CATEGORY_NOT_FOUND",
  PRODUCT_SLUG_IN_USE: "PRODUCT_SLUG_IN_USE",
} as const;
export type SellerProductErrorCode =
  (typeof SELLER_PRODUCT_ERROR_CODES)[keyof typeof SELLER_PRODUCT_ERROR_CODES];

/** Success payload for `POST /api/seller/products`: the created draft. */
export type CreateProductEnvelope = ApiEnvelope<ProductDto>;