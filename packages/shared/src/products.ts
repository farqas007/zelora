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
  /**
   * An image-management operation named an image that does not belong to the
   * product the caller owns. Distinct from `PRODUCT_NOT_FOUND` on purpose: the
   * product's existence and ownership are already proven by that point, so
   * collapsing both would only hide a caller mistake behind a vaguer 404.
   */
  IMAGE_NOT_FOUND: "IMAGE_NOT_FOUND",
  /**
   * The product already holds the maximum number of images. A 409 rather than a
   * 422: the request is well-formed and the product state is what conflicts
   * with it, exactly like `PRODUCT_SLUG_IN_USE`.
   */
  IMAGE_LIMIT_REACHED: "IMAGE_LIMIT_REACHED",
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

/**
 * The only content types an uploaded product image may have.
 *
 * A **closed list of verified values**, not a client-declared MIME allowlist:
 * the API decides which byte sequences count as an image by sniffing the bytes
 * themselves (`services/media/image-validation.ts`) and reports one of these
 * four types. A `Content-Type` header or a filename extension never
 * influences the decision, so publishing this list describes the policy the
 * API actually enforces rather than a wish. The list also drives the file
 * extension of a content-addressed storage key, so a stored object can never
 * claim a format other than the one its bytes were verified as.
 */
export const PRODUCT_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;

/** A verified product-image content type, i.e. a member of {@link PRODUCT_IMAGE_CONTENT_TYPES}. */
export type ProductImageContentType = (typeof PRODUCT_IMAGE_CONTENT_TYPES)[number];

/**
 * Count/alt/url/byte limits for the seller product-image surface.
 *
 * `maxPerProduct`, `altTextMaxLength` and `urlMaxLength` govern stored rows.
 * `maxFilesPerRequest` and `maxBytesPerFile` govern a single upload request.
 * `maxStoredObjectBytes` is not a user-facing limit: it is the platform ceiling
 * a stored object may never exceed, so the per-image cap can never be raised
 * past what the storage layer can actually hold.
 *
 * The byte half of the contract, and why each number is what it is:
 *
 * - `maxBytesPerFile` is 1.5 MiB, **inclusive**: a file of exactly
 *   `1_572_864` bytes is accepted and one byte more is rejected. It is a
 *   *target* maximum, chosen to keep eight images per product (12 MiB of
 *   media) and eight files per request (12 MiB) inside what an edge worker
 *   should hold in one request, with room to spare.
 * - `maxStoredObjectBytes` is 2,000,000 bytes: Cloudflare D1's hard per-value
 *   BLOB limit. It is deliberately *not* the enforced cap — the 1.5 MiB
 *   per-image maximum is stricter — so it can only ever be a defense-in-depth
 *   invariant. It is stated here (and asserted in tests) because a limit that
 *   is invisible is a limit nothing keeps honest: raising
 *   `maxBytesPerFile` above this value would silently produce writes the
 *   database rejects.
 */
export const PRODUCT_IMAGE_LIMITS = {
  /** Maximum images one product may hold, enforced on every add. */
  maxPerProduct: 8,
  /** Maximum image files one upload request may carry. */
  maxFilesPerRequest: 8,
  /** Maximum size of a single uploaded image file, in bytes (1.5 MiB, inclusive). */
  maxBytesPerFile: 1_572_864,
  /**
   * Hard per-object ceiling for stored media bytes (Cloudflare D1's BLOB
   * limit). Never the enforced per-image cap — see the note above.
   */
  maxStoredObjectBytes: 2_000_000,
  altTextMaxLength: 200,
  urlMaxLength: 2048,
} as const;

/** One product's images, in the deterministic display order the API returns. */
export interface SellerProductImageListData {
  productId: string;
  images: ProductImageDto[];
}

/** Success payload for `GET /api/seller/products/:id/images`. */
export type ListSellerProductImagesEnvelope = ApiEnvelope<SellerProductImageListData>;

/**
 * Success payload for `DELETE /api/seller/products/:id/images/:imageId`.
 *
 * Deliberately small and deliberately **not** a {@link ProductImageDto}: the row
 * is gone, so echoing it would invite a client to render a deleted image. The
 * two ids echo the request so a client can reconcile against its own list
 * without a follow-up read, and `wasPrimary` tells it whether the product just
 * lost its primary image — the one fact a gallery cannot infer locally, since
 * "no primary" is a valid state a reorder or a delete can both produce.
 *
 * Carries no `storage_key`: the shared image DTO has no field for it, so the
 * same guarantee the list and upload envelopes give holds here.
 */
