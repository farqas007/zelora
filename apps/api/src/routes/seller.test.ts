import { beforeEach, describe, expect, it } from "vitest";
import { PBKDF2PasswordHasher, type AppConfig, type PasswordHasher } from "@zelora/core";
import type { AuthSessionRecord, AuthSessionRepository, CreateAuthSessionInput } from "@zelora/db/auth";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { UserRecord, UserRepository, CreateAdminResult, CreateUserInput } from "@zelora/db/users";
import type {
  CreateOnboardingInput,
  OnboardingConflictReason,
  SellerProfileRecord,
  SellerRepository,
  StoreRecord,
} from "@zelora/db/seller";
import type { CatalogRepository } from "@zelora/db/catalog";
import type {
  InventoryRecord,
  CreateVariantInput,
  CreateVariantResult,
  ProductDetailRecord,
  ProductImageRecord,
  ProductListPage,
  ProductListQuery,
  ProductRepository,
  ProductRecord,
  ProductVariantDetailRecord,
  CreateProductInput,
  PublishProductResult,
  SetInventoryInput,
  SetInventoryResult,
  VariantRecord,
} from "@zelora/db/products";
import type { CartRepository } from "@zelora/db/cart";
import type { ApiFailure, AuthUserResponse } from "@zelora/shared";
import { createApp } from "../app";
import type { Clock } from "../services/clock";
import type { ClientIpResolver } from "../services/client-ip";
import { MemoryWindowRateLimiter } from "../services/rate-limit";

/**
 * End-to-end route tests for POST /api/seller/onboarding through the real
 * composed app (auth middleware + CSRF + IP rate limit + handler + service),
 * with the seller repository faked at the composition boundary.
 */

class FakeClock implements Clock {
  private currentTime: Date;

  constructor(startTime: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.currentTime = startTime;
  }

  now(): Date {
    return new Date(this.currentTime.getTime());
  }

  set(time: Date): void {
    this.currentTime = new Date(time.getTime());
  }
}

class FakeUserRepository implements UserRepository {
  private users: Map<string, UserRecord> = new Map();
  private usersByEmail: Map<string, UserRecord> = new Map();
  private nextId = 1;

