import { and, desc, eq, inArray, isNull, lt, min, or } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { categories, productImages, products, productVariants, stores } from "../schema";
import type {
  CatalogCategoryRecord,
  CatalogProductSummaryRecord,
  CatalogRepository,
} from "./repository";
import { decodeCatalogCursor, encodeCatalogCursor } from "./cursor";

/**
 * Cloudflare D1 implementation of the catalog repository.
 *
 * Mirrors the local better-sqlite3 contract query-for-query (the merged
 * aggregation lives in JS, so both drivers share SQL shapes); the only
 * differences are the `await`ed driver calls. Catalog reads are pure selects,
 * so the D1 batch/transaction constraint never applies here.
 *
 * Worker-safe: only the Drizzle D1 driver and catalog contracts are imported;
 * the Node-only SQLite stack never reaches the Worker bundle.
 */
export function createD1CatalogRepository(
  db: DrizzleD1Database<DatabaseSchema>,
): CatalogRepository {
  return {
    async listActiveCategories(): Promise<CatalogCategoryRecord[]> {
      const rows = await db
        .select({
          id: categories.id,
          slug: categories.slug,
          name: categories.name,
        })
        .from(categories)
        .where(eq(categories.status, "active"))
        .orderBy(categories.name);
      return rows;
    },

    async listActiveProducts({ limit, cursor, categorySlug }) {
      const start = cursor === null ? null : decodeCatalogCursor(cursor);
      if (cursor !== null && start === null) {
        return { items: [], nextCursor: null };
      }

      const rows = await db
        .select({
          id: products.id,
          slug: products.slug,
          name: products.name,
          description: products.description,
          createdAt: products.createdAt,
          storeId: stores.id,
          storeSlug: stores.slug,
          storeName: stores.name,
          categoryId: categories.id,
          categorySlug: categories.slug,
          categoryName: categories.name,
          imageUrl: productImages.url,
          imageAltText: productImages.altText,
        })
        .from(products)
        .innerJoin(stores, eq(stores.id, products.storeId))
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .leftJoin(
          productImages,
          and(
            eq(productImages.productId, products.id),
            eq(productImages.isPrimary, 1),
          ),
        )
        .where(
          and(
            eq(products.status, "active"),
            eq(stores.status, "active"),
            or(isNull(products.categoryId), eq(categories.status, "active")),
            categorySlug === undefined ? undefined : eq(categories.slug, categorySlug),
            start === null
              ? undefined
              : or(
                  lt(products.createdAt, start.createdAt),
                  and(
                    eq(products.createdAt, start.createdAt),
                    lt(products.id, start.id),
                  ),
                ),
          ),
        )
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(limit + 1);

      const pageRows = rows.slice(0, limit);
      const hasMore = rows.length > limit;

      if (pageRows.length === 0) {
        return { items: [], nextCursor: null };
      }

      const prices = await aggregatedPricesByProduct(db, pageRows.map((row) => row.id));

      const items: CatalogProductSummaryRecord[] = pageRows.map((row) => {
        const price = prices.get(row.id);
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description,
          store: { id: row.storeId, slug: row.storeSlug, name: row.storeName },
          category:
            row.categoryId === null ? null : { id: row.categoryId, slug: row.categorySlug!, name: row.categoryName! },
          priceAmountCents: price?.priceAmountCents ?? null,
          compareAtAmountCents: price?.compareAtAmountCents ?? null,
          currency: price?.currency ?? null,
          image: row.imageUrl === null ? null : { url: row.imageUrl, altText: row.imageAltText },
          createdAt: row.createdAt,
        };
      });

      const last = pageRows[pageRows.length - 1];
      return {
        items,
        nextCursor:
          hasMore && last !== undefined
            ? encodeCatalogCursor({ createdAt: last.createdAt, id: last.id })
            : null,
      };
    },

    async findProductBySlug(slug) {
      const row = await db
        .select({
          id: products.id,
          slug: products.slug,
          name: products.name,
          description: products.description,
          storeId: stores.id,
          storeSlug: stores.slug,
          storeName: stores.name,
          categoryId: categories.id,
          categorySlug: categories.slug,
          categoryName: categories.name,
        })
        .from(products)
        .innerJoin(stores, eq(stores.id, products.storeId))
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(
          and(
            eq(products.slug, slug),
            eq(products.status, "active"),
            eq(stores.status, "active"),
            or(isNull(products.categoryId), eq(categories.status, "active")),
          ),
        )
        .get();

      if (row === undefined) {
        return null;
      }

      const [variants, images] = await Promise.all([
        db
          .select({
            id: productVariants.id,
            name: productVariants.name,
            sku: productVariants.sku,
            priceAmountCents: productVariants.priceAmountCents,
            compareAtAmountCents: productVariants.compareAtAmountCents,
            currency: productVariants.currency,
          })
          .from(productVariants)
          .where(
            and(
              eq(productVariants.productId, row.id),
              eq(productVariants.status, "active"),
            ),
          )
          .orderBy(productVariants.createdAt),
        db
          .select({
            id: productImages.id,
            url: productImages.url,
            altText: productImages.altText,
            sortOrder: productImages.sortOrder,
            isPrimary: productImages.isPrimary,
          })
          .from(productImages)
          .where(eq(productImages.productId, row.id))
          .orderBy(desc(productImages.isPrimary), productImages.sortOrder),
      ]);

      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        store: { id: row.storeId, slug: row.storeSlug, name: row.storeName },
        category:
          row.categoryId === null ? null : { id: row.categoryId, slug: row.categorySlug!, name: row.categoryName! },
        variants,
        images: images.map((image) => ({ ...image, isPrimary: image.isPrimary === 1 })),
      };
    },
  };
}

/** Async twin of the local aggregation — cheapest active variant per product. */
export async function aggregatedPricesByProduct(
  db: DrizzleD1Database<DatabaseSchema>,
  productIds: string[],
): Promise<Map<string, { priceAmountCents: number; compareAtAmountCents: number | null; currency: string }>> {
  const rows = await db
    .select({
      productId: productVariants.productId,
      priceAmountCents: min(productVariants.priceAmountCents),
      compareAtAmountCents: min(productVariants.compareAtAmountCents),
      currency: productVariants.currency,
    })
    .from(productVariants)
    .where(
      and(
        inArray(productVariants.productId, productIds),
        eq(productVariants.status, "active"),
      ),
    )
    .groupBy(productVariants.productId);

  const prices = new Map<string, { priceAmountCents: number; compareAtAmountCents: number | null; currency: string }>();
  for (const row of rows) {
    prices.set(row.productId, {
      priceAmountCents: row.priceAmountCents ?? 0,
      compareAtAmountCents: row.compareAtAmountCents ?? null,
      currency: row.currency,
    });
  }
  return prices;
}