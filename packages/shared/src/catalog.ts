/**
 * Public catalog contracts shared between the API and the browser.
 *
 * The catalog is the read-only storefront: every value a customer browses
 * through ({@link CatalogProductSummaryDto}, {@link CatalogProductDetailDto},
 * {@link CatalogCategoryDto}) is a projection of active rows only — a product
 * is only visible when both the product and its store are `active`, and the
 * product's category (when set) is `active`. Prices come from the cheapest
 * active variant; money is always an integer amount in {@link currency}
 * minor units.
 */

export interface CatalogCategoryDto {
  id: string;
  slug: string;
  name: string;
}

export interface CatalogStoreDto {
  id: string;
  slug: string;
  name: string;
}

export interface CatalogProductImageDto {
  id: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  isPrimary: boolean;
}

export interface CatalogVariantDto {
  id: string;
  name: string;
  sku: string | null;
  priceAmountCents: number;
  compareAtAmountCents: number | null;
  currency: string;
}

export interface CatalogProductSummaryDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  store: CatalogStoreDto;
  category: Pick<CatalogCategoryDto, "id" | "slug" | "name"> | null;
  /** Cheapest active variant price, or `null` when the product has no sellable variant. */
  priceAmountCents: number | null;
  compareAtAmountCents: number | null;
  currency: string | null;
  image: { url: string; altText: string | null } | null;
}

export interface CatalogProductListData {
  items: CatalogProductSummaryDto[];
  /** Opaque keyset cursor for the next page, or `null` when this is the last page. */
  nextCursor: string | null;
}

/** Client-side query parameters for `GET /api/catalog/products`. */
export interface CatalogListProductsRequest {
  /** Page size, clamped to 1..50 by the API (default 20). */
  limit?: number;
  /** Opaque keyset cursor from the previous page's {@link CatalogProductListData.nextCursor}. */
  cursor?: string;
  /** Category slug to filter by, when browsing a single category. */
  category?: string;
}

export interface CatalogProductDetailDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  store: CatalogStoreDto;
  category: Pick<CatalogCategoryDto, "id" | "slug" | "name"> | null;
  variants: CatalogVariantDto[];
  images: CatalogProductImageDto[];
}