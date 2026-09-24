import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "@zelora/core";
import type {
  CatalogProductDetailRecord,
  CatalogProductListPage,
  CatalogProductSummaryRecord,
  CatalogRepository,
  CatalogStorefrontRecord,
} from "@zelora/db/catalog";
import { CatalogService, CATALOG_PAGE_LIMITS } from "./catalog";

/**
 * Unit tests for the catalog service. The repository is faked at the
 * composition boundary so these cover only what the service owns: query
 * parameter parsing/normalization, DTO projection (including the strip of
 * internal fields like `createdAt`) and the 404 mapping for missing products.
 */

const summary: CatalogProductSummaryRecord = {
  id: "01955f00-0000-7000-8000-000000000001",
  slug: "camper",
  name: "Camper",
  description: "A cozy camper",
  store: { id: "store-1", slug: "shop", name: "Shop" },
  category: { id: "cat-1", slug: "campers", name: "Campers" },
  priceAmountCents: 1_500,
  compareAtAmountCents: 2_000,
  currency: "USD",
  image: { url: "https://cdn.example.test/hero.jpg", altText: "Hero" },
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
};

const detail: CatalogProductDetailRecord = {
  id: summary.id,
  slug: summary.slug,
  name: summary.name,
  description: summary.description,
  store: summary.store,
  category: summary.category,
  variants: [
    {
      id: "01955f00-0000-7000-8000-000000000002",
      name: "Two-person",
      sku: "camper-t2",
      priceAmountCents: 1_500,
      compareAtAmountCents: 2_000,
      currency: "USD",
    },
  ],
  images: [
    {
      id: "01955f00-0000-7000-8000-000000000003",
      url: "https://cdn.example.test/hero.jpg",
      altText: "Hero",
      sortOrder: 0,
      isPrimary: true,
    },
  ],
};

class FakeCatalogRepository implements CatalogRepository {
  listActiveProductsCalls: Array<{
    limit: number;
    cursor: string | null;
    categorySlug?: string;
  }> = [];
  storeProductsCalls: Array<{
    storeSlug: string;
    limit: number;
    cursor: string | null;
  }> = [];
  private page: CatalogProductListPage = { items: [summary], nextCursor: null };
  private storefrontStore: CatalogStorefrontRecord | null = {
    id: "store-1",
    slug: "shop",
    name: "Shop",
    description: "A cozy shop",
  };

  async listActiveCategories() {
    return [{ id: "cat-1", slug: "campers", name: "Campers" }];
  }

  async listActiveProducts(opts: { limit: number; cursor: string | null; categorySlug?: string }) {
    this.listActiveProductsCalls.push(opts);
    return this.page;
  }

  async findProductBySlug(slug: string) {
    return slug === summary.slug ? detail : null;
  }

  async findVariantById(_id: string) {
    return null;
  }

  async findActiveStoreBySlug(slug: string) {
    return slug === this.storefrontStore?.slug ? this.storefrontStore : null;
  }

  async listStoreProducts(opts: { storeSlug: string; limit: number; cursor: string | null }) {
    this.storeProductsCalls.push(opts);
    return this.page;
  }

  setPage(page: CatalogProductListPage): void {
    this.page = page;
  }
}

