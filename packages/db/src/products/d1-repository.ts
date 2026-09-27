import { and, asc, count, desc, eq, gte, lt, or } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { decodeCatalogCursor, encodeCatalogCursor } from "../catalog/cursor";
import { inventory, products, productImages, productVariants } from "../schema/catalog";
import { buildImageSortOrderExpression, isExactImageOrderPermutation } from "./reorder";
import type {
  AddProductImageInput,
  CreateProductConflictReason,
  CreateVariantConflictReason,
  ProductDetailRecord,
  ProductImageRecord,
  ProductListPage,
  ProductListQuery,
  ProductRecord,
  ProductRepository,
  ProductVariantDetailRecord,
} from "./repository";

/**
 * Cloudflare D1 implementation of the product repository.
 *
 * Concrete implementation of {@link ProductRepository} against the Drizzle D1
 * client created by {@link createD1Client}. Mirrors the local better-sqlite3
 * contract: reads resolve to `null` when unknown, `createProduct` maps the
 * `(store_id, slug)` UNIQUE constraint failure and `createVariant` maps the
 * global `product_variants.sku` constraint into driver-neutral results.
 *
 * Product images behave exactly as on the local driver: ownership is resolved
 * through `products.storeId` in the same statement, and the ordering is
 * primary first, then `sortOrder` ascending, then `id` ascending. The shared
 * helper below is the only place that ordering is written, so the D1 detail
 * projection and the D1 image list cannot diverge from each other or from the
 * local twin. `addProductImages` mirrors the local write exactly, including the
 * hard-coded non-primary flag, so the two drivers cannot drift on insert
 * semantics either.
 *
 * The image-management methods added for product media (`countImagesByProduct`,
 * `deleteProductImage`, `setPrimaryProductImage`) are the local driver's twins
 * method for method: same `findOwnedProduct` guard, same
 * `PRODUCT_NOT_FOUND`/`IMAGE_NOT_FOUND` reasons, same idempotent promotion and
 * the same clear-then-set write order. D1 has no interactive transaction, so
 * doing it in the one order that keeps the one-primary-per-product partial
 * unique index satisfied is what makes the two implementations behaviorally
 * identical rather than merely similar.
 *
 * `reorderProductImages` is a twin of the local driver too, down to the shared
 * `./reorder` helpers that hold the exact-set check and the write expression:
 * both drivers refuse anything that is not a permutation of the product's real
 * image set, and both apply the accepted order in a single `UPDATE` so the
 * all-or-nothing guarantee survives D1's lack of a transaction. It writes only
 * `sortOrder`, so primary state is never touched.
 *
 * Worker-safe: only the Drizzle D1 driver and the product contract are
 * imported; the Node-only SQLite stack is never pulled into the Worker bundle.
 */
