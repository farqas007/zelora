/**
 * Read-only catalog repository port.
 *
 * Structural contract shared by the local better-sqlite3 implementation and
 * the Cloudflare D1 implementation. This module is deliberately
 * dependency-free (no database client), so edge/API runtimes can import the
 * contract without pulling in the Node-only SQLite stack.
 *
 * "Active" is always resolved in SQL: a product is public when the product
 * itself is `active`, its store is `active`, and its category (when set) is
 * `active`. Status is never decided in application code.
 */

/** Active category projection used by the category index. */
export interface CatalogCategoryRecord {
  id: string;
  slug: string;
  name: string;
}

/** Active store projection embedded in every product summary/detail. */
export interface CatalogStoreRecord {
  id: string;
  slug: string;
  name: string;
}

/**
 * One row of the product index after aggregation. `priceAmountCents`/
 * `currency` are derived from the cheapest active variant (`null` when the
 * product has no active variant); `image` is the primary image when present.
 */
export interface CatalogProductSummaryRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  store: CatalogStoreRecord;
  category: Pick<CatalogCategoryRecord, "id" | "slug" | "name"> | null;
  priceAmountCents: number | null;
  compareAtAmountCents: number | null;
  currency: string | null;
  image: { url: string; altText: string | null } | null;
  createdAt: Date;
}

export interface CatalogProductListPage {
  items: CatalogProductSummaryRecord[];
  /** Opaque keyset cursor for the next page (`null` = last page). */
  nextCursor: string | null;
}

/**
 * Public storefront projection of a single active store. Deliberately minimal:
 * only identity + description, never seller-profile or ownership columns.
 */
export interface CatalogStorefrontRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

/** Active variant projection for the product detail page. */
export interface CatalogVariantRecord {
  id: string;
  name: string;
  sku: string | null;
  priceAmountCents: number;
  compareAtAmountCents: number | null;
  currency: string;
}

/** Image projection for the product detail page, in display order. */
export interface CatalogProductImageRecord {
  id: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  isPrimary: boolean;
}

/** Full product detail projection for the product detail page. */
export interface CatalogProductDetailRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  store: CatalogStoreRecord;
  category: Pick<CatalogCategoryRecord, "id" | "slug" | "name"> | null;
  variants: CatalogVariantRecord[];
  images: CatalogProductImageRecord[];
}

export interface CatalogRepository {
  /** Every category currently active, in name order. */
  listActiveCategories(): Promise<CatalogCategoryRecord[]>;

  /**
   * Keyset-paginated product index. Order is `(createdAt, id)` descending so
   * the cursor is stable even when new products arrive between pages. When
   * `categorySlug` is provided the page is restricted to products in that
   * (active) category; products without a category never match a filter.
   */
  listActiveProducts(opts: {
    limit: number;
    cursor: string | null;
    categorySlug?: string;
  }): Promise<CatalogProductListPage>;

  /** Resolve one active product by slug, linked store and category included. */
  findProductBySlug(slug: string): Promise<CatalogProductDetailRecord | null>;

  /**
   * Resolve one variant by id regardless of status. Unlike the storefront
   * projections this never filters on `status`, because it backs
   * referential checks (a cart must reference a real variant) rather than
   * public display. Returns `null` when the variant does not exist.
   */
  findVariantById(id: string): Promise<CatalogVariantRecord | null>;

  /**
   * Resolve one active store by slug for its public storefront. Returns
   * `null` when the slug is unknown or the store is not currently `active`
   * (draft/inactive/closed stores have no public page).
   */
  findActiveStoreBySlug(slug: string): Promise<CatalogStorefrontRecord | null>;

  /**
   * Keyset-paginated index of one store's published products. Mirrors
   * {@link listActiveProducts} — product/store/category `active` visibility,
   * the same `(createdAt, id)` descending order and cursor semantics — but
   * scoped to `storeSlug`, so a storefront only ever surfaces that store's own
   * live listings.
   */
  listStoreProducts(opts: {
    storeSlug: string;
    limit: number;
    cursor: string | null;
  }): Promise<CatalogProductListPage>;
}