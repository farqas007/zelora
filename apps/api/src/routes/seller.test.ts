import { beforeEach, describe, expect, it } from "vitest";
import { PBKDF2PasswordHasher, type AppConfig, type PasswordHasher } from "@zelora/core";
import type {
  AuthSessionRecord,
  AuthSessionRepository,
  CreateAuthSessionInput,
} from "@zelora/db/auth";
import type { UserRecord, UserRepository } from "@zelora/db/users";
import type {
  CreateOnboardingInput,
  OnboardingConflictReason,
  SellerProfileRecord,
  SellerRepository,
  StoreRecord,
} from "@zelora/db/seller";
import type { CatalogRepository } from "@zelora/db/catalog";
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

  clear(): void {
    this.profiles.clear();
    this.stores.clear();
    this.nextId = 1;
    this.createCalls = [];
    this.forceConflict = null;
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
    sessionLastUsedThrottleSeconds: 300,
    sessionPurgeIntervalSeconds: 3_600,
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