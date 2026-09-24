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
import type { ProductRepository, ProductRecord, CreateProductInput } from "@zelora/db/products";
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

/** Working product-repository fake: slug uniqueness enforced per store. */
class FakeProductRepository implements ProductRepository {
  private products: Map<string, ProductRecord> = new Map();
  private nextId = 1;

  createCalls: CreateProductInput[] = [];
  forceCreateConflict: boolean = false;

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
      id: `product-${this.nextId++}`,
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

  clear(): void {
    this.products.clear();
    this.nextId = 1;
    this.createCalls = [];
    this.forceCreateConflict = false;
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
    findByStoreAndSlug: () => {
      throw new Error("unexpected product call");
    },
    createProduct: () => {
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

describe("POST /api/seller/products", () => {
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