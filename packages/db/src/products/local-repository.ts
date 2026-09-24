import { and, eq } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { products } from "../schema/catalog";
import type { ProductRepository } from "./repository";

/**
 * Local (better-sqlite3) implementation of the product repository.
 *
 * Built on the existing local Drizzle client. Even though better-sqlite3 is
 * synchronous, the methods here still present the async port contract so
 * callers and tests are driver-agnostic and the Cloudflare D1 implementation
 * satisfies the same interface.
 *
 * `createProduct` maps the `(store_id, slug)` UNIQUE constraint failure into
 * the driver-neutral {@link CreateProductConflictReason} value; anything else
 * propagates unchanged. No raw driver error is exposed as a conflict.
 */
export function createLocalProductRepository(db: LocalDatabase): ProductRepository {
  return {
    async findByStoreAndSlug(storeId, slug) {
      return (
        db
          .select()
          .from(products)
          .where(and(eq(products.storeId, storeId), eq(products.slug, slug)))
          .get() ?? null
      );
    },

    async createProduct(input) {
      try {
        const row = db
          .insert(products)
          .values({
            storeId: input.storeId,
            categoryId: input.categoryId,
            name: input.name,
            slug: input.slug,
            description: input.description,
          })
          .returning()
          .get();
        if (row === undefined) {
          throw new Error("product insert returned no row");
        }
        return { ok: true, product: row };
      } catch (error) {
        if (isProductSlugConflict(error)) {
          return { ok: false, reason: "PRODUCT_SLUG_IN_USE" };
        }
        throw error;
      }
    },
  };
}

/**
 * Match the `UNIQUE constraint failed: products.store_id, products.slug`
 * message better-sqlite3 raises for the composite index. Column-level matching
 * keeps the mapping unambiguous.
 */
function isProductSlugConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: products\.store_id, products\.slug/.test(error.message)
  );
}