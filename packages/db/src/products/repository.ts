import type { ProductStatus } from "@zelora/shared";

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
 * The `(store_id, slug)` UNIQUE constraint remains the race-condition
 * backstop; a hit surfaces as the driver-neutral
 * {@link CreateProductConflictReason} so callers never inspect raw driver
 * errors.
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

export interface ProductRepository {
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
}