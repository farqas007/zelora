import { and, asc, count, desc, eq, gte, lt, or } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { decodeCatalogCursor, encodeCatalogCursor } from "../catalog/cursor";
import { inventory, products, productImages, productVariants } from "../schema/catalog";
import { buildImageSortOrderExpression, isExactImageOrderPermutation } from "./reorder";
import type {
  AddProductImageInput,
  ProductDetailRecord,
  ProductImageRecord,
  ProductListPage,
  ProductListQuery,
  ProductRecord,
  ProductRepository,
  ProductVariantDetailRecord,
} from "./repository";

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
 *
 * Product images are read through one shared column projection and one
 * ordering, so the dedicated list and the embedded detail can never drift.
 * `addProductImages` is the only image insert: it resolves ownership through
 * `products.storeId` in the same statement as the insert's guard and always
 * writes `is_primary = 0`, so the one-primary-per-product partial unique index
 * is never at risk from this path.
 *
 * `countImagesByProduct`, `deleteProductImage` and `setPrimaryProductImage`
 * resolve the owning product through the same `findOwnedProduct` guard before
 * touching a row, so an unknown product and a foreign one stay
 * indistinguishable. Promotion is two ordered writes (clear, then set) and
 * deletes never touch the stored bytes — see the port for why.
 *
 * `reorderProductImages` re-reads the product's actual image set and refuses
 * anything that is not an exact permutation of it, then applies the whole new
 * order in a single `UPDATE` via the shared `./reorder` helpers, so an invalid
 * reorder mutates nothing and a valid one is all-or-nothing. It writes only
 * `sortOrder`, so it can never change which image is primary.
 */