export interface DeletedProductImageData {
  productId: string;
  imageId: string;
  /** Whether the removed image was the product's primary at the moment it was removed. */
  wasPrimary: boolean;
}

/** Success payload for `DELETE /api/seller/products/:id/images/:imageId`. */
export type DeleteProductImageEnvelope = ApiEnvelope<DeletedProductImageData>;

/**
 * Success payload for `POST /api/seller/products/:id/images/:imageId/primary`.
 *
 * The promoted row rather than an empty acknowledgement, so a client can
 * re-render the gallery from this response alone. Promotion is idempotent, so a
 * retried request returns the same row again rather than an error.
 */
export type SetPrimaryProductImageEnvelope = ApiEnvelope<ProductImageDto>;

/**
 * Body of the image-reorder request.
 *
 * `imageIds` is a **complete, ordered, duplicate-free** list of the product's
 * image ids, not a partial move instruction. A partial list would be ambiguous
 * to apply (does an absent image go to the front or the back?) and would let a
 * stale client silently drop images, so the API requires the exact set and
 * refuses anything else. That is what makes an invalid reorder a 422 that
 * changes nothing at all, rather than a partial mutation a seller has to notice
 * and undo by hand.
 *
 * Ids are never accepted from anywhere else: the product comes from the URL
 * path, the store from the session, and the ownership of each id is re-resolved
 * server-side.
 */
export interface ReorderProductImagesRequest {
  imageIds: string[];
}

/**
 * Success payload for `PATCH /api/seller/products/:id/images/order`.
 *
 * The same shape {@link ListSellerProductImagesEnvelope} carries, so a client
 * replaces its gallery with one assignment instead of diffing. The returned
 * order is the canonical read order, which still leads with the primary image
 * (a reorder never changes which image is primary).
 */
export type ReorderProductImagesEnvelope = ApiEnvelope<SellerProductImageListData>;

/**
 * Success payload for `POST /api/seller/products/:id/images`: the rows the
 * upload actually created, in submitted order.
 *
 * The created rows (rather than a fresh full listing) are returned so a client
 * can render exactly what it just uploaded without a follow-up read. They are
 * plain {@link ProductImageDto} values, so `storage_key` cannot appear in the
 * response — the same guarantee the list and detail envelopes already give.
 */
export type AddProductImagesEnvelope = ApiEnvelope<ProductImageDto[]>;

/**
 * Slack reserved on top of the summed per-file maximum for everything that is
 * not image payload: the multipart boundary markers, the per-part headers
 * (`Content-Disposition`, `Content-Type`, `Content-Length`), the optional
 * `altText[]` parts, and general buffer growth in the parser.
 *
 * 64 KiB is far more than the framing for eight parts can need while staying
 * small next to the 12 MiB of payload it protects, so it cannot be used to slip
 * an extra image past the byte checks.
 */
const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 65_536;

/**
 * Transport-level ceiling for one image-upload request body.
 *
 * **Derived, never a second hand-written number.** The enforced limits are
 * still the per-file and per-request ones in {@link PRODUCT_IMAGE_LIMITS}: this
 * value only bounds what the server is willing to *buffer* while parsing
 * `multipart/form-data`, which Hono materialises in memory in one piece. It is
 * therefore exactly "the largest legal batch plus framing", so a request that
 * passes it can still be rejected for carrying a ninth file, an oversized file
 * or bytes that are not an image — the body limit is a resource guard, never a
 * substitute for validation.
 */
export const PRODUCT_IMAGE_UPLOAD_LIMITS = {
  maxBodyBytes:
    PRODUCT_IMAGE_LIMITS.maxFilesPerRequest * PRODUCT_IMAGE_LIMITS.maxBytesPerFile +
    MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
} as const;

export interface SellerProductDetailDto extends SellerProductSummaryDto {
  description: string | null;
  variants: SellerProductVariantDetailDto[];
  /** The product's images, in the same order `GET .../images` returns. */
  images: ProductImageDto[];
}

export type GetSellerProductEnvelope = ApiEnvelope<SellerProductDetailDto>;

/** Success payload for `POST /api/seller/products/:id/publish`. */
export type PublishProductEnvelope = ApiEnvelope<ProductDto>;