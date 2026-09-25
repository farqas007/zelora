import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@zelora/core";
import type { CatalogRepository } from "@zelora/db/catalog";
import type { ProductRepository } from "@zelora/db/products";
import type { CartRepository } from "@zelora/db/cart";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { ApiFailure } from "@zelora/shared";
import { createApp, type AppDependencies } from "../app";
import type { Clock } from "../services/clock";

/**
 * End-to-end route tests for the public storefront through the real composed
 * app (CORS + error boundary + handler + service), with the catalog repository
 * faked at the composition boundary and every other dependency inert. These
 * prove the route is anonymous, returns only public-safe fields, maps unknown/
 * inactive stores to 404, validates query params, and returns the shared
 * success/failure envelopes.
 */

const storefrontFixture = {
  store: {
    id: "store-1",
    slug: "shop",
    name: "Shop",
    description: "A cozy shop",
  },
  page: {
    items: [
      {
        id: "01955f00-0000-7000-8000-000000000011",
        slug: "camper",
        name: "Camper",
        description: "A cozy camper",
        store: { id: "store-1", slug: "shop", name: "Shop" },
        category: { id: "cat-1", slug: "campers", name: "Campers" },
        priceAmountCents: 1_500,
        compareAtAmountCents: null,
        currency: "USD",
        image: { url: "https://cdn.example.test/hero.jpg", altText: "Hero" },
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ],
    nextCursor: null,
  },
};

class FakeCatalogRepository implements CatalogRepository {
  storeOptions: Array<{ storeSlug: string; limit: number; cursor: string | null }> = [];

  async listActiveCategories() {
    return [];
  }

  async listActiveProducts() {
    return { items: [], nextCursor: null };
  }

  async findProductBySlug() {
    return null;
  }

  async findVariantById(_id: string) {
    return null;
  }

  async findActiveStoreBySlug(slug: string) {
    return slug === storefrontFixture.store.slug ? storefrontFixture.store : null;
  }

  async listStoreProducts(opts: { storeSlug: string; limit: number; cursor: string | null }) {
    this.storeOptions.push(opts);
    return storefrontFixture.page;
  }
}

const inert = (): never => {
  throw new Error("unexpected dependency call");
};

class FakeClock implements Clock {
  now(): Date {
    return new Date("2026-01-01T00:00:00.000Z");
  }
}

describe("storefront routes", () => {
  let app: ReturnType<typeof createApp>;
  let catalogRepository: FakeCatalogRepository;

  beforeEach(() => {
    catalogRepository = new FakeCatalogRepository();
    const dependencies: AppDependencies = {
      config: loadConfig({ NODE_ENV: "test" }),
      catalogRepository,
      userRepository: {
        create: inert,
        createAdmin: inert,
        findByEmail: inert,
        findById: inert,
      },
      sessionRepository: {
        create: inert,
        findByTokenHash: inert,
        deleteById: inert,
        deleteAllForUser: inert,
        updateLastUsedAt: inert,
        purgeExpired: inert,
      },
      sellerRepository: {
        findByUserId: inert,
        findByProfileSlug: inert,
        findStoreBySlug: inert,
        findStoreBySellerProfileId: inert,
        createOnboarding: inert,
        activateSeller: inert,
        listPendingProfiles: inert,
        rejectSeller: inert,
      },
      productRepository: {
        listByStore: inert,
        findByStoreAndId: inert,
        findByStoreAndSlug: inert,
        createProduct: inert,
        createVariant: inert,
        setInventory: inert,
        publishProduct: inert,
      } satisfies ProductRepository,
      auditLogRepository: {
        create: inert,
        listByAction: inert,
      } satisfies AuditLogRepository,
      cartRepository: {
        getCartByUserId: inert,
        createCart: inert,
        addItem: inert,
        updateItemQuantity: inert,
        removeItem: inert,
        clearCart: inert,
      } satisfies CartRepository,
      passwordHasher: { hash: inert, verify: inert },
      clock: new FakeClock(),
    };
    app = createApp(dependencies);
  });

  it("GET /api/stores/:slug returns the storefront envelope with public-safe store fields", async () => {
    const response = await app.request("/api/stores/shop");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: { store: Record<string, unknown>; products: { items: unknown[]; nextCursor: string | null } } };
    expect(body.ok).toBe(true);
    expect(body.data.store).toEqual({
      id: "store-1",
      slug: "shop",
      name: "Shop",
      description: "A cozy shop",
    });
    // Deliberately no seller-profile, ownership or status fields leak out.
    expect(Object.keys(body.data.store).sort()).toEqual(["description", "id", "name", "slug"]);
    expect(body.data.products.items).toHaveLength(1);
    expect(catalogRepository.storeOptions).toEqual([
      { storeSlug: "shop", limit: 20, cursor: null },
    ]);
  });

  it("forwards explicit limit and cursor query params to the per-store listing", async () => {
    const response = await app.request("/api/stores/shop?limit=5&cursor=1767312000000:x");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: { products: { nextCursor: string | null } } };
    expect(body.data.products.nextCursor).toBeNull();
    expect(catalogRepository.storeOptions).toEqual([
      { storeSlug: "shop", limit: 5, cursor: "1767312000000:x" },
    ]);
  });

  it("GET /api/stores/:slug for an unknown or non-active store returns a 404 NOT_FOUND", async () => {
    const response = await app.request("/api/stores/offline");

    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("This store is not available.");
    expect(catalogRepository.storeOptions).toHaveLength(0);
  });

  it("rejects a malformed limit with a 422 validation envelope including field errors", async () => {
    const response = await app.request("/api/stores/shop?limit=abc");

    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields?.limit).toBeDefined();
  });

  it("storefront reads are anonymous: no session cookie is required or set", async () => {
    const response = await app.request("/api/stores/shop");

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});