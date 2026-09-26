import type { ProductStatus, ProductVariantStatus } from "@zelora/shared";

/**
 * Seller write-side product repository port.
 *
 * Structural contract shared by the local better-sqlite3 implementation and
 * the Cloudflare D1 implementation, mirroring the other domain repositories
 * (seller, cart, audit). Every method is async so the same interface drives
 * both drivers (better-sqlite3 is synchronous; D1 is promise-based). This
 * module is deliberately dependency-free: it never imports a database client,
 * so edge/API runtimes can import the contract without pulling in the
 * Node-only SQLite stack.
 *
 * Product creation is a *row* insert only: no variants, pricing, images,
 * inventory or publishing. Status is never an accepted input — new products
 * always start `draft` via the database default, so nothing an owner submits
 * can make a listing appear on the public catalog. `storeId` is always
 * caller-supplied (the service's resolved seller store) and never accepted
 * from client input.
 *
 * Variants are inserted as `active` immediately; the product only becomes
 * public once `publishProduct` flips it to `active`, and only when at least
 * one variant is sellable. Publishing therefore never exposes an empty
 * listing.
 *
 * The `(store_id, slug)` UNIQUE constraint remains the race-condition
 * backstop for products; the global `product_variants.sku` UNIQUE constraint
 * is the backstop for variant SKUs. Hits surface as driver-neutral
 * {@link CreateProductConflictReason}/{@link CreateVariantConflictReason}
 * results so callers never inspect raw driver errors.
 */

