import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { categories, productImages, products, productVariants, stores } from "../schema";
import type {
  CatalogProductSummaryRecord,
  CatalogRepository,
} from "./repository";
import { decodeCatalogCursor, encodeCatalogCursor } from "./cursor";

/**
 * Local (better-sqlite3) implementation of the catalog repository.
 *
 * The public catalog is assembled from a few small relational queries that
 * are merged in process memory: the product index rows, the cheapest active
 * variant per product, and (for the detail page) the variant and image lists.
 * Keeping the merge in JS keeps the same SQL shape available on Cloudflare D1
 * (no driver-specific aggregates or CTE support assumptions).
 *
 * Visibility is fully expressed in SQL — product `active`, store `active`,
 * category `active` when set — so no status decision can rot in application
 * code. Read-only by construction.
 */
export function createLocalCatalogRepository(db: LocalDatabase): CatalogRepository {
  return {
    async listActiveCategories() {
      return db
        .select({
          id: categories.id,
          slug: categories.slug,
          name: categories.name,
        })
        .from(categories)
        .where(eq(categories.status, "active"))
        .orderBy(categories.name);
    },

    async listActiveProducts({ limit, cursor, categorySlug }) {
      const start = cursor === null ? null : decodeCatalogCursor(cursor);
      if (cursor !== null && start === null) {
        return { items: [], nextCursor: null };
      }

      // Product index query: active product + active store + active category
      // (when set) + the primary image, keyset-paginated below the cursor.
      const rows = db
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
        .limit(limit + 1)
        .all();

      const pageRows = rows.slice(0, limit);
      const hasMore = rows.length > limit;

      if (pageRows.length === 0) {
        return { items: [], nextCursor: null };
      }

      const prices = aggregatedPricesByProduct(db, pageRows.map((row) => row.id));

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
      const row = db
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

      const variants = db
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
        .orderBy(productVariants.createdAt)
        .all();

      const images = db
        .select({
          id: productImages.id,
          url: productImages.url,
          altText: productImages.altText,
          sortOrder: productImages.sortOrder,
          isPrimary: productImages.isPrimary,
        })
        .from(productImages)
        .where(eq(productImages.productId, row.id))
        .orderBy(desc(productImages.isPrimary), productImages.sortOrder)
        .all();

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

/**
 * Cheapest active variant per product for the given product ids. Products
 * with no active variant are absent from the map (their summary falls back to
 * `priceAmountCents: null`).
 *
 * The aggregation returns one *complete variant row* (price, compare-at and
 * currency from the same row) rather than independently aggregated columns,
 * so a more expensive variant's compare-at amount or currency can never be
 * paired with the cheapest variant's price. Ties on price resolve
 * deterministically by `(createdAt, id)`.
 */
export function aggregatedPricesByProduct(
  db: LocalDatabase,
  productIds: string[],
): Map<string, { priceAmountCents: number; compareAtAmountCents: number | null; currency: string }> {
  const rows = db
    .select({
      productId: productVariants.productId,
      priceAmountCents: productVariants.priceAmountCents,
      compareAtAmountCents: productVariants.compareAtAmountCents,
      currency: productVariants.currency,
    })
    .from(productVariants)
    .where(
      and(
        inArray(productVariants.productId, productIds),
        eq(productVariants.status, "active"),
      ),
    )
    .orderBy(
      asc(productVariants.priceAmountCents),
      asc(productVariants.createdAt),
      asc(productVariants.id),
    )
    .all();

  const prices = new Map<string, { priceAmountCents: number; compareAtAmountCents: number | null; currency: string }>();
  for (const row of rows) {
    // First occurrence is the cheapest active variant: price, compare-at and
    // currency all come from this one row.
    if (!prices.has(row.productId)) {
      prices.set(row.productId, {
        priceAmountCents: row.priceAmountCents,
        compareAtAmountCents: row.compareAtAmountCents,
        currency: row.currency,
      });
    }
  }
  return prices;
}