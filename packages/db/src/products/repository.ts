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
  * This table has no `updated_at`, so only `createdAt` exists. Promotion
  * (`setPrimaryProductImage`) flips `isPrimary` without touching the row's
  * timestamps, so `createdAt` keeps describing when the image was added rather
  * than when it was last re-ordered; an `updated_at` that moved on every
  * re-promotion would blur that distinction for no query that needs it.
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

/**
 * Everything required to remove one image of a product the caller owns.
 * Ownership (`storeId`) is derived by the service from the authenticated
 * seller; `productId` and `imageId` come from the URL path. The `imageId` is
 * never resolved on its own: it is always scoped to `(product_id, store_id)`,
 * so an image belonging to another product simply does not match.
 */
export interface DeleteProductImageInput {
  productId: string;
  imageId: string;
  storeId: string;
}

/**
 * Why deleting an owned image was refused.
 *
 * `PRODUCT_NOT_FOUND` covers both an unknown product and one owned by another
 * store, exactly as elsewhere in this port, so existence never leaks.
 * `IMAGE_NOT_FOUND` is reported only once the product is already proven owned
 * by the caller, so it exposes nothing about any *other* seller's data: the
 * image id either belongs to this caller's product or it does not exist there.
 */
export type DeleteProductImageConflictReason = "PRODUCT_NOT_FOUND" | "IMAGE_NOT_FOUND";

/**
 * The deleted row, or the reason nothing was deleted.
 *
 * The returned record carries `storageKey` so an internal caller can reach the
 * stored object afterwards. That value is internal by construction: the shared
 * `ProductImageDto` has no field for it, so no response can leak it.
 */
export type DeleteProductImageResult =
  | { ok: true; image: ProductImageRecord }
  | { ok: false; reason: DeleteProductImageConflictReason };

/** Everything required to promote one image of a product the caller owns to primary. */
export interface SetPrimaryProductImageInput {
  productId: string;
  imageId: string;
  storeId: string;
}

/** Same rejection vocabulary as {@link DeleteProductImageResult}. */
export type SetPrimaryProductImageConflictReason = "PRODUCT_NOT_FOUND" | "IMAGE_NOT_FOUND";

/**
 * The promoted row, or the reason nothing changed. Promotion is idempotent:
 * an image that is already the product's primary resolves to `ok` with that
 * same row, so a retried request never turns into a failure.
 */
export type SetPrimaryProductImageResult =
  | { ok: true; image: ProductImageRecord }
  | { ok: false; reason: SetPrimaryProductImageConflictReason };

/**
 * Everything required to reorder one owned product's images.
 *
 * `imageIds` is a **complete, ordered, duplicate-free** list of the product's
 * image ids, not a partial move instruction, and this port requires that
 * exactly: the drivers refuse anything that is not a permutation of the
 * product's current image set. A partial list would be ambiguous to apply and
 * would let a stale caller silently drop an image, so the all-or-nothing rule
 * is enforced in the driver rather than trusted from the caller.
 *
 * Ownership (`storeId`) is derived by the service from the authenticated
 * seller; `productId` comes from the URL path and is never taken from client
 * input. No target sort order is accepted: the position in `imageIds` *is* the
 * new `sortOrder`, so the caller cannot request two images at the same position.
 */
export interface ReorderProductImagesInput {
  productId: string;
  /** The owning store, resolved by the service from the authenticated seller. */
  storeId: string;
  /** The complete new order, most significant first. */
  imageIds: readonly string[];
}

/**
 * Why an owned reorder was refused.
 *
 * `PRODUCT_NOT_FOUND` covers both an unknown product and one owned by another
 * store, exactly as elsewhere in this port, so existence never leaks.
 * `IMAGE_SET_MISMATCH` is reported only once the product is already proven owned
 * by the caller, and covers a submitted list that duplicates an id, omits one of
 * the product's images, or names an image that is not the product's. It is a
 * single reason on purpose: the seller needs to re-send the current list, and
 * which specific id was wrong is not actionable.
 */
