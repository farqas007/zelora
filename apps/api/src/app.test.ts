import { describe, expect, it } from "vitest";
import { loadConfig, type PasswordHasher } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { UserRepository } from "@zelora/db/users";
import type { SellerRepository } from "@zelora/db/seller";
import type { CatalogRepository } from "@zelora/db/catalog";
import type { ProductRepository } from "@zelora/db/products";
import type { CartRepository } from "@zelora/db/cart";
import { createApp, resolveAppMediaStorage, type AppDependencies } from "./app";
import type { Clock } from "./services/clock";
import type { MediaObjectInput, MediaStorage } from "./services/media/storage";

/**
 * Composition tests for the media storage port as `createApp` actually wires it.
 *
 * These exist because the fail-closed guarantee lives in the composition root,
 * not in the drivers: a deployment with no `MEDIA_PUBLIC_BASE_URL` must still
 * boot and serve every endpoint, and must additionally be unable to write,
 * delete or resolve any media. The drivers themselves are covered in
 * `services/media/storage.test.ts`; this file covers only the wiring.
 */

/**
 * The repositories are inert: composing the app must not touch a database, and
 * an accidental call would surface as a loud failure rather than a silent pass.
 */
const unimplemented = (): never => {
  throw new Error("unexpected dependency call");
};

const clock: Clock = { now: () => new Date() };
const passwordHasher: PasswordHasher = { hash: unimplemented, verify: unimplemented };

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
  findStoreBySellerProfileId: unimplemented,
  createOnboarding: unimplemented,
  activateSeller: unimplemented,
  listPendingProfiles: unimplemented,
  rejectSeller: unimplemented,
};

const auditLogRepository: AuditLogRepository = { create: unimplemented, listByAction: unimplemented };

const catalogRepository: CatalogRepository = {
  listActiveCategories: unimplemented,
  listActiveProducts: unimplemented,
  findProductBySlug: unimplemented,
  findVariantById: unimplemented,
  findActiveStoreBySlug: unimplemented,
  listStoreProducts: unimplemented,
};

const productRepository: ProductRepository = {
  listByStore: unimplemented,
  findByStoreAndId: unimplemented,
  listImagesByProduct: unimplemented,
  findByStoreAndSlug: unimplemented,
  createProduct: unimplemented,
  createVariant: unimplemented,
  setInventory: unimplemented,
  publishProduct: unimplemented,
  addProductImages: unimplemented,
};

const cartRepository: CartRepository = {
  getCartByUserId: unimplemented,
  createCart: unimplemented,
  addItem: unimplemented,
  updateItemQuantity: unimplemented,
  removeItem: unimplemented,
  clearCart: unimplemented,
};

/** Dependencies with `mediaStorage` deliberately omitted, as an unconfigured deployment. */
function unconfiguredDependencies(): AppDependencies {
  return {
    config: loadConfig({ NODE_ENV: "test" }),
    userRepository,
    sessionRepository,
    sellerRepository,
    catalogRepository,
    productRepository,
    cartRepository,
    auditLogRepository,
    passwordHasher,
    clock,
  };
}

const MEDIA_OBJECT: MediaObjectInput = {
  bytes: new Uint8Array([1, 2, 3]).buffer,
  contentType: "image/jpeg",
  size: 3,
};

describe("createApp media storage composition", () => {
  it("serves requests when no mediaStorage is supplied, so an unconfigured app still boots", async () => {
    const app = createApp(unconfiguredDependencies());

    const response = await app.request("/api/health");

    // The point of the test: a deployment without media storage must be fully
    // usable, not degraded or crashed at composition time.
    expect(response.status).toBe(200);
  });

  it("installs a fail-closed storage that refuses to write when unconfigured", async () => {
    const storage = resolveAppMediaStorage(undefined);

    // A permissive default would accept an upload, drop the bytes, and store a
    // URL that 404s — silent data loss visible only as broken images in
    // production. Failing loudly keeps the misconfiguration detectable.
    await expect(storage.put("products/a.jpg", MEDIA_OBJECT)).rejects.toThrow(/not configured/);
  });

  it("installs a fail-closed storage that refuses to delete when unconfigured", async () => {
    await expect(resolveAppMediaStorage(undefined).delete("products/a.jpg")).rejects.toThrow(
      /not configured/,
    );
  });

  it("installs a fail-closed storage that refuses to build a public URL", () => {
    // Deliberately a thrown error rather than a placeholder URL: a dead URL
    // would persist into a `product_images.url` row and be nearly impossible to
    // distinguish from real data later.
    expect(() => resolveAppMediaStorage(undefined).publicUrl("products/a.jpg")).toThrow(
      /not configured/,
    );
  });

  it("uses the supplied storage verbatim when one is provided", () => {
    const supplied: MediaStorage = {
      put: async () => undefined,
      delete: async () => undefined,
      publicUrl: (key: string) => `https://media.test/${key}`,
    };

    expect(resolveAppMediaStorage(supplied)).toBe(supplied);
  });
});
