import { NotFoundError, ValidationError } from "@zelora/core";
import type {
  CatalogCategoryDto,
  CatalogProductDetailDto,
  CatalogProductSummaryDto,
} from "@zelora/shared";
import type {
  CatalogProductSummaryRecord,
  CatalogRepository,
} from "@zelora/db/catalog";
import { normalizeSlug, validateSlug } from "./validation";

/**
 * Public read-only catalog for the storefront.
 *
 * The service is deliberately separate from merchants/auth: it answers three
 * unauthenticated reads (categories, product index, product detail) and owns
 * all the query-parameter parsing so the routes stay thin. Output is projected
 * from the repository records into the shared DTOs; visibility (active
 * product + active store + active category) is enforced in SQL by the
 * repository, never re-decided here.
 *
 * Edge-compatible: database contracts are imported as types only and all
 * repository I/O goes through the injected async port.
 */

export const CATALOG_PAGE_LIMITS = {
  min: 1,
  max: 50,
  default: 20,
} as const;

export interface ListProductsParams {
  limit?: string;
  cursor?: string;
  category?: string;
}

export interface ListProductsResultData {
  items: CatalogProductSummaryDto[];
  nextCursor: string | null;
}

export interface CatalogServiceDependencies {
  catalogRepository: CatalogRepository;
}

function mapSummaryToDto(summary: CatalogProductSummaryRecord): CatalogProductSummaryDto {
  return {
    id: summary.id,
    slug: summary.slug,
    name: summary.name,
    description: summary.description,
    store: summary.store,
    category: summary.category,
    priceAmountCents: summary.priceAmountCents,
    compareAtAmountCents: summary.compareAtAmountCents,
    currency: summary.currency,
    image: summary.image,
  };
}

export class CatalogService {
  private readonly catalogRepository: CatalogRepository;

  constructor(dependencies: CatalogServiceDependencies) {
    this.catalogRepository = dependencies.catalogRepository;
  }

  /** Every active category, in display order. */
  async listCategories(): Promise<CatalogCategoryDto[]> {
    return this.catalogRepository.listActiveCategories();
  }

  /**
   * Parse and execute the product index request. `limit` must be an integer in
   * {@link CATALOG_PAGE_LIMITS} (blank falls back to the default); `cursor` is
   * passed through opaque; `category` must be a valid slug when provided. A
   * malformed `limit`/`category` raises a 422 {@link ValidationError}.
   */
  async listProducts(params: ListProductsParams | undefined): Promise<ListProductsResultData> {
    const { limit, category } = parseListParams(params);
    const page = await this.catalogRepository.listActiveProducts({
      limit,
      cursor: params?.cursor ?? null,
      categorySlug: category,
    });
    return { items: page.items.map(mapSummaryToDto), nextCursor: page.nextCursor };
  }

  /**
   * Resolve one active product by slug. Unknown or non-public products raise
   * a 404 {@link NotFoundError} so the route never leaks whether a draft or
   * offline-store listing exists.
   */
  async getProductBySlug(slug: string): Promise<CatalogProductDetailDto> {
    const detail = await this.catalogRepository.findProductBySlug(slug);
    if (detail === null) {
      throw new NotFoundError("This product is not available.");
    }
    return detail;
  }
}

/** Parse and normalize `limit`/`category`; defaults applied, errors collected. */
function parseListParams(params: ListProductsParams | undefined): {
  limit: number;
  category: string | undefined;
} {
  const fields: Record<string, string[]> = {};

  let limit: number = CATALOG_PAGE_LIMITS.default;
  const rawLimit = params?.limit;
  if (rawLimit !== undefined && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit)) {
      fields.limit = ["Limit must be a positive integer."];
    } else {
      const parsed = Number(rawLimit);
      if (parsed < CATALOG_PAGE_LIMITS.min || parsed > CATALOG_PAGE_LIMITS.max) {
        fields.limit = [
          `Limit must be between ${CATALOG_PAGE_LIMITS.min} and ${CATALOG_PAGE_LIMITS.max}.`,
        ];
      } else {
        limit = parsed;
      }
    }
  }

  let category: string | undefined;
  const rawCategory = params?.category;
  if (rawCategory !== undefined && rawCategory !== "") {
    const normalized = normalizeSlug(rawCategory);
    const problems = validateSlug(normalized, "Category");
    if (problems.length > 0) {
      fields.category = problems;
    } else {
      category = normalized;
    }
  }

  if (Object.keys(fields).length > 0) {
    throw new ValidationError("The request is invalid.", fields);
  }
  return { limit, category };
}