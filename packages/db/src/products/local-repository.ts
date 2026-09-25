import { and, asc, desc, eq, gte, lt, or } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { decodeCatalogCursor, encodeCatalogCursor } from "../catalog/cursor";
import { inventory, products, productVariants } from "../schema/catalog";
import type {
  ProductDetailRecord,
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
 */
export function createLocalProductRepository(db: LocalDatabase): ProductRepository {
  return {
    async listByStore(storeId, query) {
      return loadProductPage(db, storeId, query);
    },

    async findByStoreAndId(storeId, productId) {
      return findProductDetail(db, storeId, productId);
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
  };
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

  return { ...product, variants };
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