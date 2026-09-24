import { beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "@zelora/core";
import { loadConfig } from "@zelora/core";
import type { CatalogRepository } from "@zelora/db/catalog";
import type { CartRepository } from "@zelora/db/cart";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { ApiFailure } from "@zelora/shared";
import { createApp, type AppDependencies } from "../app";
import type { Clock } from "../services/clock";

/**
 * End-to-end route tests for the public catalog through the real composed app
 * (CORS + error boundary + handler + service), with the catalog repository
 * faked at the composition boundary and every other dependency inert. These
 * prove the routes are anonymous, validate query params through the service,
 * and return the shared success/failure envelopes.
 */

function at(time: string): Date {
  return new Date(time);
}

const summaryFixture = {
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
  createdAt: at("2026-03-01T00:00:00.000Z"),
};

const detailFixture = {
  id: "01955f00-0000-7000-8000-000000000011",
  slug: "camper",
  name: "Camper",
  description: "A cozy camper",
  store: { id: "store-1", slug: "shop", name: "Shop" },
  category: { id: "cat-1", slug: "campers", name: "Campers" },
  variants: [
    { id: "01955f00-0000-7000-8000-000000000012", name: "Two-person", sku: "camper-t2", priceAmountCents: 1_500, compareAtAmountCents: null, currency: "USD" },
  ],
  images: [{ id: "01955f00-0000-7000-8000-000000000013", url: "https://cdn.example.test/hero.jpg", altText: "Hero", sortOrder: 0, isPrimary: true }],
};

class FakeCatalogRepository implements CatalogRepository {
  listOptions: Array<{ limit: number; cursor: string | null; categorySlug?: string }> = [];

  async listActiveCategories() {
    return [{ id: "cat-1", slug: "campers", name: "Campers" }];
  }

  async listActiveProducts(opts: { limit: number; cursor: string | null; categorySlug?: string }) {
    this.listOptions.push(opts);
    return { items: [summaryFixture], nextCursor: null };
  }

  async findProductBySlug(slug: string) {
    return slug === "camper" ? detailFixture : null;
  }

  async findVariantById(_id: string) {
    return null;
  }

  async findActiveStoreBySlug() {
    return null;
  }

  async listStoreProducts() {
    return { items: [], nextCursor: null };
  }
}

const inert = (): never => {
  throw new Error("unexpected dependency call");
};

class FakeClock implements Clock {
  now(): Date {
    return at("2026-01-01T00:00:00.000Z");
  }
}

describe("catalog routes", () => {
  let baseConfig: AppConfig;
  let catalogRepository: FakeCatalogRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    baseConfig = loadConfig({ NODE_ENV: "test" });
    catalogRepository = new FakeCatalogRepository();
    const dependencies: AppDependencies = {
      config: baseConfig,
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
        createOnboarding: inert,
        activateSeller: inert,
        listPendingProfiles: inert,
        rejectSeller: inert,
      },
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

  it("GET /api/catalog/categories returns the active categories envelope", async () => {
    const response = await app.request("/api/catalog/categories");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([{ id: "cat-1", slug: "campers", name: "Campers" }]);
  });

  it("GET /api/catalog/products returns the list envelope and forwards query params", async () => {
    const response = await app.request(
      "/api/catalog/products?limit=5&cursor=1767312000000:x&category=Campers",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: { items: unknown[]; nextCursor: string | null } };
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.nextCursor).toBeNull();
    expect(catalogRepository.listOptions).toEqual([
      { limit: 5, cursor: "1767312000000:x", categorySlug: "campers" },
    ]);
  });

  it("rejects a malformed limit with a 422 validation envelope including field errors", async () => {
    const response = await app.request("/api/catalog/products?limit=abc");

    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields?.limit).toBeDefined();
  });

  it("rejects an invalid category slug with a 422 field error", async () => {
    const response = await app.request("/api/catalog/products?category=not%20a%20slug!");

    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiFailure;
    expect(body.error.fields?.category).toBeDefined();
  });

  it("GET /api/catalog/products/:slug returns the detail envelope", async () => {
    const response = await app.request("/api/catalog/products/camper");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: typeof detailFixture };
    expect(body.data.variants).toHaveLength(1);
    expect(body.data.images[0]!.isPrimary).toBe(true);
  });

  it("GET /api/catalog/products/:slug for an unknown product returns a 404 NOT_FOUND", async () => {
    const response = await app.request("/api/catalog/products/missing");

    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("This product is not available.");
  });

  it("catalog reads are anonymous: no session cookie is required or set", async () => {
    const response = await app.request("/api/catalog/products");

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});