describe("CatalogService", () => {
  let repository: FakeCatalogRepository;
  let service: CatalogService;

  beforeEach(() => {
    repository = new FakeCatalogRepository();
    service = new CatalogService({ catalogRepository: repository });
  });

  it("lists categories straight through", async () => {
    expect(await service.listCategories()).toEqual([
      { id: "cat-1", slug: "campers", name: "Campers" },
    ]);
  });

  it("projects summaries to DTOs, stripping the internal createdAt", async () => {
    const result = await service.listProducts(undefined);

    expect(result.items).toHaveLength(1);
    expect(Object.keys(result.items[0]!).sort()).toEqual([
      "category",
      "compareAtAmountCents",
      "currency",
      "description",
      "id",
      "image",
      "name",
      "priceAmountCents",
      "slug",
      "store",
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("applies the default limit and omits an absent category", async () => {
    await service.listProducts(undefined);
    await service.listProducts({ limit: "", category: "" });

    expect(repository.listActiveProductsCalls).toEqual([
      { limit: CATALOG_PAGE_LIMITS.default, cursor: null, categorySlug: undefined },
      { limit: CATALOG_PAGE_LIMITS.default, cursor: null, categorySlug: undefined },
    ]);
  });

  it("passes an explicit limit, cursor and category through to the repository", async () => {
    await service.listProducts({ limit: "5", cursor: "1767312000000:x", category: "Campers" });

    expect(repository.listActiveProductsCalls).toEqual([
      { limit: 5, cursor: "1767312000000:x", categorySlug: "campers" },
    ]);
  });

  it("rejects a malformed limit with a 422 field error", async () => {
    for (const limit of ["abc", "-1", "0", "51", "1.5"]) {
      const error = await service.listProducts({ limit }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ValidationError);
      const validation = error as ValidationError;
      expect(validation.statusCode).toBe(422);
      expect(validation.code).toBe("VALIDATION_ERROR");
      expect(validation.fields?.limit).toBeDefined();
    }
    expect(repository.listActiveProductsCalls).toHaveLength(0);
  });

  it("rejects an invalid category slug with a 422 field error", async () => {
    const error = await service
      .listProducts({ category: "not a slug!" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).statusCode).toBe(422);
    expect((error as ValidationError).fields?.category).toBeDefined();
    expect(repository.listActiveProductsCalls).toHaveLength(0);
  });

  it("resolves a product detail and projects it to the DTO", async () => {
    const result = await service.getProductBySlug("camper");

    expect(result).toEqual(detail);
    expect(Object.keys(result).sort()).toEqual([
      "category",
      "description",
      "id",
      "images",
      "name",
      "slug",
      "store",
      "variants",
    ]);
  });

  it("raises a 404 for an unknown product", async () => {
    const error = await service.getProductBySlug("missing").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(NotFoundError);
    const notFound = error as NotFoundError;
    expect(notFound.statusCode).toBe(404);
    expect(notFound.code).toBe("NOT_FOUND");
  });

  it("resolves a storefront with the public-safe store projection", async () => {
    const result = await service.getStorefront("shop", undefined);

    expect(Object.keys(result.store).sort()).toEqual(["description", "id", "name", "slug"]);
    expect(result.store).toEqual({
      id: "store-1",
      slug: "shop",
      name: "Shop",
      description: "A cozy shop",
    });
    expect(result.products.items).toHaveLength(1);
    expect(Object.keys(result.products.items[0]!).sort()).toEqual([
      "category",
      "compareAtAmountCents",
      "currency",
      "description",
      "id",
      "image",
      "name",
      "priceAmountCents",
      "slug",
      "store",
    ]);
  });

  it("applies the default limit and an explicit cursor to the storefront page", async () => {
    await service.getStorefront("shop", undefined);
    await service.getStorefront("shop", { limit: "5", cursor: "1767312000000:x" });

    expect(repository.storeProductsCalls).toEqual([
      { storeSlug: "shop", limit: CATALOG_PAGE_LIMITS.default, cursor: null },
      { storeSlug: "shop", limit: 5, cursor: "1767312000000:x" },
    ]);
  });

  it("raises a 404 for an unknown or non-active store without listing products", async () => {
    const error = await service.getStorefront("missing", undefined).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(NotFoundError);
    const notFound = error as NotFoundError;
    expect(notFound.statusCode).toBe(404);
    expect(notFound.code).toBe("NOT_FOUND");
    expect(notFound.message).toBe("This store is not available.");
    expect(repository.storeProductsCalls).toHaveLength(0);
  });

  it("rejects a malformed storefront limit with a 422 field error", async () => {
    const error = await service
      .getStorefront("shop", { limit: "0" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).statusCode).toBe(422);
    expect((error as ValidationError).fields?.limit).toBeDefined();
    expect(repository.storeProductsCalls).toHaveLength(0);
  });
});