/**
 * Public storefront contracts shared between the API and the browser.
 *
 * The storefront is the store-scoped landing page a customer reaches from
 * `/store/:slug`: one active store's public identity plus its published
 * products, paginated with the same keyset cursor the catalog index uses.
 *
 * Deliberately public-safe: the payload never carries seller-profile, user or
 * ownership fields — nothing a merchant or administrator sees is exposed here.
 */

import type { CatalogProductListData } from "./catalog";
import type { ApiEnvelope } from "./envelope";

/** Public projection of an active store on its storefront. */
export interface StorefrontStoreDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

/** One storefront page: store identity plus one page of published products. */
export interface StorefrontDto {
  store: StorefrontStoreDto;
  products: CatalogProductListData;
}

/** Client-side query parameters for `GET /api/stores/:slug`. */
export interface StorefrontRequest {
  /** Page size, clamped to 1..50 by the API (default 20). */
  limit?: number;
  /** Opaque keyset cursor from the previous page's `products.nextCursor`. */
  cursor?: string;
}

export type StorefrontEnvelope = ApiEnvelope<StorefrontDto>;