export type ReorderProductImagesConflictReason =
  | "PRODUCT_NOT_FOUND"
  | "IMAGE_SET_MISMATCH";

/**
 * The product's images after the reorder, in the canonical read order
 * (primary first, then `sortOrder` ascending, then `id` ascending) — the same
 * order {@link ProductRepository.listImagesByProduct} returns, so a client can
 * replace its gallery from this response without a follow-up read.
 *
 * A reorder never changes primary state, so the primary image still leads the
 * returned list no matter where it sits in the submitted order.
 */
export type ReorderProductImagesResult =
  | { ok: true; images: ProductImageRecord[] }
  | { ok: false; reason: ReorderProductImagesConflictReason };

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
  /**
   * Count the images of a product the caller owns.
   *
   * An unknown product and a product owned by another store both count `0`, not
   * `null` and not a 404: this method is the per-product cap's pre-check, so
   * like {@link ProductRepository.listImagesByProduct} it leaks nothing on its
   * own. Callers that must distinguish "no images" from "no such product" pair
   * it with `findByStoreAndId`, which is the single place existence is
   * decided. Ordering is irrelevant to a count, so none is applied.
   */
  countImagesByProduct(productId: string, storeId: string): Promise<number>;
  /**
   * Delete one image of a product the caller owns and return the removed row.
   *
   * Scoped to `(image_id, product_id, store_id)`: an image of another product,
   * or of another seller's product, is reported as `IMAGE_NOT_FOUND` and
   * nothing is removed. Only the `product_images` row is deleted — the stored
   * bytes behind its `storage_key` are left alone, because byte reclamation is
   * a separate, later concern and a delete that also destroyed bytes could not
   * be undone once the row was gone.
   *
   * Deleting the primary image is not a special case: no row is promoted in
   * its place, so a product may legitimately be left with no primary image,
   * which is the same valid state a product with no images at all is in.
   */
  deleteProductImage(input: DeleteProductImageInput): Promise<DeleteProductImageResult>;
  /**
   * Promote one image of a product the caller owns to be its primary image and
   * return the promoted row.
   *
   * Exactly one image per product may be primary (the
   * `product_images_product_primary_unique` partial unique index), so this is
   * two ordered writes: clear the product's current primary, then set the
   * requested one. Both drivers do it in that order, so the invariant holds
   * the whole way and the two implementations cannot drift. Promoting the
   * image that is already primary is an idempotent success, not an error.
   *
   * Only the product's own `is_primary` flag changes; `sortOrder` and every
   * other row are untouched, and the canonical read order follows from the flag
   * on the next read.
   */
  setPrimaryProductImage(input: SetPrimaryProductImageInput): Promise<SetPrimaryProductImageResult>;
  /**
   * Replace the display order of a product the caller owns with a complete,
   * duplicate-free permutation of its current image ids, and return the images
   * in the canonical read order afterwards.
   *
   * The submitted set is checked against the product's actual image set inside
   * the driver, before anything is written: a duplicate, a missing id, a
   * foreign id or an id belonging to another product is reported as
   * `IMAGE_SET_MISMATCH` and **nothing is mutated**. Both drivers then apply the
   * whole new order in a single `UPDATE`, so a reorder is all-or-nothing even
   * on D1 (which has no interactive transaction) — a rejected or failed reorder
   * can never leave a product with a half-renumbered gallery.
   *
   * Only `sortOrder` is written. `isPrimary` is never touched by this method, so
   * a reorder cannot promote, demote or clear the primary image; the primary
   * simply keeps leading the canonical read order.
   *
   * Unknown or unowned products resolve to `PRODUCT_NOT_FOUND` (no existence
   * leak), matching every other write on this port.
   */
  reorderProductImages(input: ReorderProductImagesInput): Promise<ReorderProductImagesResult>;
}