export function createLocalProductRepository(db: LocalDatabase): ProductRepository {
  return {
    async listByStore(storeId, query) {
      return loadProductPage(db, storeId, query);
    },

    async findByStoreAndId(storeId, productId) {
      return findProductDetail(db, storeId, productId);
    },

    async listImagesByProduct(productId, storeId) {
      return loadProductImages(db, productId, storeId);
    },

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

    async createVariant(input) {
      const product = findOwnedProduct(db, input.productId, input.storeId);
      if (product === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      try {
        const row = db
          .insert(productVariants)
          .values({
            productId: input.productId,
            sku: input.sku,
            name: input.name,
            priceAmountCents: input.priceAmountCents,
            compareAtAmountCents: input.compareAtAmountCents,
            currency: input.currency,
            status: "active",
          })
          .returning()
          .get();
        if (row === undefined) {
          throw new Error("variant insert returned no row");
        }
        return { ok: true, variant: row };
      } catch (error) {
        if (isVariantSkuConflict(error)) {
          return { ok: false, reason: "SKU_IN_USE" };
        }
        throw error;
      }
    },

    async setInventory(input) {
      const variant = db
        .select({ id: productVariants.id })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(
          and(
            eq(productVariants.id, input.variantId),
            eq(products.id, input.productId),
            eq(products.storeId, input.storeId),
          ),
        )
        .get();
      if (variant === undefined) {
        return { ok: false, reason: "VARIANT_NOT_FOUND" };
      }
      const row = db
        .insert(inventory)
        .values({ variantId: input.variantId, quantity: input.quantity })
        .onConflictDoUpdate({
          target: inventory.variantId,
          set: { quantity: input.quantity, updatedAt: new Date() },
        })
        .returning()
        .get();
      if (row === undefined) {
        throw new Error("inventory upsert returned no row");
      }
      return { ok: true, inventory: row };
    },

    async publishProduct(productId, storeId) {
      const product = findOwnedProduct(db, productId, storeId);
      if (product === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      if (product.status === "archived") {
        return { ok: false, reason: "PRODUCT_ARCHIVED" };
      }
      const sellableVariant =
        db
          .select({ id: productVariants.id })
          .from(productVariants)
          .innerJoin(inventory, eq(inventory.variantId, productVariants.id))
          .where(
            and(
              eq(productVariants.productId, productId),
              eq(productVariants.status, "active"),
              gte(productVariants.priceAmountCents, 1),
              gte(inventory.quantity, 1),
            ),
          )
          .limit(1)
          .get();
      if (sellableVariant === undefined) {
        return { ok: false, reason: "NOT_PUBLISHABLE" };
      }
      if (product.status === "active") {
        return { ok: true, product };
      }
      const updated = db
        .update(products)
        .set({ status: "active" })
        .where(eq(products.id, productId))
        .returning()
        .get();
      if (updated === undefined) {
        throw new Error("product publish returned no row");
      }
      return { ok: true, product: updated };
    },

    async addProductImages(input) {
      // Ownership is checked before anything is written, so a foreign or
      // unknown product id can never leave rows behind — including for an
      // empty batch, which stays a checked no-op.
      const product = findOwnedProduct(db, input.productId, input.storeId);
      if (product === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      if (input.images.length === 0) {
        return { ok: true, images: [] };
      }

      const rows = db
        .insert(productImages)
        .values(input.images.map((image) => toProductImageValues(input.productId, image)))
        .returning()
        .all();
      return { ok: true, images: rows.map(toProductImageRecord) };
    },

    async countImagesByProduct(productId, storeId) {
      const row = db
        .select({ total: count(productImages.id) })
        .from(productImages)
        .innerJoin(products, eq(products.id, productImages.productId))
        .where(and(eq(productImages.productId, productId), eq(products.storeId, storeId)))
        .get();
      return row === undefined ? 0 : row.total;
    },

    async deleteProductImage(input) {
      if (findOwnedProduct(db, input.productId, input.storeId) === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      const removed = db
        .delete(productImages)
        .where(and(eq(productImages.id, input.imageId), eq(productImages.productId, input.productId)))
        .returning(productImageColumns)
        .all();
      const image = removed[0];
      if (image === undefined) {
        return { ok: false, reason: "IMAGE_NOT_FOUND" };
      }
      return { ok: true, image: toProductImageRecord(image) };
    },

    async setPrimaryProductImage(input) {
      if (findOwnedProduct(db, input.productId, input.storeId) === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      const target = findProductImageById(db, input.productId, input.imageId);
      if (target === null) {
        return { ok: false, reason: "IMAGE_NOT_FOUND" };
      }
      if (target.isPrimary === 1) {
        // Idempotent: the requested image already *is* the product's primary, so
        // no flag changes and no second write is issued.
        return { ok: true, image: toProductImageRecord(target) };
      }
      // Clear first, then promote, so the one-primary-per-product partial
      // unique index never sees two primaries. The D1 twin does the same in the
      // same order.
      db.update(productImages)
        .set({ isPrimary: 0 })
        .where(and(eq(productImages.productId, input.productId), eq(productImages.isPrimary, 1)))
        .run();
      const promoted = db
        .update(productImages)
        .set({ isPrimary: 1 })
        .where(and(eq(productImages.id, input.imageId), eq(productImages.productId, input.productId)))
        .returning(productImageColumns)
        .get();
      if (promoted === undefined) {
        throw new Error("product image promote returned no row");
      }
      return { ok: true, image: toProductImageRecord(promoted) };
    },

    async reorderProductImages(input) {
      if (findOwnedProduct(db, input.productId, input.storeId) === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      // The product's actual image set is read here rather than trusted from a
      // prior lookup, so a concurrent insert or delete between the caller's read
      // and this write is caught by the permutation check instead of being
      // applied as a partial reorder.
      const current = db
        .select({ id: productImages.id })
        .from(productImages)
        .where(eq(productImages.productId, input.productId))
        .all()
        .map((row) => row.id);
      if (!isExactImageOrderPermutation(input.imageIds, current)) {
        return { ok: false, reason: "IMAGE_SET_MISMATCH" };
      }
      // A product with no images submits an empty list, which is an exact
      // permutation of an empty set — a successful no-op. The `CASE` expression
      // is skipped because an empty one is not valid SQL.
      if (input.imageIds.length > 0) {
        db.update(productImages)
          .set({ sortOrder: buildImageSortOrderExpression(input.imageIds) })
          .where(eq(productImages.productId, input.productId))
          .run();
      }
      return { ok: true, images: loadProductImages(db, input.productId, input.storeId) };
    },
  };
}

/**
 * Project one submitted image onto an insertable `product_images` row.
 *
 * `isPrimary: 0` is hard-coded rather than accepted: the caller cannot
 * express primary intent, so the `product_images_product_primary_unique`
 * partial unique index cannot be violated from this path.
 */
function toProductImageValues(
  productId: string,
  image: AddProductImageInput,
): typeof productImages.$inferInsert {
  return {
    productId,
    url: image.url,
    storageKey: image.storageKey,
    altText: image.altText,
    sortOrder: image.sortOrder,
    isPrimary: 0,
  };
}

/** Widen the stored `0`/`1` primary flag to a boolean, matching the read paths. */
function toProductImageRecord(row: typeof productImages.$inferSelect): ProductImageRecord {
  return { ...row, isPrimary: row.isPrimary === 1 };
}

function loadProductPage(
  db: LocalDatabase,
  storeId: string,
  query: ProductListQuery,
): ProductListPage {
  const start = query.cursor === null ? null : decodeCatalogCursor(query.cursor);
  if (query.cursor !== null && start === null) {
    return { items: [], nextCursor: null };
  }

  const rows = db
    .select()
    .from(products)
    .where(
      and(
        eq(products.storeId, storeId),
        start === null
          ? undefined
          : or(
              lt(products.createdAt, start.createdAt),
              and(eq(products.createdAt, start.createdAt), lt(products.id, start.id)),
            ),
      ),
    )
    .orderBy(desc(products.createdAt), desc(products.id))
    .limit(query.limit + 1)
    .all();
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows[pageRows.length - 1];

  return {
    items: pageRows,
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? encodeCatalogCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

function findProductDetail(
  db: LocalDatabase,
  storeId: string,
  productId: string,
): ProductDetailRecord | null {
  const product = findOwnedProduct(db, productId, storeId);
  if (product === null) {
    return null;
  }

  const rows = db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      sku: productVariants.sku,
      name: productVariants.name,
      priceAmountCents: productVariants.priceAmountCents,
      compareAtAmountCents: productVariants.compareAtAmountCents,
      currency: productVariants.currency,
      status: productVariants.status,
      createdAt: productVariants.createdAt,
      updatedAt: productVariants.updatedAt,
      inventoryVariantId: inventory.variantId,
      inventoryQuantity: inventory.quantity,
      inventoryUpdatedAt: inventory.updatedAt,
    })
    .from(productVariants)
    .leftJoin(inventory, eq(inventory.variantId, productVariants.id))
    .where(eq(productVariants.productId, productId))
    .orderBy(asc(productVariants.createdAt), asc(productVariants.id))
    .all();

  const variants: ProductVariantDetailRecord[] = rows.map((row) => ({
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    name: row.name,
    priceAmountCents: row.priceAmountCents,
    compareAtAmountCents: row.compareAtAmountCents,
    currency: row.currency,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    inventory:
      row.inventoryVariantId === null ||
      row.inventoryQuantity === null ||
      row.inventoryUpdatedAt === null
        ? null
        : {
            variantId: row.inventoryVariantId,
            quantity: row.inventoryQuantity,
            updatedAt: row.inventoryUpdatedAt,
          },
  }));

  return { ...product, variants, images: loadProductImages(db, productId, storeId) };
}

/**
 * Columns projected for a `product_images` row, shared by the detail loader and
 * the dedicated image list so both return byte-identical records.
 */
const productImageColumns = {
  id: productImages.id,
  productId: productImages.productId,
  url: productImages.url,
  storageKey: productImages.storageKey,
  altText: productImages.altText,
  sortOrder: productImages.sortOrder,
  isPrimary: productImages.isPrimary,
  createdAt: productImages.createdAt,
} as const;

/**
 * Images of one product the caller owns, in the canonical display order:
 * primary first, then `sortOrder` ascending, then `id` ascending.
 *
 * Ownership is verified by joining through `products.storeId` inside the same
 * statement rather than by trusting a prior lookup, so the query is safe to
 * call on its own: a product id belonging to another store contributes no rows
 * at all. The `0`/`1` primary flag is widened to a boolean here, at the read
 * edge, matching the public catalog projection.
 */
function loadProductImages(
  db: LocalDatabase,
  productId: string,
  storeId: string,
): ProductImageRecord[] {
  return db
    .select(productImageColumns)
    .from(productImages)
    .innerJoin(products, eq(products.id, productImages.productId))
    .where(and(eq(productImages.productId, productId), eq(products.storeId, storeId)))
    .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder), asc(productImages.id))
    .all()
    .map(toProductImageRecord);
}

/**
 * Resolve one product the caller owns (by id and store), or `null`. Keeps
 * existence hidden from callers who do not own the product.
 */
function findOwnedProduct(db: LocalDatabase, productId: string, storeId: string): ProductRecord | null {
  return (
    db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.storeId, storeId)))
      .get() ?? null
  );
}

/**
 * Resolve one image of one product by id, or `null`. Deliberately scoped to the
 * product rather than looked up by image id alone, so an image that belongs to
 * another product (or another seller) can never be promoted or deleted through
 * this path.
 */
function findProductImageById(
  db: LocalDatabase,
  productId: string,
  imageId: string,
): typeof productImages.$inferSelect | null {
  return (
    db
      .select(productImageColumns)
      .from(productImages)
      .where(and(eq(productImages.id, imageId), eq(productImages.productId, productId)))
      .get() ?? null
  );
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

/**
 * Match the `UNIQUE constraint failed: product_variants.sku` message
 * better-sqlite3 raises for the global SKU index.
 */
function isVariantSkuConflict(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: product_variants\.sku/.test(error.message);
}