import type {
  CatalogProductDetailDto,
  CatalogProductSummaryDto,
  CatalogVariantDto,
} from "@zelora/shared";
import type { ZeloraApi } from "../api/client";

/**
 * Best-effort cart-line enrichment.
 *
 * The cart API deliberately carries only `variantId` + `quantity` on each line
 * (money and product snapshots are derived at checkout, never trusted from the
 * client). To render product/variant information on the cart page without a
 * dedicated cart-detail endpoint, this helper joins the caller's cart variant
 * ids against the public catalog: it pages through the live catalog summaries
 * and loads each product's detail, then maps `variantId → { product, variant }`.
 *
 * The lookup is intentionally resilient: catalog failures or deactivated rows
 * simply produce a partial map, and missing variants surface as "unavailable"
 * lines in the UI rather than blocking the cart. Fetching details for every
 * live product is an acceptable Phase-1 trade-off; the upstream fix is a
 * cart-detail endpoint that emits line snapshots server-side.
 */
export interface CartVariantReference {
  product: CatalogProductDetailDto;
  variant: CatalogVariantDto;
}

const CATALOG_PAGE_LIMIT = 50;
const MAX_CATALOG_PAGES = 40;
const DETAIL_FETCH_CONCURRENCY = 6;

export async function loadCartVariantLookup(
  api: ZeloraApi,
  variantIds: readonly string[],
): Promise<Map<string, CartVariantReference>> {
  const wanted = new Set<string>(variantIds);
  const lookup = new Map<string, CartVariantReference>();
  if (wanted.size === 0) {
    return lookup;
  }

  const products: CatalogProductSummaryDto[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    try {
      const envelope = await api.listCatalogProducts({ limit: CATALOG_PAGE_LIMIT, cursor });
      if (!envelope.ok) {
        break;
      }
      products.push(...envelope.data.items);
      cursor = envelope.data.nextCursor ?? undefined;
      if (cursor === undefined) {
        break;
      }
    } catch {
      break;
    }
  }

  let nextIndex = 0;
  async function resolveDetails(): Promise<void> {
    while (wanted.size > 0) {
      const product = products[nextIndex];
      nextIndex += 1;
      if (product === undefined) {
        return;
      }
      let envelope;
      try {
        envelope = await api.getCatalogProductBySlug(product.slug);
      } catch {
        continue;
      }
      if (!envelope.ok) {
        continue;
      }
      for (const variant of envelope.data.variants) {
        if (wanted.delete(variant.id)) {
          lookup.set(variant.id, { product: envelope.data, variant });
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DETAIL_FETCH_CONCURRENCY, products.length) }, () =>
      resolveDetails(),
    ),
  );

  return lookup;
}