/** A persisted product row, mirroring the `products` table. */
export interface ProductRecord {
  id: string;
  storeId: string;
  categoryId: string | null;
  name: string;
  slug: string;
  description: string | null;
  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** A persisted product variant row, mirroring the `product_variants` table. */
export interface VariantRecord {
  id: string;
  productId: string;
  sku: string | null;
  name: string;
  priceAmountCents: number;
  compareAtAmountCents: number | null;
  currency: string;
  status: ProductVariantStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** A persisted inventory row, mirroring the `inventory` table. */
export interface InventoryRecord {
  variantId: string;
  quantity: number;
  updatedAt: Date;
}

/**
 * A persisted product image row, mirroring the `product_images` table.
 *
 * `isPrimary` is the stored `0`/`1` integer flag widened to a boolean by the
 * drivers, matching the catalog repository's image record for the same column.
 * The database keeps the flag as an integer so the `in (0, 1)` CHECK and the
 * one-primary-per-product partial unique index are enforced in SQL; the widening
 * happens once, at the read edge, so no caller has to remember the encoding.
 *
 * `storageKey` is the server-side handle for the stored object and is `null`
 * for every URL-only image (externally hosted or seeded demo data). It is
 * deliberately **not** part of the shared `ProductImageDto`: the owner DTO is
 * documented to be identical to the public catalog DTO, so a delete handle has
 * no business crossing the API boundary.
 *
 * This table has no `updated_at`, so only `createdAt` exists. Phase 2A only
 * inserts images; nothing updates one yet, so an `updated_at` that would always
 * equal `created_at` was left out rather than added as dead weight.
 */
export interface ProductImageRecord {
  id: string;
  productId: string;
  url: string;
  storageKey: string | null;
  altText: string | null;
  sortOrder: number;
  isPrimary: boolean;
  createdAt: Date;
}

export interface ProductListQuery {
  limit: number;
  cursor: string | null;
}

export interface ProductListPage {
  items: ProductRecord[];
  nextCursor: string | null;
}

export interface ProductVariantDetailRecord extends VariantRecord {
  inventory: InventoryRecord | null;
}

export interface ProductDetailRecord extends ProductRecord {
  variants: ProductVariantDetailRecord[];
  /**
   * The product's images in the canonical order: primary first, then
   * `sortOrder` ascending, then `id` ascending. Empty when the product has no
   * media yet — a product with no images is a valid, fully-supported state.
   */
  images: ProductImageRecord[];
}

/**
 * Everything required to create a product. Ownership (`storeId`) is derived by
 * the service from the authenticated seller; `status` is intentionally absent
 * so callers cannot request a non-draft state.
 */
export interface CreateProductInput {
  storeId: string;
  categoryId: string | null;
  name: string;
  slug: string;
  description: string | null;
}

/** Driver-neutral conflict reason, mapped from the `(store_id, slug)` UNIQUE constraint. */
export type CreateProductConflictReason = "PRODUCT_SLUG_IN_USE";

export type CreateProductResult =
  | { ok: true; product: ProductRecord }
  | { ok: false; reason: CreateProductConflictReason };

/**
 * Everything required to create a variant on an owned product. Ownership
 * (`storeId`) is derived by the service from the authenticated seller;
 * `productId` comes from the URL path. `status` is intentionally absent:
 * variants are always inserted as `active`.
 */
export interface CreateVariantInput {
  productId: string;
  storeId: string;
  sku: string | null;
  name: string;
  priceAmountCents: number;
  compareAtAmountCents: number | null;
  currency: string;
}

/** Driver-neutral conflict reasons for variant creation. */
export type CreateVariantConflictReason = "PRODUCT_NOT_FOUND" | "SKU_IN_USE";

export type CreateVariantResult =
  | { ok: true; variant: VariantRecord }
  | { ok: false; reason: CreateVariantConflictReason };

/** Everything required to upsert inventory for one owned variant. */
export interface SetInventoryInput {
  productId: string;
  variantId: string;
  storeId: string;
  quantity: number;
}

export type SetInventoryResult =
  | { ok: true; inventory: InventoryRecord }
  | { ok: false; reason: "VARIANT_NOT_FOUND" };

/** Driver-neutral rejection reasons for publishing. */
export type PublishProductConflictReason = "PRODUCT_NOT_FOUND" | "PRODUCT_ARCHIVED" | "NOT_PUBLISHABLE";

export type PublishProductResult =
  | { ok: true; product: ProductRecord }
  | { ok: false; reason: PublishProductConflictReason };

/**
 * One image to append to a product.
 *
 * `isPrimary` is intentionally **absent**: every inserted image is
 * non-primary, so a caller can never trip the
 * `product_images_product_primary_unique` partial unique index, and the
 * one-primary-per-product invariant stays owned by the database rather than by
 * a write path that has no primary-management endpoint yet. Promoting an
 * image to primary is a separate, later operation.
 *
 * `url` and `storageKey` are both required from the caller even though the
 * column is nullable: a caller that wrote an object to storage passes its key,
 * and a caller inserting a URL-only row passes `null` explicitly. Making the
 * distinction impossible to skip by accident is worth one extra field.
 */
export interface AddProductImageInput {
  url: string;
  storageKey: string | null;
  altText: string | null;
  sortOrder: number;
}

/**
 * Everything required to append images to one owned product. Ownership
 * (`storeId`) is derived by the service from the authenticated seller;
 * `productId` comes from the URL path and is never taken from client input.
 */
export interface AddProductImagesInput {
  productId: string;
  storeId: string;
  images: AddProductImageInput[];
}

/** Driver-neutral rejection reasons for appending images. */
export type AddProductImagesConflictReason = "PRODUCT_NOT_FOUND";

/**
 * The inserted rows, in the same order as the submitted `images`. This is
 * insertion order, deliberately *not* the canonical read order: no re-sorting
 * happens here, so the ordering rule stays written down in exactly one place
 * per driver (the read paths). Callers that need canonical order re-read
 * through {@link ProductRepository.listImagesByProduct}.
 */
export type AddProductImagesResult =
  | { ok: true; images: ProductImageRecord[] }
  | { ok: false; reason: AddProductImagesConflictReason };

export interface ProductRepository {
  listByStore(storeId: string, query: ProductListQuery): Promise<ProductListPage>;
  findByStoreAndId(storeId: string, productId: string): Promise<ProductDetailRecord | null>;
  /**
   * Every image of one product the caller owns, in the canonical display order:
   * primary first, then `sortOrder` ascending, then `id` ascending. The final
   * `id` tiebreak is what makes the order total — `sortOrder` is a plain
   * caller-supplied integer with no uniqueness constraint, so two images may
   * legitimately share one, and without the tiebreak the same request could
   * return the same product's images in two different orders.
   *
   * Ownership is resolved through `products.storeId`, never from the image row.
   * An unknown product and a product owned by another store are both
   * indistinguishable here: they resolve to an **empty array**, not `null` and
   * not a 404, so this method on its own leaks nothing. Callers that must
   * distinguish "no images" from "no such product" pair it with
   * `findByStoreAndId`, which is the single place existence is decided.
   */
  listImagesByProduct(productId: string, storeId: string): Promise<ProductImageRecord[]>;
  /**
   * Pre-check used by the service: resolve one product within a single store
   * by slug, or `null` when the store has no product with that slug. The real
   * race-condition backstop stays the `(store_id, slug)` UNIQUE constraint.
   */
  findByStoreAndSlug(storeId: string, slug: string): Promise<ProductRecord | null>;
  /**
   * Insert a product row. UNIQUE constraint hits are translated into the
   * driver-neutral {@link CreateProductConflictReason} result; anything else
   * propagates unchanged.
   */
  createProduct(input: CreateProductInput): Promise<CreateProductResult>;
  /**
   * Insert an `active` variant on a product the caller owns. The global
   * `product_variants.sku` UNIQUE constraint is the SKU backstop, surfaced as
   * {@link CreateVariantConflictReason}. Unknown/unowned products resolve to
   * `PRODUCT_NOT_FOUND` (no existence leak).
   */
  createVariant(input: CreateVariantInput): Promise<CreateVariantResult>;
  /**
   * Upsert the inventory row for one owned variant. Unknown/unowned products
   * or unknown variants resolve to `VARIANT_NOT_FOUND` (no existence leak).
   */
  setInventory(input: SetInventoryInput): Promise<SetInventoryResult>;
  /**
   * Publish an owned product: flip `draft` → `active` only when at least one
   * variant is sellable (status `active`, price at least `1` cent, inventory
   * quantity at least `1`). Publishing an already-`active` product is
   * idempotent; archived products are rejected. Rejections are reasons, never
   * thrown, so callers can map them without inspecting driver errors.
   */
  publishProduct(productId: string, storeId: string): Promise<PublishProductResult>;
  /**
   * Append images to a product the caller owns. Ownership is resolved through
   * `products.storeId`, so an unknown product and a product owned by another
   * store are indistinguishable: both resolve to `PRODUCT_NOT_FOUND` and write
   * nothing. Every inserted row is non-primary (see
   * {@link AddProductImageInput}), and one multi-row `INSERT` keeps the batch
   * atomic without an explicit transaction.
   *
   * An empty `images` array is a successful no-op that still performs the
   * ownership check, so a foreign product with an empty batch is rejected
   * exactly like a foreign product with files.
   */
  addProductImages(input: AddProductImagesInput): Promise<AddProductImagesResult>;
}