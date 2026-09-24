import { describe, expect, it } from "vitest";
import type { ApiFailure, HealthResponse } from "@zelora/shared";
import { loadConfig, type PasswordHasher } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { UserRepository } from "@zelora/db/users";
import type { SellerRepository } from "@zelora/db/seller";
import type { CatalogRepository } from "@zelora/db/catalog";
import type { CartRepository } from "@zelora/db/cart";
import { createApp, type AppDependencies } from "./app";
import type { Clock } from "./services/clock";

function makeTestConfig() {
  return loadConfig({ NODE_ENV: "test" });
}

/**
 * Health routes never touch auth repositories, password hashing or the clock.
 * These are inert stubs that fail loudly if anything ever calls them.
 */
const unimplemented = (): never => {
  throw new Error("unexpected dependency call");
};

const clock: Clock = { now: () => new Date() };

const passwordHasher: PasswordHasher = {
  hash: unimplemented,
  verify: unimplemented,
};

const userRepository: UserRepository = {
  create: unimplemented,
  createAdmin: unimplemented,
  findByEmail: unimplemented,
  findById: unimplemented,
};

const sessionRepository: AuthSessionRepository = {
  create: unimplemented,
  findByTokenHash: unimplemented,
  deleteById: unimplemented,
  deleteAllForUser: unimplemented,
  updateLastUsedAt: unimplemented,
  purgeExpired: unimplemented,
};

const sellerRepository: SellerRepository = {
  findByUserId: unimplemented,
  findByProfileSlug: unimplemented,
  findStoreBySlug: unimplemented,
  createOnboarding: unimplemented,
  activateSeller: unimplemented,
  listPendingProfiles: unimplemented,
  rejectSeller: unimplemented,
};

const auditLogRepository: AuditLogRepository = {
  create: unimplemented,
  listByAction: unimplemented,
};

const catalogRepository: CatalogRepository = {
  listActiveCategories: unimplemented,
  listActiveProducts: unimplemented,
  findProductBySlug: unimplemented,
  findVariantById: unimplemented,
  findActiveStoreBySlug: unimplemented,
  listStoreProducts: unimplemented,
};

const cartRepository: CartRepository = {
  getCartByUserId: unimplemented,
  createCart: unimplemented,
  addItem: unimplemented,
  updateItemQuantity: unimplemented,
  removeItem: unimplemented,
  clearCart: unimplemented,
};

function makeApp(): ReturnType<typeof createApp> {
  const config = makeTestConfig();
  const dependencies: AppDependencies = {
    config,
    userRepository,
    sessionRepository,
    sellerRepository,
    catalogRepository,
    cartRepository,
    auditLogRepository,
    passwordHasher,
    clock,
  };
  return createApp(dependencies);
}

describe("GET /api/health", () => {
  it("returns 200 with a typed success envelope", async () => {
    const app = makeApp();
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);

    const body = (await response.json()) as { ok: true; data: HealthResponse };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
    expect(body.data.service).toBe("zelora-api");
    expect(body.data.version).toBe("0.1.0");
    expect(Number.isNaN(Date.parse(body.data.timestamp))).toBe(false);
  });

  it("responds to unknown routes with a typed error envelope", async () => {
    const app = makeApp();
    const response = await app.request("/api/does-not-exist");

    expect(response.status).toBe(404);

    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
  });
});