  async create(input: {
    email: string;
    name: string;
    passwordHash: string;
    role?: UserRecord["role"];
  }): Promise<UserRecord> {
    const now = new Date();
    const record: UserRecord = {
      id: `user-${this.nextId++}`,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? "customer",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(record.id, record);
    this.usersByEmail.set(record.email, record);
    return record;
  }

  async createAdmin(input: CreateUserInput): Promise<CreateAdminResult> {
    return { ok: true, user: await this.create(input) };
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.usersByEmail.get(email) ?? null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  setUser(record: UserRecord): void {
    this.users.set(record.id, record);
    this.usersByEmail.set(record.email, record);
  }

  getUser(id: string): UserRecord | undefined {
    return this.users.get(id);
  }

  clear(): void {
    this.users.clear();
    this.usersByEmail.clear();
    this.nextId = 1;
  }
}

class FakeAuthSessionRepository implements AuthSessionRepository {
  private sessions: Map<string, AuthSessionRecord> = new Map();
  private nextId = 1;

  async create(input: CreateAuthSessionInput): Promise<AuthSessionRecord> {
    const record: AuthSessionRecord = {
      id: `session-${this.nextId++}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      csrfToken: input.csrfToken,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      lastUsedAt: null,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    for (const session of this.sessions.values()) {
      if (session.tokenHash === tokenHash) {
        return session;
      }
    }
    return null;
  }

  async deleteById(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async deleteAllForUser(userId: string): Promise<number> {
    let count = 0;
    for (const [id, session] of Array.from(this.sessions.entries())) {
      if (session.userId === userId) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  async updateLastUsedAt(id: string, lastUsedAt: Date): Promise<boolean> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return false;
    }
    session.lastUsedAt = lastUsedAt;
    return true;
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    let count = 0;
    for (const [id, session] of Array.from(this.sessions.entries())) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  getSessionsForUser(userId: string): AuthSessionRecord[] {
    return Array.from(this.sessions.values()).filter((session) => session.userId === userId);
  }

  clear(): void {
    this.sessions.clear();
    this.nextId = 1;
  }
}

class FakeSellerRepository implements SellerRepository {
  private profiles: Map<string, SellerProfileRecord> = new Map();
  private stores: Map<string, StoreRecord> = new Map();
  private nextId = 1;

  createCalls: CreateOnboardingInput[] = [];
  forceConflict: OnboardingConflictReason | null = null;

  async findByUserId(userId: string): Promise<SellerProfileRecord | null> {
    return Array.from(this.profiles.values()).find((profile) => profile.userId === userId) ?? null;
  }

  async findByProfileSlug(slug: string): Promise<SellerProfileRecord | null> {
    return Array.from(this.profiles.values()).find((profile) => profile.slug === slug) ?? null;
  }

  async findStoreBySlug(slug: string): Promise<StoreRecord | null> {
    return Array.from(this.stores.values()).find((store) => store.slug === slug) ?? null;
  }

  async findStoreBySellerProfileId(sellerProfileId: string): Promise<StoreRecord | null> {
    return Array.from(this.stores.values()).find((store) => store.sellerProfileId === sellerProfileId) ?? null;
  }

  async createOnboarding(input: CreateOnboardingInput): Promise<
    | { ok: true; sellerProfile: SellerProfileRecord; store: StoreRecord }
    | { ok: false; reason: OnboardingConflictReason }
  > {
    this.createCalls.push(input);
    if (this.forceConflict !== null) {
      return { ok: false, reason: this.forceConflict };
    }
    if (Array.from(this.profiles.values()).some((profile) => profile.userId === input.userId)) {
      return { ok: false, reason: "SELLER_PROFILE_EXISTS" };
    }
    if (Array.from(this.profiles.values()).some((profile) => profile.slug === input.profileSlug)) {
      return { ok: false, reason: "PROFILE_SLUG_IN_USE" };
    }
    if (Array.from(this.stores.values()).some((store) => store.slug === input.storeSlug)) {
      return { ok: false, reason: "STORE_SLUG_IN_USE" };
    }

    const profileId = `sp-${this.nextId}`;
    const storeId = `st-${this.nextId}`;
    this.nextId += 1;
    const now = new Date();
    const sellerProfile: SellerProfileRecord = {
      id: profileId,
      userId: input.userId,
      slug: input.profileSlug,
      displayName: input.displayName,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const store: StoreRecord = {
      id: storeId,
      sellerProfileId: profileId,
      name: input.storeName,
      slug: input.storeSlug,
      description: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.profiles.set(profileId, sellerProfile);
    this.stores.set(storeId, store);
    return { ok: true, sellerProfile, store };
  }

  seedProfile(profile: SellerProfileRecord): void {
    this.profiles.set(profile.id, profile);
  }

  seedStore(store: StoreRecord): void {
    this.stores.set(store.id, store);
  }

  async activateSeller(userId: string): Promise<{
    sellerProfile: SellerProfileRecord;
    store: StoreRecord;
  } | null> {
    const profile = Array.from(this.profiles.values()).find((candidate) => candidate.userId === userId);
    if (profile === undefined) {
      return null;
    }
    const store = Array.from(this.stores.values()).find((candidate) => candidate.sellerProfileId === profile.id);
    const sellerProfile: SellerProfileRecord = { ...profile, status: "active" };
    this.profiles.set(profile.id, sellerProfile);
    if (store === undefined) {
      throw new Error("seller profile has no store to activate");
    }
    return { sellerProfile, store };
  }

  async listPendingProfiles(): Promise<{ items: never[]; nextCursor: null }> {
    throw new Error("pending list is not exercised by seller onboarding tests");
  }

  async rejectSeller(userId: string): Promise<SellerProfileRecord | null> {
    const profile = Array.from(this.profiles.values()).find(
      (candidate) => candidate.userId === userId && candidate.status === "pending",
    );
    if (profile === undefined) {
      return null;
    }
    const sellerProfile: SellerProfileRecord = { ...profile, status: "rejected" };
    this.profiles.set(profile.id, sellerProfile);
    return sellerProfile;
  }

  clear(): void {
    this.profiles.clear();
    this.stores.clear();
    this.nextId = 1;
    this.createCalls = [];
    this.forceConflict = null;
  }
}

/** Deterministic canonical UUIDv7-shaped id so route-level `isValidId` checks accept fake records. */
function fakeId(seq: number): string {
  return `01955f00-0000-7000-8000-${seq.toString(16).padStart(12, "0")}`;
}

/** Working product-repository fake: slug uniqueness per store, SKU uniqueness global. */
class FakeProductRepository implements ProductRepository {
  private products: Map<string, ProductRecord> = new Map();
  private variants: Map<string, VariantRecord> = new Map();
  private inventory: Map<string, InventoryRecord> = new Map();
  private images: Map<string, ProductImageRecord> = new Map();
  private nextId = 1;

  createCalls: CreateProductInput[] = [];
  createVariantCalls: CreateVariantInput[] = [];
  setInventoryCalls: SetInventoryInput[] = [];
  listCalls: Array<{ storeId: string; query: ProductListQuery }> = [];
  listImagesCalls: Array<{ productId: string; storeId: string }> = [];
  forceCreateConflict: boolean = false;
  forceSkuConflict: boolean = false;

  async listByStore(storeId: string, query: ProductListQuery): Promise<ProductListPage> {
    this.listCalls.push({ storeId, query });
    const owned = Array.from(this.products.values())
      .filter((product) => product.storeId === storeId)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
      );
    const items = owned.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        owned.length > query.limit && last !== undefined ? `next:${last.id}` : null,
    };
  }

  async findByStoreAndId(storeId: string, productId: string): Promise<ProductDetailRecord | null> {
    const product = this.products.get(productId);
    if (product === undefined || product.storeId !== storeId) {
      return null;
    }
    const variants: ProductVariantDetailRecord[] = Array.from(this.variants.values())
      .filter((variant) => variant.productId === productId)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((variant) => ({ ...variant, inventory: this.inventory.get(variant.id) ?? null }));
    return { ...product, variants, images: this.collectImages(productId, storeId) };
  }

  async listImagesByProduct(productId: string, storeId: string): Promise<ProductImageRecord[]> {
    this.listImagesCalls.push({ productId, storeId });
    return this.collectImages(productId, storeId);
  }

  /**
   * Mirrors the real drivers: ownership is resolved by joining through
   * `products.storeId`, and the order is primary first, then `sortOrder`
   * ascending, then `id` ascending. A product owned by another store yields
   * nothing at all.
   */
  private collectImages(productId: string, storeId: string): ProductImageRecord[] {
    const product = this.products.get(productId);
    if (product === undefined || product.storeId !== storeId) {
      return [];
    }
    return Array.from(this.images.values())
      .filter((image) => image.productId === productId)
      .sort(
        (left, right) =>
          Number(right.isPrimary) - Number(left.isPrimary) ||
          left.sortOrder - right.sortOrder ||
          left.id.localeCompare(right.id),
      );
  }

  async findByStoreAndSlug(storeId: string, slug: string): Promise<ProductRecord | null> {
    return (
      Array.from(this.products.values()).find(
        (product) => product.storeId === storeId && product.slug === slug,
      ) ?? null
    );
  }

  async createProduct(input: CreateProductInput): Promise<
    { ok: true; product: ProductRecord } | { ok: false; reason: "PRODUCT_SLUG_IN_USE" }
  > {
    this.createCalls.push(input);
    if (this.forceCreateConflict) {
      return { ok: false, reason: "PRODUCT_SLUG_IN_USE" };
    }
    const existing = await this.findByStoreAndSlug(input.storeId, input.slug);
    if (existing !== null) {
      return { ok: false, reason: "PRODUCT_SLUG_IN_USE" };
    }
    const now = new Date();
    const product: ProductRecord = {
      id: fakeId(this.nextId++),
      storeId: input.storeId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      categoryId: input.categoryId,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.products.set(product.id, product);
    return { ok: true, product };
  }

  async createVariant(input: CreateVariantInput): Promise<CreateVariantResult> {
    this.createVariantCalls.push(input);
    if (this.forceSkuConflict) {
      return { ok: false, reason: "SKU_IN_USE" };
    }
    const product = this.products.get(input.productId);
    if (product === undefined || product.storeId !== input.storeId) {
      return { ok: false, reason: "PRODUCT_NOT_FOUND" };
    }
    if (input.sku !== null) {
      const skuInUse = Array.from(this.variants.values()).some(
        (variant) => variant.sku !== null && variant.sku === input.sku,
      );
      if (skuInUse) {
        return { ok: false, reason: "SKU_IN_USE" };
      }
    }
    const now = new Date();
    const variant: VariantRecord = {
      id: fakeId(this.nextId++),
      productId: input.productId,
      sku: input.sku,
      name: input.name,
      priceAmountCents: input.priceAmountCents,
      compareAtAmountCents: input.compareAtAmountCents,
      currency: input.currency,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.variants.set(variant.id, variant);
    return { ok: true, variant };
  }

  async setInventory(input: SetInventoryInput): Promise<SetInventoryResult> {
    this.setInventoryCalls.push(input);
    const product = this.products.get(input.productId);
    const variant = this.variants.get(input.variantId);
    if (
      product === undefined ||
      variant === undefined ||
      variant.productId !== input.productId ||
      product.storeId !== input.storeId
    ) {
      return { ok: false, reason: "VARIANT_NOT_FOUND" };
    }
    const inventory: InventoryRecord = {
      variantId: input.variantId,
      quantity: input.quantity,
      updatedAt: new Date(),
    };
    this.inventory.set(input.variantId, inventory);
    return { ok: true, inventory };
  }

  async publishProduct(productId: string, storeId: string): Promise<PublishProductResult> {
    const product = this.products.get(productId);
    if (product === undefined || product.storeId !== storeId) {
      return { ok: false, reason: "PRODUCT_NOT_FOUND" };
    }
    if (product.status === "archived") {
      return { ok: false, reason: "PRODUCT_ARCHIVED" };
    }
    const sellable = Array.from(this.variants.values()).some(
      (variant) =>
        variant.productId === productId &&
        variant.status === "active" &&
        variant.priceAmountCents >= 1 &&
        (this.inventory.get(variant.id)?.quantity ?? 0) >= 1,
    );
    if (!sellable) {
      return { ok: false, reason: "NOT_PUBLISHABLE" };
    }
    const updated: ProductRecord = { ...product, status: "active", updatedAt: new Date() };
    this.products.set(productId, updated);
    return { ok: true, product: updated };
  }

  seedProduct(product: ProductRecord): void {
    this.products.set(product.id, product);
  }

  seedVariant(variant: VariantRecord): void {
    this.variants.set(variant.id, variant);
  }

  seedInventory(inventory: InventoryRecord): void {
    this.inventory.set(inventory.variantId, inventory);
  }

  seedImage(image: ProductImageRecord): void {
    this.images.set(image.id, image);
  }

  clear(): void {
    this.products.clear();
    this.variants.clear();
    this.inventory.clear();
    this.images.clear();
    this.nextId = 1;
    this.createCalls = [];
    this.createVariantCalls = [];
    this.setInventoryCalls = [];
    this.listCalls = [];
    this.listImagesCalls = [];
    this.forceCreateConflict = false;
    this.forceSkuConflict = false;
  }
}

/** Working catalog fake: only the active-category list is used by products. */
class FakeCatalogRepository implements CatalogRepository {
  categories: Array<{ id: string; slug: string; name: string }> = [];

  async listActiveCategories() {
    return this.categories;
  }

  async listActiveProducts() {
    return { items: [], nextCursor: null };
  }

  async findProductBySlug() {
    return null;
  }

  async findVariantById() {
    return null;
  }

  async findActiveStoreBySlug() {
    return null;
  }

  async listStoreProducts() {
    return { items: [], nextCursor: null };
  }

  clear(): void {
    this.categories = [];
  }
}

describe("POST /api/seller/onboarding", () => {
  const baseConfig: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3001,
    appVersion: "0.1.0",
    corsOrigin: "http://localhost:5173",
    sessionCookieName: "zelora_session",
    sessionTtlSeconds: 2_592_000,
    sessionCookieSecure: false,
    pbkdf2Iterations: 1_000,
    rateLimitEnabled: true,
    rateLimitTrustProxy: false,
    rateLimitLoginIpMax: 20,
    rateLimitLoginIpWindowSeconds: 900,
    rateLimitLoginEmailMax: 10,
    rateLimitLoginEmailWindowSeconds: 900,
    rateLimitRegisterIpMax: 10,
    rateLimitRegisterIpWindowSeconds: 3_600,
    rateLimitSellerOnboardingIpMax: 10,
    rateLimitSellerOnboardingIpWindowSeconds: 3_600,
    rateLimitProductCreateIpMax: 30,
    rateLimitProductCreateIpWindowSeconds: 3_600,
        sessionLastUsedThrottleSeconds: 300,
    sessionPurgeIntervalSeconds: 3_600,
    adminBootstrapSecret: null,
  };

  const headerIpResolver: ClientIpResolver = {
    resolve: (c) => c.req.header("x-test-ip") ?? undefined,
  };

  /**
   * Seller route tests never hit the catalog, but `createApp` composes it. Any
   * accidental invocation would reveal a wiring bug loudly.
   */
  const inertCatalogRepository: CatalogRepository = {
    listActiveCategories: () => {
      throw new Error("unexpected catalog call");
    },
    listActiveProducts: () => {
      throw new Error("unexpected catalog call");
    },
    findProductBySlug: () => {
      throw new Error("unexpected catalog call");
    },
    findVariantById: () => {
      throw new Error("unexpected catalog call");
    },
    findActiveStoreBySlug: () => {
      throw new Error("unexpected catalog call");
    },
    listStoreProducts: () => {
      throw new Error("unexpected catalog call");
    },
  };

  /**
   * Cart routes are composed by `createApp` but never reached by seller route
   * tests. Any accidental invocation would reveal a wiring bug loudly.
   */
  const inertCartRepository: CartRepository = {
    getCartByUserId: () => {
      throw new Error("unexpected cart call");
    },
    createCart: () => {
      throw new Error("unexpected cart call");
    },
    addItem: () => {
      throw new Error("unexpected cart call");
    },
    updateItemQuantity: () => {
      throw new Error("unexpected cart call");
    },
    removeItem: () => {
      throw new Error("unexpected cart call");
    },
    clearCart: () => {
      throw new Error("unexpected cart call");
    },
  };

  const inertProductRepository: ProductRepository = {
    listByStore: () => {
      throw new Error("unexpected product call");
    },
    findByStoreAndId: () => {
      throw new Error("unexpected product call");
    },
    listImagesByProduct: () => {
      throw new Error("unexpected product call");
    },
    findByStoreAndSlug: () => {
      throw new Error("unexpected product call");
    },
    createProduct: () => {
      throw new Error("unexpected product call");
    },
    createVariant: () => {
      throw new Error("unexpected product call");
    },
    setInventory: () => {
      throw new Error("unexpected product call");
    },
    publishProduct: () => {
      throw new Error("unexpected product call");
    },
  };

  const inertAuditLogRepository: AuditLogRepository = {
    create: () => {
      throw new Error("unexpected audit log call");
    },
    listByAction: () => {
      throw new Error("unexpected audit log call");
    },
  };

  let clock: FakeClock;
  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let sellerRepository: FakeSellerRepository;
  let passwordHasher: PasswordHasher;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clock = new FakeClock();
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();
    sellerRepository = new FakeSellerRepository();
    passwordHasher = new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations);
    app = createApp({
      config: baseConfig,
      userRepository,
      sessionRepository,
      sellerRepository,
      catalogRepository: inertCatalogRepository,
      productRepository: inertProductRepository,
      cartRepository: inertCartRepository,
      auditLogRepository: inertAuditLogRepository,
      passwordHasher,
      clock,
      clientIpResolver: headerIpResolver,
    });
  });

  const validBody = {
    slug: "ada-shop",
    displayName: "Ada Lovelace",
    storeName: "Ada's Store",
    storeSlug: "ada-store",
  };

  function postJson(
    path: string,
    body: unknown,
    cookie?: string,
    csrfToken?: string,
    ip?: string,
    api: ReturnType<typeof createApp> = app,
  ) {
    return api.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie === undefined ? {} : { Cookie: cookie }),
        ...(csrfToken === undefined ? {} : { "X-Zelora-CSRF": csrfToken }),
        ...(ip === undefined ? {} : { "X-Test-IP": ip }),
      },
      body: JSON.stringify(body),
    });
  }

  function extractSessionCookie(response: Response): string {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie === null) {
      throw new Error("expected a set-cookie header");
    }
    return setCookie.split(";")[0] ?? "";
  }

  async function registerSession(
    email = "user@example.com",
  ): Promise<{
    cookie: string;
    csrfToken: string;
    userId: string;
  }> {
    const response = await postJson("/api/auth/register", {
      email,
      password: "password123",
      name: "Ada Lovelace",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: AuthUserResponse };
    return {
      cookie: extractSessionCookie(response),
      csrfToken: body.data.session.csrfToken,
      userId: body.data.user.id,
    };
  }

  async function expectOnboardFailure(
    response: Response,
    code: string,
    status: number,
  ): Promise<ApiFailure> {
    expect(response.status).toBe(status);
    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(code);
    return body;
  }

  it("A: unauthenticated request returns 401", async () => {
    const response = await postJson("/api/seller/onboarding", validBody);

    await expectOnboardFailure(response, "SESSION_EXPIRED", 401);
    expect(sellerRepository.createCalls).toHaveLength(0);
  });

  it("B: missing CSRF returns 403 CSRF_FAILED and nothing is created", async () => {
    const { cookie } = await registerSession();

    const response = await postJson("/api/seller/onboarding", validBody, cookie);

    const body = await expectOnboardFailure(response, "CSRF_FAILED", 403);
    expect(body.error.message).toBe("CSRF validation failed.");
    expect(sellerRepository.createCalls).toHaveLength(0);
  });

  it("B: wrong CSRF returns 403 CSRF_FAILED and nothing is created", async () => {
    const { cookie } = await registerSession();

    const response = await postJson("/api/seller/onboarding", validBody, cookie, "wrong-token");

    const body = await expectOnboardFailure(response, "CSRF_FAILED", 403);
    expect(body.error.message).toBe("CSRF validation failed.");
    expect(sellerRepository.createCalls).toHaveLength(0);
  });

  it("C: valid CSRF proceeds and returns 201", async () => {
    const { cookie, csrfToken, userId } = await registerSession();

    const response = await postJson("/api/seller/onboarding", validBody, cookie, csrfToken);

    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: { sellerProfile: Record<string, unknown>; store: Record<string, unknown> } };
    expect(body.ok).toBe(true);
    expect(body.data.sellerProfile.userId).toBe(userId);
    expect(body.data.sellerProfile.status).toBe("pending");
    expect(body.data.store.status).toBe("draft");
    expect(sellerRepository.createCalls).toHaveLength(1);
  });

  it("C: the response envelope matches the shared contract and leaks nothing sensitive", async () => {
    const { cookie, csrfToken } = await registerSession();

    const response = await postJson("/api/seller/onboarding", validBody, cookie, csrfToken);

    const raw = await response.text();
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("csrfToken");
    expect(raw).not.toContain("session");
    expect(raw).not.toContain("user_id");
    expect(raw).not.toContain("seller_profile_id");

    const body = JSON.parse(raw) as {
      ok: true;
      data: {
        sellerProfile: Record<string, unknown>;
        store: Record<string, unknown>;
      };
    };
    expect(Object.keys(body.data.sellerProfile).sort()).toEqual([
      "displayName",
      "id",
      "slug",
      "status",
      "userId",
    ]);
    expect(Object.keys(body.data.store).sort()).toEqual([
      "description",
      "id",
      "name",
      "slug",
      "status",
    ]);
  });

  it("D: spoofed userId/role/status cannot escalate the authenticated identity", async () => {
    const { cookie, csrfToken, userId } = await registerSession();

    const response = await postJson(
      "/api/seller/onboarding",
      { ...validBody, userId: "another-user", role: "seller", status: "active" },
      cookie,
      csrfToken,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: { sellerProfile: Record<string, unknown> } };
    expect(body.data.sellerProfile.userId).toBe(userId);

    const storedUser = userRepository.getUser(userId);
    expect(storedUser?.role).toBe("customer");
    expect(storedUser?.status).toBe("active");
    expect(sellerRepository.createCalls[0]).not.toHaveProperty("role");
    expect(sellerRepository.createCalls[0]).not.toHaveProperty("status");
    expect(sellerRepository.createCalls[0]?.userId).toBe(userId);
  });

  it("D: duplicate seller profile returns 409 SELLER_PROFILE_EXISTS", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    sellerRepository.seedProfile({
      id: "sp-existing",
      userId,
      slug: "existing-shop",
      displayName: "Existing",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await postJson("/api/seller/onboarding", validBody, cookie, csrfToken);

    const body = await expectOnboardFailure(response, "SELLER_PROFILE_EXISTS", 409);
    expect(body.error.message).toBe("You already have a seller profile.");
    expect(sellerRepository.createCalls).toHaveLength(0);
  });

  it("D: a taken profile slug returns 409 SLUG_IN_USE", async () => {
    const { cookie, csrfToken } = await registerSession();
    sellerRepository.seedProfile({
      id: "sp-existing",
      userId: "user-other",
      slug: "ada-shop",
      displayName: "Existing",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await postJson("/api/seller/onboarding", validBody, cookie, csrfToken);

    const body = await expectOnboardFailure(response, "SLUG_IN_USE", 409);
    expect(body.error.message).toBe("A seller profile with this slug already exists.");
    expect(sellerRepository.createCalls).toHaveLength(0);
  });

  it("D: a taken store slug returns 409 SLUG_IN_USE", async () => {
    const { cookie, csrfToken } = await registerSession();
    sellerRepository.seedStore({
      id: "st-existing",
      sellerProfileId: "sp-existing",
      name: "Existing",
      slug: "ada-store",
      description: null,
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await postJson("/api/seller/onboarding", validBody, cookie, csrfToken);

    const body = await expectOnboardFailure(response, "SLUG_IN_USE", 409);
    expect(body.error.message).toBe("A store with this slug already exists.");
    expect(sellerRepository.createCalls).toHaveLength(0);
  });

  it("D: a conflict surfacing on the transactional insert still returns 409 SLUG_IN_USE", async () => {
    const { cookie, csrfToken } = await registerSession();
    sellerRepository.forceConflict = "STORE_SLUG_IN_USE";

    const response = await postJson("/api/seller/onboarding", validBody, cookie, csrfToken);

    await expectOnboardFailure(response, "SLUG_IN_USE", 409);
    expect(sellerRepository.createCalls).toHaveLength(1);
  });

  it("E: a suspended account cannot onboard", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    const user = userRepository.getUser(userId)!;
    userRepository.setUser({ ...user, status: "suspended" });

    const response = await postJson("/api/seller/onboarding", validBody, cookie, csrfToken);

    const body = await expectOnboardFailure(response, "ACCOUNT_SUSPENDED", 403);
    expect(body.error.message).toBe("This account has been suspended.");
    expect(sellerRepository.createCalls).toHaveLength(0);
  });

  it("E: a deleted account cannot onboard", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    const user = userRepository.getUser(userId)!;
    userRepository.setUser({ ...user, status: "deleted" });

    const response = await postJson("/api/seller/onboarding", validBody, cookie, csrfToken);

    const body = await expectOnboardFailure(response, "ACCOUNT_DELETED", 403);
    expect(body.error.message).toBe("This account has been deleted.");
    expect(sellerRepository.createCalls).toHaveLength(0);
  });

  it("F: invalid input returns 422 with per-field errors and creates nothing", async () => {
    const { cookie, csrfToken } = await registerSession();

    const response = await postJson(
      "/api/seller/onboarding",
      { slug: "INVALID SLUG", storeSlug: "BAD STORE", displayName: "", storeName: "" },
      cookie,
      csrfToken,
    );

    const body = await expectOnboardFailure(response, "VALIDATION_ERROR", 422);
    expect(body.error.fields?.slug).toBeDefined();
    expect(body.error.fields?.storeSlug).toBeDefined();
    expect(body.error.fields?.displayName).toBeDefined();
    expect(body.error.fields?.storeName).toBeDefined();
    expect(sellerRepository.createCalls).toHaveLength(0);
  });

  it("G: malformed JSON fails validation and creates nothing", async () => {
    const { cookie, csrfToken } = await registerSession();

    const response = await app.request("/api/seller/onboarding", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Zelora-CSRF": csrfToken,
      },
      body: "not-json",
    });

    const body = await expectOnboardFailure(response, "VALIDATION_ERROR", 422);
    expect(body.error.fields?.body).toBeDefined();
    expect(sellerRepository.createCalls).toHaveLength(0);
  });

  it("H: existing auth endpoints remain functional on the same app", async () => {
    const registerResponse = await postJson("/api/auth/register", {
      email: "user@example.com",
      password: "password123",
      name: "Ada Lovelace",
    });
    expect(registerResponse.status).toBe(201);
    const cookie = extractSessionCookie(registerResponse);

    const me = await app.request("/api/auth/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);

    const login = await postJson("/api/auth/login", {
      email: "user@example.com",
      password: "password123",
    });
    expect(login.status).toBe(200);

    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
  });

  describe("onboarding IP rate limit", () => {
    function makeLimitedApp(
      overrides: Partial<AppConfig> = {},
    ): { app: ReturnType<typeof createApp>; limiter: MemoryWindowRateLimiter } {
      const limiter = new MemoryWindowRateLimiter(clock);
      const limitedApp = createApp({
        config: {
          ...baseConfig,
          rateLimitSellerOnboardingIpMax: 2,
          rateLimitSellerOnboardingIpWindowSeconds: 3_600,
          ...overrides,
        },
        userRepository,
        sessionRepository,
        sellerRepository,
        catalogRepository: inertCatalogRepository,
        productRepository: inertProductRepository,
        cartRepository: inertCartRepository,
        auditLogRepository: inertAuditLogRepository,
        passwordHasher,
        clock,
        rateLimiter: limiter,
        clientIpResolver: headerIpResolver,
      });
      return { app: limitedApp, limiter };
    }

    /**
     * Onboarding is a one-shot action per user (the service rejects a second
     * profile and consumes a slug the moment it is taken), so each rate-limit
     * attempt registers a brand-new authenticated user AND uses fresh slugs.
     * That proves the request was only ever clipped by the per-IP limit.
     */
    const uniqueBody = (index: number) => ({
      slug: `shop${index}`,
      displayName: "Ada Lovelace",
      storeName: `Store ${index}`,
      storeSlug: `store${index}`,
    });

    it("I: over-limit IP returns 429 RATE_LIMITED with Retry-After", async () => {
      const { app: limitedApp } = makeLimitedApp();

      for (let i = 0; i < 2; i += 1) {
        const session = await registerSession(`user${i}@example.com`);
        const response = await postJson("/api/seller/onboarding", uniqueBody(i), session.cookie, session.csrfToken, "203.0.113.66", limitedApp);
        expect(response.status).toBe(201);
      }

      const session3 = await registerSession("user2@example.com");
      const blocked = await postJson("/api/seller/onboarding", uniqueBody(2), session3.cookie, session3.csrfToken, "203.0.113.66", limitedApp);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("3600");
      const body = (await blocked.json()) as ApiFailure;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(body.error.details).toEqual({ retryAfterSeconds: 3600, scope: "ip" });
    });

    it("I: a different IP is unaffected by the seller-onboarding limit", async () => {
      const { app: limitedApp } = makeLimitedApp();

      for (let i = 0; i < 2; i += 1) {
        const session = await registerSession(`user${i}@example.com`);
        expect(
(await postJson("/api/seller/onboarding", uniqueBody(i), session.cookie, session.csrfToken, "203.0.113.67", limitedApp)).status,
      ).toBe(201);
      }

      const session3 = await registerSession("user2@example.com");
      expect(
        (await postJson("/api/seller/onboarding", uniqueBody(2), session3.cookie, session3.csrfToken, "203.0.113.67", limitedApp)).status,
      ).toBe(429);

      const session4 = await registerSession("user3@example.com");
      expect(
        (await postJson("/api/seller/onboarding", uniqueBody(3), session4.cookie, session4.csrfToken, "198.51.100.67", limitedApp)).status,
      ).toBe(201);
    });

    it("I: onboarding continues when the global rate-limit switch is disabled", async () => {
      const { app: limitedApp } = makeLimitedApp({ rateLimitEnabled: false });

      for (let i = 0; i < 5; i += 1) {
        const session = await registerSession(`user${i}@example.com`);
        const response = await postJson("/api/seller/onboarding", uniqueBody(i), session.cookie, session.csrfToken, "203.0.113.68", limitedApp);
        expect(response.status).toBe(201);
      }
    });
  });
});

describe("/api/seller/products", () => {
  const baseConfig: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3001,
    appVersion: "0.1.0",
    corsOrigin: "http://localhost:5173",
    sessionCookieName: "zelora_session",
    sessionTtlSeconds: 2_592_000,
    sessionCookieSecure: false,
    pbkdf2Iterations: 1_000,
    rateLimitEnabled: true,
    rateLimitTrustProxy: false,
    rateLimitLoginIpMax: 20,
    rateLimitLoginIpWindowSeconds: 900,
    rateLimitLoginEmailMax: 10,
    rateLimitLoginEmailWindowSeconds: 900,
    rateLimitRegisterIpMax: 10,
    rateLimitRegisterIpWindowSeconds: 3_600,
    rateLimitSellerOnboardingIpMax: 10,
    rateLimitSellerOnboardingIpWindowSeconds: 3_600,
    rateLimitProductCreateIpMax: 2,
    rateLimitProductCreateIpWindowSeconds: 3_600,
    sessionLastUsedThrottleSeconds: 300,
    sessionPurgeIntervalSeconds: 3_600,
    adminBootstrapSecret: null,
  };

  const headerIpResolver: ClientIpResolver = {
    resolve: (c) => c.req.header("x-test-ip") ?? undefined,
  };

  const inertAuditLogRepository: AuditLogRepository = {
    create: () => {
      throw new Error("unexpected audit log call");
    },
    listByAction: () => {
      throw new Error("unexpected audit log call");
    },
  };

  const inertCartRepository: CartRepository = {
    getCartByUserId: () => {
      throw new Error("unexpected cart call");
    },
    createCart: () => {
      throw new Error("unexpected cart call");
    },
    addItem: () => {
      throw new Error("unexpected cart call");
    },
    updateItemQuantity: () => {
      throw new Error("unexpected cart call");
    },
    removeItem: () => {
      throw new Error("unexpected cart call");
    },
    clearCart: () => {
      throw new Error("unexpected cart call");
    },
  };

  let clock: FakeClock;
  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let sellerRepository: FakeSellerRepository;
  let productRepository: FakeProductRepository;
  let catalogRepository: FakeCatalogRepository;
  let passwordHasher: PasswordHasher;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clock = new FakeClock();
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();
    sellerRepository = new FakeSellerRepository();
    productRepository = new FakeProductRepository();
    catalogRepository = new FakeCatalogRepository();
    catalogRepository.categories = [{ id: "01955f00-0000-7000-8000-000000000001", slug: "electronics", name: "Electronics" }];
    passwordHasher = new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations);
    app = createApp({
      config: baseConfig,
      userRepository,
      sessionRepository,
      sellerRepository,
      catalogRepository,
      productRepository,
      cartRepository: inertCartRepository,
      auditLogRepository: inertAuditLogRepository,
      passwordHasher,
      clock,
      clientIpResolver: headerIpResolver,
    });
  });

  function postJson(
    path: string,
    body: unknown,
    cookie?: string,
    csrfToken?: string,
    api: ReturnType<typeof createApp> = app,
  ) {
    return api.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie === undefined ? {} : { Cookie: cookie }),
        ...(csrfToken === undefined ? {} : { "X-Zelora-CSRF": csrfToken }),
      },
      body: JSON.stringify(body),
    });
  }

  function get(
    path: string,
    cookie?: string,
    api: ReturnType<typeof createApp> = app,
  ) {
    return api.request(path, {
      method: "GET",
      headers: cookie === undefined ? {} : { Cookie: cookie },
    });
  }

  function extractSessionCookie(response: Response): string {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie === null) {
      throw new Error("expected a set-cookie header");
    }
    return setCookie.split(";")[0] ?? "";
  }

  async function registerUser(
    email = "seller@example.com",
  ): Promise<{ cookie: string; csrfToken: string; userId: string }> {
    const response = await postJson("/api/auth/register", {
      email,
      password: "password123",
      name: "Ada Lovelace",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: AuthUserResponse };
    return {
      cookie: extractSessionCookie(response),
      csrfToken: body.data.session.csrfToken,
      userId: body.data.user.id,
    };
  }

  /** Register a customer session, then promote it into an approved seller. */
  async function registerApprovedSeller(): Promise<{
    cookie: string;
    csrfToken: string;
    userId: string;
  }> {
    const session = await registerUser();
    const user = userRepository.getUser(session.userId)!;
    userRepository.setUser({ ...user, role: "seller" });
    const now = new Date();
    sellerRepository.seedProfile({
      id: "sp-approved",
      userId: session.userId,
      slug: "approved-shop",
      displayName: "Approved Seller",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    sellerRepository.seedStore({
      id: "st-approved",
      sellerProfileId: "sp-approved",
      name: "Approved Shop",
      slug: "approved-shop",
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return session;
  }

  async function expectCreateFailure(
    response: Response,
    code: string,
    status: number,
  ): Promise<ApiFailure> {
    expect(response.status).toBe(status);
    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(code);
    return body;
  }

  const validBody = {
    name: "Vintage Camera",
    slug: "vintage-camera",
    description: "A lovely film camera.",
    categoryId: "01955f00-0000-7000-8000-000000000001",
  };

  /** Seed a draft product owned by the approved store, returning its id. */
  function seedOwnedProduct(seq: number): string {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const productId = fakeId(seq);
    productRepository.seedProduct({
      id: productId,
      storeId: "st-approved",
      slug: `product-${seq}`,
      name: `Product ${seq}`,
      description: null,
      categoryId: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    return productId;
  }

  /** Seed one image row; `url` and `altText` are derived from the id by default. */
  function seedImage(input: {
    id: string;
    productId: string;
    sortOrder: number;
    isPrimary: boolean;
    url?: string;
    altText?: string | null;
  }): void {
    productRepository.seedImage({
      id: input.id,
      productId: input.productId,
      url: input.url ?? `https://cdn.test/${input.id}.jpg`,
      altText: input.altText ?? null,
      sortOrder: input.sortOrder,
      isPrimary: input.isPrimary,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
  }

  it("GET list rejects unauthenticated callers with 401", async () => {
    await expectCreateFailure(
      await get("/api/seller/products"),
      "SESSION_EXPIRED",
      401,
    );
    expect(productRepository.listCalls).toHaveLength(0);
  });

  it("GET list rejects authenticated customers with 403 FORBIDDEN", async () => {
    const session = await registerUser();

    await expectCreateFailure(
      await get("/api/seller/products", session.cookie),
      "FORBIDDEN",
      403,
    );
    expect(productRepository.listCalls).toHaveLength(0);
  });

  it("GET list rejects a pending seller with SELLER_NOT_APPROVED", async () => {
    const session = await registerUser();
    const user = userRepository.getUser(session.userId)!;
    userRepository.setUser({ ...user, role: "seller" });
    const now = new Date();
    sellerRepository.seedProfile({
      id: "sp-pending-list",
      userId: session.userId,
      slug: "pending-list",
      displayName: "Pending Seller",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    sellerRepository.seedStore({
      id: "st-pending-list",
      sellerProfileId: "sp-pending-list",
      name: "Pending Store",
      slug: "pending-list",
      description: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });

    await expectCreateFailure(
      await get("/api/seller/products", session.cookie),
      "SELLER_NOT_APPROVED",
      403,
    );
    expect(productRepository.listCalls).toHaveLength(0);
  });

  it("GET list returns only the approved seller's bounded page and ignores spoofed storeId", async () => {
    const session = await registerApprovedSeller();
    const firstCreatedAt = new Date("2026-06-01T00:00:00.000Z");
    productRepository.seedProduct({
      id: fakeId(40),
      storeId: "st-approved",
      slug: "newest",
      name: "Newest",
      description: "private description",
      categoryId: null,
      status: "active",
      createdAt: firstCreatedAt,
      updatedAt: firstCreatedAt,
    });
    productRepository.seedProduct({
      id: fakeId(41),
      storeId: "st-approved",
      slug: "older",
      name: "Older",
      description: null,
      categoryId: null,
      status: "draft",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: firstCreatedAt,
    });
    productRepository.seedProduct({
      id: fakeId(42),
      storeId: "st-other",
      slug: "other",
      name: "Other",
      description: null,
      categoryId: null,
      status: "active",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: firstCreatedAt,
    });

    const response = await get(
      `/api/seller/products?limit=1&storeId=st-other`,
      session.cookie,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: true;
      data: { items: Array<Record<string, unknown>>; nextCursor: string | null };
    };
    expect(body.data.items).toEqual([
      {
        id: fakeId(40),
        slug: "newest",
        name: "Newest",
        categoryId: null,
        status: "active",
        createdAt: firstCreatedAt.toISOString(),
      },
    ]);
    expect(body.data.nextCursor).toBe(`next:${fakeId(40)}`);
    expect(productRepository.listCalls).toEqual([
      { storeId: "st-approved", query: { limit: 1, cursor: null } },
    ]);
    expect(JSON.stringify(body)).not.toContain("storeId");
    expect(JSON.stringify(body)).not.toContain("private description");
  });

  it("GET list validates the limit without querying the repository", async () => {
    const session = await registerApprovedSeller();

    await expectCreateFailure(
      await get("/api/seller/products?limit=51", session.cookie),
      "VALIDATION_ERROR",
      422,
    );
    expect(productRepository.listCalls).toHaveLength(0);
  });

  it("GET detail returns owned variants and inventory", async () => {
    const session = await registerApprovedSeller();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const productId = fakeId(50);
    const variantId = fakeId(51);
    productRepository.seedProduct({
      id: productId,
      storeId: "st-approved",
      slug: "detail",
      name: "Detail",
      description: "Owned detail",
      categoryId: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    productRepository.seedVariant({
      id: variantId,
      productId,
      sku: "DETAIL",
      name: "Detail variant",
      priceAmountCents: 1200,
      compareAtAmountCents: null,
      currency: "USD",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    productRepository.seedInventory({ variantId, quantity: 3, updatedAt: now });

    const response = await get(`/api/seller/products/${productId}`, session.cookie);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: true;
      data: {
        id: string;
        description: string | null;
        variants: Array<{ id: string; inventory: { quantity: number } | null }>;
      };
    };
    expect(body.data.id).toBe(productId);
    expect(body.data.description).toBe("Owned detail");
    expect(body.data.variants).toHaveLength(1);
    expect(body.data.variants[0]?.inventory).toMatchObject({ quantity: 3 });
    expect(JSON.stringify(body)).not.toContain("storeId");
  });

  it("GET detail embeds the product's images in canonical order", async () => {
    const session = await registerApprovedSeller();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const productId = fakeId(60);
    productRepository.seedProduct({
      id: productId,
      storeId: "st-approved",
      slug: "detail-images",
      name: "Detail Images",
      description: null,
      categoryId: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    seedImage({ id: fakeId(61), productId, sortOrder: 1, isPrimary: false });
    seedImage({ id: fakeId(62), productId, sortOrder: 0, isPrimary: true });

    const response = await get(`/api/seller/products/${productId}`, session.cookie);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: true;
      data: { images: Array<{ id: string; isPrimary: boolean }> };
    };
    expect(body.data.images.map((image) => image.id)).toEqual([fakeId(62), fakeId(61)]);
    expect(body.data.images[0]?.isPrimary).toBe(true);
  });

  it("GET images rejects unauthenticated callers with 401", async () => {
    const session = await registerApprovedSeller();
    const productId = seedOwnedProduct(70);

    await expectCreateFailure(
      await get(`/api/seller/products/${productId}/images`),
      "SESSION_EXPIRED",
      401,
    );
    expect(productRepository.listImagesCalls).toHaveLength(0);
    void session;
  });

  it("GET images rejects authenticated customers with 403 FORBIDDEN", async () => {
    const session = await registerUser();
    const productId = seedOwnedProduct(71);

    await expectCreateFailure(
      await get(`/api/seller/products/${productId}/images`, session.cookie),
      "FORBIDDEN",
      403,
    );
    expect(productRepository.listImagesCalls).toHaveLength(0);
  });

  it("GET images rejects a pending seller with SELLER_NOT_APPROVED", async () => {
    const session = await registerUser();
    const user = userRepository.getUser(session.userId)!;
    userRepository.setUser({ ...user, role: "seller" });
    const now = new Date();
    sellerRepository.seedProfile({
      id: "sp-pending-images",
      userId: session.userId,
      slug: "pending-images",
      displayName: "Pending Seller",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    sellerRepository.seedStore({
      id: "st-pending-images",
      sellerProfileId: "sp-pending-images",
      name: "Pending Store",
      slug: "pending-images",
      description: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    const productId = seedOwnedProduct(72);

    await expectCreateFailure(
      await get(`/api/seller/products/${productId}/images`, session.cookie),
      "SELLER_NOT_APPROVED",
      403,
    );
    expect(productRepository.listImagesCalls).toHaveLength(0);
  });

  it("GET images returns the seller's own images ordered primary-first, then sortOrder, then id", async () => {
    const session = await registerApprovedSeller();
    const productId = seedOwnedProduct(80);
    // Seeded out of order on purpose: the response order must come from the
    // canonical sort, not from insertion order.
    seedImage({ id: fakeId(82), productId, sortOrder: 2, isPrimary: false, url: "https://cdn.test/c.jpg" });
    seedImage({ id: fakeId(81), productId, sortOrder: 2, isPrimary: false, url: "https://cdn.test/b.jpg" });
    seedImage({ id: fakeId(84), productId, sortOrder: 0, isPrimary: false, url: "https://cdn.test/front.jpg" });
    seedImage({ id: fakeId(83), productId, sortOrder: 9, isPrimary: true, url: "https://cdn.test/hero.jpg" });

    const otherProductId = seedOwnedProduct(85);
    seedImage({ id: fakeId(86), productId: otherProductId, sortOrder: 0, isPrimary: true });
    productRepository.seedImage({
      id: fakeId(87),
      productId: fakeId(88),
      url: "https://cdn.test/other-store.jpg",
      altText: "another store's product",
      sortOrder: 0,
      isPrimary: true,
      createdAt: new Date("2026-06-02T00:00:00.000Z"),
    });

    const response = await get(`/api/seller/products/${productId}/images`, session.cookie);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: true;
      data: { productId: string; images: Array<{ id: string; url: string; isPrimary: boolean }> };
    };
    expect(body.data.productId).toBe(productId);
    expect(body.data.images.map((image) => image.id)).toEqual([
      fakeId(83),
      fakeId(84),
      fakeId(81),
      fakeId(82),
    ]);
    expect(body.data.images.map((image) => image.url)).toEqual([
      "https://cdn.test/hero.jpg",
      "https://cdn.test/front.jpg",
      "https://cdn.test/b.jpg",
      "https://cdn.test/c.jpg",
    ]);
    expect(body.data.images[0]?.isPrimary).toBe(true);
    // Ownership is resolved server-side and never taken from the request.
    expect(productRepository.listImagesCalls).toEqual([{ productId, storeId: "st-approved" }]);
    expect(JSON.stringify(body)).not.toContain("storeId");
    expect(JSON.stringify(body)).not.toContain("another store's product");
  });

  it("GET images returns an empty list for an owned product with no images", async () => {
    const session = await registerApprovedSeller();
    const productId = seedOwnedProduct(90);

    const response = await get(`/api/seller/products/${productId}/images`, session.cookie);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: true;
      data: { productId: string; images: unknown[] };
    };
    expect(body.data).toEqual({ productId, images: [] });
  });

  it("GET images hides a foreign product behind the same 404 as an unknown id", async () => {
    const session = await registerApprovedSeller();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const foreignProductId = fakeId(100);
    productRepository.seedProduct({
      id: foreignProductId,
      storeId: "st-other",
      slug: "foreign",
      name: "Foreign Product",
      description: "someone else's draft",
      categoryId: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    productRepository.seedImage({
      id: fakeId(101),
      productId: foreignProductId,
      url: "https://cdn.test/foreign.jpg",
      altText: "someone else's image",
      sortOrder: 0,
      isPrimary: true,
      createdAt: now,
    });

    const foreignResponse = await get(
      `/api/seller/products/${foreignProductId}/images`,
      session.cookie,
    );
    const unknownResponse = await get(
      `/api/seller/products/${fakeId(102)}/images`,
      session.cookie,
    );

    expect(foreignResponse.status).toBe(404);
    expect(unknownResponse.status).toBe(404);
    const foreignBody = await foreignResponse.json();
    const unknownBody = await unknownResponse.json();
    expect(foreignBody).toEqual(unknownBody);
    expect((foreignBody as ApiFailure).error.code).toBe("PRODUCT_NOT_FOUND");
    expect(JSON.stringify(foreignBody)).not.toContain("someone else's image");
    // The product lookup rejects the id before the image list is consulted.
    expect(productRepository.listImagesCalls).toHaveLength(0);
  });

  it("GET images rejects a malformed product id with 404 without reading images", async () => {
    const session = await registerApprovedSeller();

    await expectCreateFailure(
      await get(`/api/seller/products/not-a-uuid/images`, session.cookie),
      "PRODUCT_NOT_FOUND",
      404,
    );
    expect(productRepository.listImagesCalls).toHaveLength(0);
  });

  it("GET detail returns the same safe 404 for malformed, unknown, and cross-store ids", async () => {
    const session = await registerApprovedSeller();
    const crossStoreId = fakeId(60);
    const now = new Date();
    productRepository.seedProduct({
      id: crossStoreId,
      storeId: "st-other",
      slug: "cross-store",
      name: "Cross store",
      description: null,
      categoryId: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });

    const responses = [
      await get("/api/seller/products/not-an-id", session.cookie),
      await get(`/api/seller/products/${fakeId(61)}`, session.cookie),
      await get(`/api/seller/products/${crossStoreId}`, session.cookie),
    ];
    const bodies = [];
    for (const response of responses) {
      expect(response.status).toBe(404);
      bodies.push(await response.json());
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[0]).toMatchObject({
      ok: false,
      error: { code: "PRODUCT_NOT_FOUND", message: "This product is not available." },
    });
  });

  it("A: unauthenticated request returns 401", async () => {
    const response = await postJson("/api/seller/products", validBody);

    await expectCreateFailure(response, "SESSION_EXPIRED", 401);
    expect(productRepository.createCalls).toHaveLength(0);
  });

  it("A: a non-seller role passes auth but is rejected 403 FORBIDDEN", async () => {
    const session = await registerUser();

    const body = await expectCreateFailure(
      (await postJson("/api/seller/products", validBody, session.cookie, session.csrfToken)),
      "FORBIDDEN",
      403,
    );
    expect(body.error.message).toBe("You do not have permission to perform this action.");
    expect(productRepository.createCalls).toHaveLength(0);
  });

  it("A: missing CSRF returns 403 CSRF_FAILED", async () => {
    const session = await registerApprovedSeller();

    await expectCreateFailure(
      await postJson("/api/seller/products", validBody, session.cookie),
      "CSRF_FAILED",
      403,
    );
    expect(productRepository.createCalls).toHaveLength(0);
  });

  it("B: a seller role with a pending profile is 403 SELLER_NOT_APPROVED", async () => {
    const session = await registerUser();
    const user = userRepository.getUser(session.userId)!;
    userRepository.setUser({ ...user, role: "seller" });
    const now = new Date();
    sellerRepository.seedProfile({
      id: "sp-pending",
      userId: session.userId,
      slug: "pending-shop",
      displayName: "Pending Seller",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    sellerRepository.seedStore({
      id: "st-pending",
      sellerProfileId: "sp-pending",
      name: "Pending Shop",
      slug: "pending-shop",
      description: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });

    await expectCreateFailure(
      await postJson("/api/seller/products", validBody, session.cookie, session.csrfToken),
      "SELLER_NOT_APPROVED",
      403,
    );
    expect(productRepository.createCalls).toHaveLength(0);
  });

  it("B: an approved seller creates a draft product in their own store", async () => {
    const session = await registerApprovedSeller();

    const response = await postJson("/api/seller/products", validBody, session.cookie, session.csrfToken);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: true;
      data: {
        id: string;
        storeId: string;
        slug: string;
        name: string;
        description: string | null;
        categoryId: string | null;
        status: string;
        createdAt: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.storeId).toBe("st-approved");
    expect(body.data.slug).toBe("vintage-camera");
    expect(body.data.name).toBe("Vintage Camera");
    expect(body.data.description).toBe("A lovely film camera.");
    expect(body.data.categoryId).toBe("01955f00-0000-7000-8000-000000000001");
    expect(body.data.status).toBe("draft");
    expect(Number.isNaN(Date.parse(body.data.createdAt))).toBe(false);
    expect(productRepository.createCalls).toHaveLength(1);
    expect(productRepository.createCalls[0]?.storeId).toBe("st-approved");
  });

  it("B: the response envelope leaks no sensitive column names", async () => {
    const session = await registerApprovedSeller();

    const response = await postJson("/api/seller/products", validBody, session.cookie, session.csrfToken);
    const raw = await response.text();
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("csrfToken");
    expect(raw).not.toContain("seller_profile_id");
    expect(raw).not.toContain("user_id");
  });

  it("B: spoofed ownership fields in the body are ignored", async () => {
    const session = await registerApprovedSeller();

    const response = await postJson(
      "/api/seller/products",
      {
        ...validBody,
        storeId: "st-someone-else",
        sellerProfileId: "sp-someone-else",
        userId: "someone-else",
        status: "active",
      },
      session.cookie,
      session.csrfToken,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: { storeId: string; status: string } };
    expect(body.data.storeId).toBe("st-approved");
    expect(body.data.status).toBe("draft");
  });

  it("B: a category that is not active returns 404 CATEGORY_NOT_FOUND", async () => {
    const session = await registerApprovedSeller();
    catalogRepository.categories = [];

    const body = await expectCreateFailure(
      await postJson("/api/seller/products", validBody, session.cookie, session.csrfToken),
      "CATEGORY_NOT_FOUND",
      404,
    );
    expect(body.error.message).toBe("The selected category does not exist or is not active.");
    expect(productRepository.createCalls).toHaveLength(0);
  });

  it("B: a product without a category may still be created", async () => {
    const session = await registerApprovedSeller();

    const response = await postJson(
      "/api/seller/products",
      { name: "Bare Listing", slug: "bare-listing" },
      session.cookie,
      session.csrfToken,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: { categoryId: string | null } };
    expect(body.data.categoryId).toBeNull();
  });

  it("C: a duplicate slug in the store returns 409 PRODUCT_SLUG_IN_USE", async () => {
    const session = await registerApprovedSeller();

    const first = await postJson("/api/seller/products", validBody, session.cookie, session.csrfToken);
    expect(first.status).toBe(201);

    const second = await postJson("/api/seller/products", validBody, session.cookie, session.csrfToken);

    const body = await expectCreateFailure(second, "PRODUCT_SLUG_IN_USE", 409);
    expect(body.error.message).toBe("A product with this slug already exists in your store.");
  });

  it("C: a race-triggered insert conflict still returns 409 PRODUCT_SLUG_IN_USE", async () => {
    const session = await registerApprovedSeller();
    productRepository.forceCreateConflict = true;

    await expectCreateFailure(
      await postJson("/api/seller/products", validBody, session.cookie, session.csrfToken),
      "PRODUCT_SLUG_IN_USE",
      409,
    );
  });

  it("D: invalid input returns 422 with per-field errors and creates nothing", async () => {
    const session = await registerApprovedSeller();

    const response = await postJson(
      "/api/seller/products",
      { name: "", slug: "INVALID SLUG!", description: "x".repeat(2001), categoryId: "not-a-uuid" },
      session.cookie,
      session.csrfToken,
    );

    const body = await expectCreateFailure(response, "VALIDATION_ERROR", 422);
    expect(body.error.fields?.name).toBeDefined();
    expect(body.error.fields?.slug).toBeDefined();
    expect(body.error.fields?.description).toBeDefined();
    expect(body.error.fields?.categoryId).toBeDefined();
    expect(productRepository.createCalls).toHaveLength(0);
  });

  it("D: malformed JSON fails validation and creates nothing", async () => {
    const session = await registerApprovedSeller();

    const response = await app.request("/api/seller/products", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookie,
        "X-Zelora-CSRF": session.csrfToken,
      },
      body: "not-json",
    });

    const body = await expectCreateFailure(response, "VALIDATION_ERROR", 422);
    expect(body.error.fields?.body).toBeDefined();
    expect(productRepository.createCalls).toHaveLength(0);
  });

  it("E: a suspended account cannot create products", async () => {
    const session = await registerApprovedSeller();
    const user = userRepository.getUser(session.userId)!;
    userRepository.setUser({ ...user, status: "suspended" });

    await expectCreateFailure(
      await postJson("/api/seller/products", validBody, session.cookie, session.csrfToken),
      "ACCOUNT_SUSPENDED",
      403,
    );
    expect(productRepository.createCalls).toHaveLength(0);
  });

  it("E: a deleted account cannot create products", async () => {
    const session = await registerApprovedSeller();
    const user = userRepository.getUser(session.userId)!;
    userRepository.setUser({ ...user, status: "deleted" });

    await expectCreateFailure(
      await postJson("/api/seller/products", validBody, session.cookie, session.csrfToken),
      "ACCOUNT_DELETED",
      403,
    );
    expect(productRepository.createCalls).toHaveLength(0);
  });

  it("I: over-limit IP returns 429 RATE_LIMITED with Retry-After", async () => {
    const limiter = new MemoryWindowRateLimiter(clock);
    const limitedApp = createApp({
      config: { ...baseConfig, rateLimitProductCreateIpMax: 2 },
      userRepository,
      sessionRepository,
      sellerRepository,
      catalogRepository,
      productRepository,
      cartRepository: inertCartRepository,
      auditLogRepository: inertAuditLogRepository,
      passwordHasher,
      clock,
      rateLimiter: limiter,
      clientIpResolver: {
        resolve: (c) => c.req.header("x-test-ip") ?? undefined,
      },
    });

    const session = await registerApprovedSeller();
    for (let i = 0; i < 2; i += 1) {
      const response = await limitedApp.request("/api/seller/products", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: session.cookie,
          "X-Zelora-CSRF": session.csrfToken,
          "X-Test-IP": "203.0.113.66",
        },
        body: JSON.stringify({ ...validBody, slug: `camera-${i}` }),
      });
      expect(response.status).toBe(201);
    }

    const blocked = await limitedApp.request("/api/seller/products", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookie,
        "X-Zelora-CSRF": session.csrfToken,
        "X-Test-IP": "203.0.113.66",
      },
      body: JSON.stringify({ ...validBody, slug: "camera-2" }),
    });

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("3600");
    const body = (await blocked.json()) as ApiFailure;
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.details).toEqual({ retryAfterSeconds: 3600, scope: "ip" });
  });

  it("I: a different IP is unaffected by the product-create limit", async () => {
    const limiter = new MemoryWindowRateLimiter(clock);
    const limitedApp = createApp({
      config: { ...baseConfig, rateLimitProductCreateIpMax: 2 },
      userRepository,
      sessionRepository,
      sellerRepository,
      catalogRepository,
      productRepository,
      cartRepository: inertCartRepository,
      auditLogRepository: inertAuditLogRepository,
      passwordHasher,
      clock,
      rateLimiter: limiter,
      clientIpResolver: {
        resolve: (c) => c.req.header("x-test-ip") ?? undefined,
      },
    });

    const session = await registerApprovedSeller();
    for (let i = 0; i < 2; i += 1) {
      const response = await limitedApp.request("/api/seller/products", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: session.cookie,
          "X-Zelora-CSRF": session.csrfToken,
          "X-Test-IP": "203.0.113.67",
        },
        body: JSON.stringify({ ...validBody, slug: `camera-${i}` }),
      });
      expect(response.status).toBe(201);
    }
    const onLimit = await limitedApp.request("/api/seller/products", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookie,
        "X-Zelora-CSRF": session.csrfToken,
        "X-Test-IP": "203.0.113.67",
      },
      body: JSON.stringify({ ...validBody, slug: "camera-2" }),
    });
    expect(onLimit.status).toBe(429);

    const otherIp = await limitedApp.request("/api/seller/products", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookie,
        "X-Zelora-CSRF": session.csrfToken,
        "X-Test-IP": "198.51.100.67",
      },
      body: JSON.stringify({ ...validBody, slug: "camera-2" }),
    });
    expect(otherIp.status).toBe(201);
  });
});

describe("POST /api/seller/products/:id variants, inventory and publish", () => {
  const baseConfig: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3001,
    appVersion: "0.1.0",
    corsOrigin: "http://localhost:5173",
    sessionCookieName: "zelora_session",
    sessionTtlSeconds: 2_592_000,
    sessionCookieSecure: false,
    pbkdf2Iterations: 1_000,
    rateLimitEnabled: true,
    rateLimitTrustProxy: false,
    rateLimitLoginIpMax: 20,
    rateLimitLoginIpWindowSeconds: 900,
    rateLimitLoginEmailMax: 10,
    rateLimitLoginEmailWindowSeconds: 900,
    rateLimitRegisterIpMax: 10,
    rateLimitRegisterIpWindowSeconds: 3_600,
    rateLimitSellerOnboardingIpMax: 10,
    rateLimitSellerOnboardingIpWindowSeconds: 3_600,
    rateLimitProductCreateIpMax: 100,
    rateLimitProductCreateIpWindowSeconds: 3_600,
    sessionLastUsedThrottleSeconds: 300,
    sessionPurgeIntervalSeconds: 3_600,
    adminBootstrapSecret: null,
  };

  const headerIpResolver: ClientIpResolver = {
    resolve: (c) => c.req.header("x-test-ip") ?? undefined,
  };

  const inertAuditLogRepository: AuditLogRepository = {
    create: () => {
      throw new Error("unexpected audit log call");
    },
    listByAction: () => {
      throw new Error("unexpected audit log call");
    },
  };

  const inertCartRepository: CartRepository = {
    getCartByUserId: () => {
      throw new Error("unexpected cart call");
    },
    createCart: () => {
      throw new Error("unexpected cart call");
    },
    addItem: () => {
      throw new Error("unexpected cart call");
    },
    updateItemQuantity: () => {
      throw new Error("unexpected cart call");
    },
    removeItem: () => {
      throw new Error("unexpected cart call");
    },
    clearCart: () => {
      throw new Error("unexpected cart call");
    },
  };

  let clock: FakeClock;
  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let sellerRepository: FakeSellerRepository;
  let productRepository: FakeProductRepository;
  let catalogRepository: FakeCatalogRepository;
  let passwordHasher: PasswordHasher;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clock = new FakeClock();
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();
    sellerRepository = new FakeSellerRepository();
    productRepository = new FakeProductRepository();
    catalogRepository = new FakeCatalogRepository();
    catalogRepository.categories = [{ id: "01955f00-0000-7000-8000-000000000001", slug: "electronics", name: "Electronics" }];
    passwordHasher = new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations);
    app = createApp({
      config: baseConfig,
      userRepository,
      sessionRepository,
      sellerRepository,
      catalogRepository,
      productRepository,
      cartRepository: inertCartRepository,
      auditLogRepository: inertAuditLogRepository,
      passwordHasher,
      clock,
      clientIpResolver: headerIpResolver,
    });
  });

  let ipCounter = 0;
  function nextIp(): string {
    ipCounter += 1;
    return `198.51.100.${100 + (ipCounter % 150)}`;
  }

  function postJson(
    path: string,
    body: unknown,
    cookie?: string,
    csrfToken?: string,
    ip: string = nextIp(),
    api: ReturnType<typeof createApp> = app,
  ) {
    return api.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie === undefined ? {} : { Cookie: cookie }),
        ...(csrfToken === undefined ? {} : { "X-Zelora-CSRF": csrfToken }),
        "X-Test-IP": ip,
      },
      body: JSON.stringify(body),
    });
  }

  function extractSessionCookie(response: Response): string {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie === null) {
      throw new Error("expected a set-cookie header");
    }
    return setCookie.split(";")[0] ?? "";
  }

  async function registerUser(
    email = "seller@example.com",
  ): Promise<{ cookie: string; csrfToken: string; userId: string }> {
    const response = await postJson("/api/auth/register", {
      email,
      password: "password123",
      name: "Ada Lovelace",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: AuthUserResponse };
    return {
      cookie: extractSessionCookie(response),
      csrfToken: body.data.session.csrfToken,
      userId: body.data.user.id,
    };
  }

  async function registerApprovedSeller(): Promise<{
    cookie: string;
    csrfToken: string;
    userId: string;
  }> {
    const session = await registerUser();
    const user = userRepository.getUser(session.userId)!;
    userRepository.setUser({ ...user, role: "seller" });
    const now = new Date();
    sellerRepository.seedProfile({
      id: "sp-approved",
      userId: session.userId,
      slug: "approved-shop",
      displayName: "Approved Seller",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    sellerRepository.seedStore({
      id: "st-approved",
      sellerProfileId: "sp-approved",
      name: "Approved Shop",
      slug: "approved-shop",
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return session;
  }

  async function createDraftProduct(session: { cookie: string; csrfToken: string }): Promise<string> {
    const response = await postJson(
      "/api/seller/products",
      { name: "Vintage Camera", slug: "vintage-camera" },
      session.cookie,
      session.csrfToken,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: { id: string } };
    return body.data.id;
  }

  /** Promote an arbitrary (already-registered) user into an approved seller of `st-other`. */
  function seedApprovedSellerFor(userId: string): void {
    const now = new Date();
    sellerRepository.seedProfile({
      id: "sp-other",
      userId,
      slug: "other-shop",
      displayName: "Other Seller",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    sellerRepository.seedStore({
      id: "st-other",
      sellerProfileId: "sp-other",
      name: "Other Shop",
      slug: "other-shop",
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  async function expectFailure(
    response: Response,
    code: string,
    status: number,
  ): Promise<ApiFailure> {
    expect(response.status).toBe(status);
    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(code);
    return body;
  }

  describe("POST /api/seller/products/:id/variants", () => {
    it("A: unauthenticated request returns 401", async () => {
      const response = await postJson(
        "/api/seller/products/01955f00-0000-7000-8000-000000000001/variants",
        { name: "Body Only", priceAmountCents: 100 },
      );

      await expectFailure(response, "SESSION_EXPIRED", 401);
      expect(productRepository.createVariantCalls).toHaveLength(0);
    });

    it("A: a non-seller role is rejected 403 FORBIDDEN before any ownership check", async () => {
      const session = await registerUser();

      const response = await postJson(
        "/api/seller/products/01955f00-0000-7000-8000-000000000001/variants",
        { name: "Body Only", priceAmountCents: 100 },
        session.cookie,
        session.csrfToken,
      );

      await expectFailure(response, "FORBIDDEN", 403);
      expect(productRepository.createVariantCalls).toHaveLength(0);
    });

    it("A: missing CSRF returns 403 CSRF_FAILED", async () => {
      const session = await registerApprovedSeller();

      const response = await postJson(
        "/api/seller/products/01955f00-0000-7000-8000-000000000001/variants",
        { name: "Body Only", priceAmountCents: 100 },
        session.cookie,
      );

      await expectFailure(response, "CSRF_FAILED", 403);
      expect(productRepository.createVariantCalls).toHaveLength(0);
    });

    it("B: an approved seller adds an active variant to their own draft product", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);

      const response = await postJson(
        `/api/seller/products/${productId}/variants`,
        {
          name: "Body Only",
          sku: "CAM-BODY",
          priceAmountCents: 49900,
          compareAtAmountCents: 59900,
          currency: "USD",
        },
        session.cookie,
        session.csrfToken,
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        ok: true;
        data: {
          id: string;
          productId: string;
          sku: string | null;
          name: string;
          priceAmountCents: number;
          compareAtAmountCents: number | null;
          currency: string;
          status: string;
          createdAt: string;
          updatedAt: string;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.data.productId).toBe(productId);
      expect(body.data.sku).toBe("CAM-BODY");
      expect(body.data.name).toBe("Body Only");
      expect(body.data.priceAmountCents).toBe(49900);
      expect(body.data.compareAtAmountCents).toBe(59900);
      expect(body.data.currency).toBe("USD");
      expect(body.data.status).toBe("active");
      expect(Number.isNaN(Date.parse(body.data.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(body.data.updatedAt))).toBe(false);
      expect(productRepository.createVariantCalls).toHaveLength(1);
      expect(productRepository.createVariantCalls[0]?.storeId).toBe("st-approved");
    });

    it("B: spoofed ownership and status fields are ignored", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);

      const response = await postJson(
        `/api/seller/products/${productId}/variants`,
        {
          name: "Body Only",
          priceAmountCents: 49900,
          storeId: "st-someone-else",
          sellerProfileId: "sp-someone-else",
          status: "inactive",
        },
        session.cookie,
        session.csrfToken,
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { ok: true; data: { status: string } };
      expect(body.data.status).toBe("active");
      expect(productRepository.createVariantCalls[0]?.storeId).toBe("st-approved");
    });

    it("B: a seller cannot add a variant to another store's product (404, no leak)", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);
      const otherSession = await registerUser("other@example.com");
      const otherUser = userRepository.getUser(otherSession.userId)!;
      userRepository.setUser({ ...otherUser, role: "seller" });
      seedApprovedSellerFor(otherSession.userId);

      const response = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Sneaky", priceAmountCents: 100 },
        otherSession.cookie,
        otherSession.csrfToken,
      );

      await expectFailure(response, "PRODUCT_NOT_FOUND", 404);
      // Ownership always comes from the caller's session, never the body.
      expect(productRepository.createVariantCalls[0]?.storeId).toBe("st-other");
    });

    it("C: a duplicate SKU returns 409 SKU_IN_USE", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);
      await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", sku: "CAM-BODY", priceAmountCents: 49900 },
        session.cookie,
        session.csrfToken,
      );

      const response = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", sku: "CAM-BODY", priceAmountCents: 49900 },
        session.cookie,
        session.csrfToken,
      );

      const body = await expectFailure(response, "SKU_IN_USE", 409);
      expect(body.error.message).toBe("A variant with this SKU already exists.");
      expect(productRepository.createVariantCalls).toHaveLength(2);
    });

    it("E: a suspended account cannot add variants", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);
      const user = userRepository.getUser(session.userId)!;
      userRepository.setUser({ ...user, status: "suspended" });

      const response = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", priceAmountCents: 100 },
        session.cookie,
        session.csrfToken,
      );

      await expectFailure(response, "ACCOUNT_SUSPENDED", 403);
      expect(productRepository.createVariantCalls).toHaveLength(0);
    });

    it("D: invalid payload returns 422 VALIDATION_ERROR with per-field errors", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);

      const response = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "   ", priceAmountCents: 0, storage: true },
        session.cookie,
        session.csrfToken,
      );

      const body = await expectFailure(response, "VALIDATION_ERROR", 422);
      expect(body.error.fields?.name).toBeDefined();
      expect(body.error.fields?.priceAmountCents).toBeDefined();
      expect(productRepository.createVariantCalls).toHaveLength(0);
    });

    it("B: a missing product id returns 404 PRODUCT_NOT_FOUND", async () => {
      const session = await registerApprovedSeller();

      const response = await postJson(
        "/api/seller/products/not-a-uuid/variants",
        { name: "Body Only", priceAmountCents: 100 },
        session.cookie,
        session.csrfToken,
      );

      await expectFailure(response, "PRODUCT_NOT_FOUND", 404);
      expect(productRepository.createVariantCalls).toHaveLength(0);
    });
  });

  describe("POST /api/seller/products/:id/variants/:variantId/inventory", () => {
    it("B: upserts inventory for a variant of the seller's own product", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);
      const variantResponse = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", priceAmountCents: 49900 },
        session.cookie,
        session.csrfToken,
      );
      expect(variantResponse.status).toBe(201);
      const variant = (await variantResponse.json()) as { ok: true; data: { id: string } };

      const response = await postJson(
        `/api/seller/products/${productId}/variants/${variant.data.id}/inventory`,
        { quantity: 7 },
        session.cookie,
        session.csrfToken,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: true;
        data: { variantId: string; quantity: number; updatedAt: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.variantId).toBe(variant.data.id);
      expect(body.data.quantity).toBe(7);
      expect(Number.isNaN(Date.parse(body.data.updatedAt))).toBe(false);
      expect(productRepository.setInventoryCalls[0]).toMatchObject({
        productId,
        variantId: variant.data.id,
        storeId: "st-approved",
        quantity: 7,
      });
    });

    it("B: setting inventory a second time overwrites the quantity", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);
      const variantResponse = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", priceAmountCents: 49900 },
        session.cookie,
        session.csrfToken,
      );
      expect(variantResponse.status).toBe(201);
      const variant = (await variantResponse.json()) as { ok: true; data: { id: string } };
      await postJson(
        `/api/seller/products/${productId}/variants/${variant.data.id}/inventory`,
        { quantity: 7 },
        session.cookie,
        session.csrfToken,
      );

      const response = await postJson(
        `/api/seller/products/${productId}/variants/${variant.data.id}/inventory`,
        { quantity: 3 },
        session.cookie,
        session.csrfToken,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: true; data: { quantity: number } };
      expect(body.data.quantity).toBe(3);
    });

    it("B: a variant that belongs to another store's product is 404", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);
      const variantResponse = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", priceAmountCents: 49900 },
        session.cookie,
        session.csrfToken,
      );
      expect(variantResponse.status).toBe(201);
      const variant = (await variantResponse.json()) as { ok: true; data: { id: string } };

      const otherSession = await registerUser("other@example.com");
      const otherUser = userRepository.getUser(otherSession.userId)!;
      userRepository.setUser({ ...otherUser, role: "seller" });
      seedApprovedSellerFor(otherSession.userId);

      const response = await postJson(
        `/api/seller/products/${productId}/variants/${variant.data.id}/inventory`,
        { quantity: 5 },
        otherSession.cookie,
        otherSession.csrfToken,
      );

      await expectFailure(response, "PRODUCT_NOT_FOUND", 404);
      // Ownership always comes from the caller's session, never the body.
      expect(productRepository.setInventoryCalls[0]?.storeId).toBe("st-other");
    });

    it("D: a negative quantity returns 422", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);
      const variantResponse = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", priceAmountCents: 49900 },
        session.cookie,
        session.csrfToken,
      );
      expect(variantResponse.status).toBe(201);
      const variant = (await variantResponse.json()) as { ok: true; data: { id: string } };

      const response = await postJson(
        `/api/seller/products/${productId}/variants/${variant.data.id}/inventory`,
        { quantity: -1 },
        session.cookie,
        session.csrfToken,
      );

      await expectFailure(response, "VALIDATION_ERROR", 422);
      expect(productRepository.setInventoryCalls).toHaveLength(0);
    });
  });

  describe("POST /api/seller/products/:id/publish", () => {
    it("B: publishes a draft once it has a sellable variant and inventory", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);
      const variantResponse = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", priceAmountCents: 49900 },
        session.cookie,
        session.csrfToken,
      );
      expect(variantResponse.status).toBe(201);
      const variant = (await variantResponse.json()) as { ok: true; data: { id: string } };
      await postJson(
        `/api/seller/products/${productId}/variants/${variant.data.id}/inventory`,
        { quantity: 3 },
        session.cookie,
        session.csrfToken,
      );

      const response = await postJson(
        `/api/seller/products/${productId}/publish`,
        {},
        session.cookie,
        session.csrfToken,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: true; data: { id: string; status: string } };
      expect(body.ok).toBe(true);
      expect(body.data.id).toBe(productId);
      expect(body.data.status).toBe("active");
    });

    it("B: rejects publishing a draft with no sellable variant as 409 PRODUCT_NOT_PUBLISHABLE", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);

      const response = await postJson(
        `/api/seller/products/${productId}/publish`,
        {},
        session.cookie,
        session.csrfToken,
      );

      const body = await expectFailure(response, "PRODUCT_NOT_PUBLISHABLE", 409);
      expect(body.error.message).toContain("Add at least one active variant");
    });

    it("B: rejects publishing with a variant but no inventory", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);
      await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", priceAmountCents: 49900 },
        session.cookie,
        session.csrfToken,
      );

      const response = await postJson(
        `/api/seller/products/${productId}/publish`,
        {},
        session.cookie,
        session.csrfToken,
      );

      await expectFailure(response, "PRODUCT_NOT_PUBLISHABLE", 409);
    });

    it("B: an owner cannot publish another store's product (404, no leak)", async () => {
      const session = await registerApprovedSeller();
      const productId = await createDraftProduct(session);

      const otherSession = await registerUser("other@example.com");
      const otherUser = userRepository.getUser(otherSession.userId)!;
      userRepository.setUser({ ...otherUser, role: "seller" });
      seedApprovedSellerFor(otherSession.userId);

      const response = await postJson(
        `/api/seller/products/${productId}/publish`,
        {},
        otherSession.cookie,
        otherSession.csrfToken,
      );

      await expectFailure(response, "PRODUCT_NOT_FOUND", 404);
    });

    it("I: variant, inventory and publish use separate rate-limit buckets", async () => {
      const limiter = new MemoryWindowRateLimiter(clock);
      const limitedApp = createApp({
        config: { ...baseConfig, rateLimitEnabled: true, rateLimitProductCreateIpMax: 1 },
        userRepository,
        sessionRepository,
        sellerRepository,
        catalogRepository,
        productRepository,
        cartRepository: inertCartRepository,
        auditLogRepository: inertAuditLogRepository,
        passwordHasher,
        clock,
        rateLimiter: limiter,
        clientIpResolver: headerIpResolver,
      });

      const session = await registerApprovedSeller();
      const ip = "203.0.113.90";

      const createResponse = await postJson(
        "/api/seller/products",
        { name: "Vintage Camera", slug: "vintage-camera" },
        session.cookie,
        session.csrfToken,
        ip,
        limitedApp,
      );
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { ok: true; data: { id: string } };
      const productId = created.data.id;

      // Product-create bucket is full; the variant call must still pass.
      const variantResponse = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", priceAmountCents: 49900 },
        session.cookie,
        session.csrfToken,
        ip,
        limitedApp,
      );
      expect(variantResponse.status).toBe(201);
      const variant = (await variantResponse.json()) as { ok: true; data: { id: string } };

      // Inventory keeps its own bucket and still passes.
      const inventoryResponse = await postJson(
        `/api/seller/products/${productId}/variants/${variant.data.id}/inventory`,
        { quantity: 3 },
        session.cookie,
        session.csrfToken,
        ip,
        limitedApp,
      );
      expect(inventoryResponse.status).toBe(200);

      // The second variant call in the same window trips the variant bucket.
      const variantAgain = await postJson(
        `/api/seller/products/${productId}/variants`,
        { name: "Body Only", priceAmountCents: 49900 },
        session.cookie,
        session.csrfToken,
        ip,
        limitedApp,
      );
      expect(variantAgain.status).toBe(429);

      // Publish keeps its own bucket and still passes.
      const publishResponse = await postJson(
        `/api/seller/products/${productId}/publish`,
        {},
        session.cookie,
        session.csrfToken,
        ip,
        limitedApp,
      );
      expect(publishResponse.status).toBe(200);
    });
  });
});