export function createD1ProductRepository(
  db: DrizzleD1Database<DatabaseSchema>,
): ProductRepository {
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
      const row = await db
        .select()
        .from(products)
        .where(and(eq(products.storeId, storeId), eq(products.slug, slug)))
        .get();
      return row ?? null;
    },

    async createProduct(input) {
      try {
        const rows = await db
          .insert(products)
          .values({
            storeId: input.storeId,
            categoryId: input.categoryId,
            name: input.name,
            slug: input.slug,
            description: input.description,
          })
          .returning();
        const product = rows[0];
        if (product === undefined) {
          throw new Error("product insert returned no row");
        }
        return { ok: true, product };
      } catch (error) {
        const reason = mapD1ProductCreateConflict(error);
        if (reason !== null) {
          return { ok: false, reason };
        }
        throw error;
      }
    },

    async createVariant(input) {
      const product = await findOwnedProduct(db, input.productId, input.storeId);
      if (product === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      try {
        const rows = await db
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
          .returning();
        const variant = rows[0];
        if (variant === undefined) {
          throw new Error("variant insert returned no row");
        }
        return { ok: true, variant };
      } catch (error) {
        const reason = mapD1VariantCreateConflict(error);
        if (reason !== null) {
          return { ok: false, reason };
        }
        throw error;
      }
    },

    async setInventory(input) {
      const variant = await db
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
      const rows = await db
        .insert(inventory)
        .values({ variantId: input.variantId, quantity: input.quantity })
        .onConflictDoUpdate({
          target: inventory.variantId,
          set: { quantity: input.quantity, updatedAt: new Date() },
        })
        .returning();
      const inventoryRow = rows[0];
      if (inventoryRow === undefined) {
        throw new Error("inventory upsert returned no row");
      }
      return { ok: true, inventory: inventoryRow };
    },

    async publishProduct(productId, storeId) {
      const product = await findOwnedProduct(db, productId, storeId);
      if (product === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      if (product.status === "archived") {
        return { ok: false, reason: "PRODUCT_ARCHIVED" };
      }
      const sellableVariant = await db
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
      const updatedRows = await db
        .update(products)
        .set({ status: "active" })
        .where(eq(products.id, productId))
        .returning();
      const updated = updatedRows[0];
      if (updated === undefined) {
        throw new Error("product publish returned no row");
      }
      return { ok: true, product: updated };
    },

    async addProductImages(input) {
      // Ownership is checked before anything is written, so a foreign or
      // unknown product id can never leave rows behind — including for an
      // empty batch, which stays a checked no-op.
      const product = await findOwnedProduct(db, input.productId, input.storeId);
      if (product === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      if (input.images.length === 0) {
        return { ok: true, images: [] };
      }

      const rows = await db
        .insert(productImages)
        .values(input.images.map((image) => toProductImageValues(input.productId, image)))
        .returning();
      return { ok: true, images: rows.map(toProductImageRecord) };
    },

    async countImagesByProduct(productId, storeId) {
      const row = await db
        .select({ total: count(productImages.id) })
        .from(productImages)
        .innerJoin(products, eq(products.id, productImages.productId))
        .where(and(eq(productImages.productId, productId), eq(products.storeId, storeId)))
        .get();
      return row === undefined ? 0 : row.total;
    },

    async deleteProductImage(input) {
      if ((await findOwnedProduct(db, input.productId, input.storeId)) === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      const removed = await db
        .delete(productImages)
        .where(and(eq(productImages.id, input.imageId), eq(productImages.productId, input.productId)))
        .returning(productImageColumns);
      const image = removed[0];
      if (image === undefined) {
        return { ok: false, reason: "IMAGE_NOT_FOUND" };
      }
      return { ok: true, image: toProductImageRecord(image) };
    },

    async setPrimaryProductImage(input) {
      if ((await findOwnedProduct(db, input.productId, input.storeId)) === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      const target = await findProductImageById(db, input.productId, input.imageId);
      if (target === null) {
        return { ok: false, reason: "IMAGE_NOT_FOUND" };
      }
      if (target.isPrimary === 1) {
        // Idempotent: the requested image already *is* the product's primary, so
        // no flag changes and no second write is issued.
        return { ok: true, image: toProductImageRecord(target) };
      }
      // Clear first, then promote, so the one-primary-per-product partial
      // unique index never sees two primaries. The local twin does the same in
      // the same order.
      await db
        .update(productImages)
        .set({ isPrimary: 0 })
        .where(and(eq(productImages.productId, input.productId), eq(productImages.isPrimary, 1)));
      const promoted = await db
        .update(productImages)
        .set({ isPrimary: 1 })
        .where(and(eq(productImages.id, input.imageId), eq(productImages.productId, input.productId)))
        .returning(productImageColumns);
      const row = promoted[0];
      if (row === undefined) {
        throw new Error("product image promote returned no row");
      }
      return { ok: true, image: toProductImageRecord(row) };
    },

    async reorderProductImages(input) {
      if ((await findOwnedProduct(db, input.productId, input.storeId)) === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      // The product's actual image set is read here rather than trusted from a
      // prior lookup, so a concurrent insert or delete between the caller's read
      // and this write is caught by the permutation check instead of being
      // applied as a partial reorder.
      const current = await db
        .select({ id: productImages.id })
        .from(productImages)
        .where(eq(productImages.productId, input.productId))
        .all();
      if (!isExactImageOrderPermutation(input.imageIds, current.map((row) => row.id))) {
        return { ok: false, reason: "IMAGE_SET_MISMATCH" };
      }
      // A product with no images submits an empty list, which is an exact
      // permutation of an empty set — a successful no-op. The `CASE` expression
      // is skipped because an empty one is not valid SQL.
      //
      // This is the whole reason the reorder is a single statement: D1 has no
      // interactive transaction, so a loop of per-row updates would leave the
      // gallery half-renumbered if a later statement failed. One `UPDATE` is
      // one statement, so it is applied whole or not at all. It is awaited
      // without `.run()`, matching the clear-then-set writes above.
      if (input.imageIds.length > 0) {
        await db
          .update(productImages)
          .set({ sortOrder: buildImageSortOrderExpression(input.imageIds) })
          .where(eq(productImages.productId, input.productId));
      }
      return { ok: true, images: await loadProductImages(db, input.productId, input.storeId) };
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

async function loadProductPage(
  db: DrizzleD1Database<DatabaseSchema>,
  storeId: string,
  query: ProductListQuery,
): Promise<ProductListPage> {
  const start = query.cursor === null ? null : decodeCatalogCursor(query.cursor);
  if (query.cursor !== null && start === null) {
    return { items: [], nextCursor: null };
  }

  const rows = await db
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
    .limit(query.limit + 1);
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

async function findProductDetail(
  db: DrizzleD1Database<DatabaseSchema>,
  storeId: string,
  productId: string,
): Promise<ProductDetailRecord | null> {
  const product = await findOwnedProduct(db, productId, storeId);
  if (product === null) {
    return null;
  }

  const rows = await db
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
    .orderBy(asc(productVariants.createdAt), asc(productVariants.id));

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

  return { ...product, variants, images: await loadProductImages(db, productId, storeId) };
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
 * statement rather than by trusting a prior lookup, so a product id belonging
 * to another store contributes no rows and is indistinguishable from a product
 * that does not exist. The `0`/`1` primary flag is widened to a boolean here,
 * at the read edge, matching the public catalog projection and the local twin.
 */
async function loadProductImages(
  db: DrizzleD1Database<DatabaseSchema>,
  productId: string,
  storeId: string,
): Promise<ProductImageRecord[]> {
  const rows = await db
    .select(productImageColumns)
    .from(productImages)
    .innerJoin(products, eq(products.id, productImages.productId))
    .where(and(eq(productImages.productId, productId), eq(products.storeId, storeId)))
    .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder), asc(productImages.id));
  return rows.map(toProductImageRecord);
}

/**
 * Resolve one product the caller owns (by id and store), or `null`. Keeps
 * existence hidden from callers who do not own the product.
 */
async function findOwnedProduct(
  db: DrizzleD1Database<DatabaseSchema>,
  productId: string,
  storeId: string,
): Promise<ProductRecord | null> {
  const product = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.storeId, storeId)))
    .get();
  return product ?? null;
}

/**
 * Resolve one image of one product by id, or `null`. Deliberately scoped to the
 * product rather than looked up by image id alone, so an image that belongs to
 * another product (or another seller) can never be promoted or deleted through
 * this path.
 */
async function findProductImageById(
  db: DrizzleD1Database<DatabaseSchema>,
  productId: string,
  imageId: string,
): Promise<typeof productImages.$inferSelect | null> {
  const image = await db
    .select(productImageColumns)
    .from(productImages)
    .where(and(eq(productImages.id, imageId), eq(productImages.productId, productId)))
    .get();
  return image ?? null;
}

/**
 * SQLite emits the conflict text as `UNIQUE constraint failed: <table>.<column>`.
 * D1 wraps it as `D1_ERROR: <sqlite text>: SQLITE_CONSTRAINT_UNIQUE`, and
 * Drizzle forwards the driver error verbatim. This matcher extracts the token
 * for the composite `(store_id, slug)` index and maps it back to the
 * driver-neutral reason.
 */
const PRODUCT_UNIQUE_CONFLICT_PATTERN =
  /UNIQUE constraint failed:\s+products\.store_id,\s*products\.slug/i;

/**
 * Same shape as {@link PRODUCT_UNIQUE_CONFLICT_PATTERN} but for the global
 * `product_variants.sku` unique index.
 */
const VARIANT_UNIQUE_CONFLICT_PATTERN =
  /UNIQUE constraint failed:\s+product_variants\.sku/i;

/**
 * Translate a D1/Drizzle UNIQUE constraint failure for the product
 * `(store_id, slug)` index into the driver-neutral conflict reason, or `null`
 * when the error is unrelated. Extraction is tolerant of wrapper prefixes
 * (`D1_ERROR:`), the trailing `: SQLITE_CONSTRAINT_UNIQUE` code, nested
 * `cause` chains and cross-realm error objects. This function is pure and
 * exported for tests.
 */
export function mapD1ProductCreateConflict(error: unknown): CreateProductConflictReason | null {
  for (const message of collectErrorMessages(error)) {
    if (PRODUCT_UNIQUE_CONFLICT_PATTERN.test(message)) {
      return "PRODUCT_SLUG_IN_USE";
    }
  }
  return null;
}

/**
 * Translate a D1/Drizzle UNIQUE constraint failure for the global
 * `product_variants.sku` index into the driver-neutral conflict reason, or
 * `null` when the error is unrelated. Same tolerance rules as
 * {@link mapD1ProductCreateConflict}. Pure and exported for tests.
 */
export function mapD1VariantCreateConflict(error: unknown): CreateVariantConflictReason | null {
  for (const message of collectErrorMessages(error)) {
    if (VARIANT_UNIQUE_CONFLICT_PATTERN.test(message)) {
      return "SKU_IN_USE";
    }
  }
  return null;
}

/**
 * Collect non-empty error messages across up to three levels of `cause`
 * nesting, tolerating plain objects (D1 errors can cross realm boundaries
 * where `instanceof Error` is unreliable) and bare strings. Wrapper layers
 * established by Drizzle/Driver adapters often carry their own message with
 * the driver error attached as `cause`, so the conflict matcher above
 * inspects every collected message rather than only the outermost one.
 */
function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== null && current !== undefined; depth++) {
    if (typeof current === "string" && current !== "") {
      messages.push(current);
    } else if (typeof current === "object") {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string" && message !== "") {
        messages.push(message);
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return messages;
}