import { beforeEach, describe, expect, it } from "vitest";
import { PBKDF2PasswordHasher, type AppConfig, type PasswordHasher } from "@zelora/core";
import type {
  AuthSessionRecord,
  AuthSessionRepository,
  CreateAuthSessionInput,
} from "@zelora/db/auth";
import type { UserRecord, UserRepository } from "@zelora/db/users";
import type { SellerRepository, SellerProfileRecord, StoreRecord } from "@zelora/db/seller";
import type { CatalogRepository } from "@zelora/db/catalog";
import { createId } from "@zelora/db";
import type { ApiFailure, AuthUserResponse } from "@zelora/shared";
import { createApp } from "../app";
import type { Clock } from "../services/clock";
import type { ClientIpResolver } from "../services/client-ip";

/**
 * End-to-end route tests for POST /api/admin/sellers/:userId/activate through
 * the real composed app: session auth, the admin-role gate, CSRF, then the
 * handler and service. Authorization decisions (401/403) and the activation
 * transition (200) are asserted here; the promotion of profile/store/user is
 * covered at the repository level.
 */

class FakeClock implements Clock {
  private currentTime: Date;

  constructor(startTime: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.currentTime = startTime;
  }

  now(): Date {
    return new Date(this.currentTime.getTime());
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
}

class FakeSellerRepository implements SellerRepository {
  private profiles: Map<string, SellerProfileRecord> = new Map();
  private stores: Map<string, StoreRecord> = new Map();

  async findByUserId(userId: string): Promise<SellerProfileRecord | null> {
    return Array.from(this.profiles.values()).find((profile) => profile.userId === userId) ?? null;
  }

  async findByProfileSlug(slug: string): Promise<SellerProfileRecord | null> {
    return Array.from(this.profiles.values()).find((profile) => profile.slug === slug) ?? null;
  }

  async findStoreBySlug(slug: string): Promise<StoreRecord | null> {
    return Array.from(this.stores.values()).find((store) => store.slug === slug) ?? null;
  }

  async createOnboarding(): Promise<
    | { ok: true; sellerProfile: SellerProfileRecord; store: StoreRecord }
    | { ok: false; reason: "SELLER_PROFILE_EXISTS" | "PROFILE_SLUG_IN_USE" | "STORE_SLUG_IN_USE" }
  > {
    throw new Error("not exercised by admin route tests");
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
    if (store === undefined) {
      return null;
    }
    const sellerProfile: SellerProfileRecord = { ...profile, status: "active" };
    this.profiles.set(profile.id, sellerProfile);
    return { sellerProfile, store: { ...store, status: "active" } };
  }

  seedProfile(profile: SellerProfileRecord): void {
    this.profiles.set(profile.id, profile);
  }

  seedStore(store: StoreRecord): void {
    this.stores.set(store.id, store);
  }
}

describe("POST /api/admin/sellers/:userId/activate", () => {
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
   * Admin route tests never hit the catalog, but `createApp` composes it. Any
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

  function postJson(path: string, cookie?: string, csrfToken?: string) {
    return app.request(path, {
      method: "POST",
      headers: {
        ...(cookie === undefined ? {} : { Cookie: cookie }),
        ...(csrfToken === undefined ? {} : { "X-Zelora-CSRF": csrfToken }),
      },
    });
  }

  function extractSessionCookie(response: Response): string {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie === null) {
      throw new Error("expected a set-cookie header");
    }
    return setCookie.split(";")[0] ?? "";
  }

  async function registerSession(email = "admin@example.com"): Promise<{
    cookie: string;
    csrfToken: string;
    userId: string;
  }> {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123", name: "Admin" }),
    });
    expect(register.status).toBe(201);
    const body = (await register.json()) as { ok: true; data: AuthUserResponse };
    return {
      cookie: extractSessionCookie(register),
      csrfToken: body.data.session.csrfToken,
      userId: body.data.user.id,
    };
  }

  async function expectFailure(response: Response, code: string, status: number): Promise<ApiFailure> {
    expect(response.status).toBe(status);
    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(code);
    return body;
  }

  it("A: unauthenticated request returns 401 SESSION_EXPIRED", async () => {
    const response = await postJson("/api/admin/sellers/00000000-0000-7000-8000-000000000001/activate");
    await expectFailure(response, "SESSION_EXPIRED", 401);
  });

  it("B: a customer role cannot activate a seller (403 FORBIDDEN)", async () => {
    const { cookie } = await registerSession();
    const response = await postJson(
      "/api/admin/sellers/00000000-0000-7000-8000-000000000001/activate",
      cookie,
    );
    await expectFailure(response, "FORBIDDEN", 403);
  });

  it("C: an admin without a CSRF token is rejected (403 CSRF_FAILED)", async () => {
    const { cookie, userId } = await registerSession();
    const user = userRepository.getUser(userId)!;
    userRepository.setUser({ ...user, role: "admin" });

    const response = await postJson(
      "/api/admin/sellers/00000000-0000-7000-8000-000000000001/activate",
      cookie,
    );

    await expectFailure(response, "CSRF_FAILED", 403);
  });

  it("D: a non-UUIDv7 userId path param returns 404 NOT_FOUND", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    const user = userRepository.getUser(userId)!;
    userRepository.setUser({ ...user, role: "admin" });

    const response = await postJson("/api/admin/sellers/not-an-id/activate", cookie, csrfToken);

    await expectFailure(response, "NOT_FOUND", 404);
  });

  it("E: activating an unknown seller returns 404 NOT_FOUND", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    const user = userRepository.getUser(userId)!;
    userRepository.setUser({ ...user, role: "admin" });

    const response = await postJson(
      `/api/admin/sellers/${createId()}/activate`,
      cookie,
      csrfToken,
    );

    await expectFailure(response, "NOT_FOUND", 404);
  });

  it("F: an admin activates a pending seller and returns the shared envelope", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    const user = userRepository.getUser(userId)!;
    userRepository.setUser({ ...user, role: "admin" });

    const sellerUserId = createId();
    const sellerProfileId = createId();
    sellerRepository.seedProfile({
      id: sellerProfileId,
      userId: sellerUserId,
      slug: "pending-shop",
      displayName: "Pending Seller",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    sellerRepository.seedStore({
      id: createId(),
      sellerProfileId,
      name: "Pending Shop",
      slug: "pending-shop",
      description: null,
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await postJson(`/api/admin/sellers/${sellerUserId}/activate`, cookie, csrfToken);

    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("csrfToken");
    const body = JSON.parse(raw) as {
      ok: true;
      data: { sellerProfile: Record<string, unknown>; store: Record<string, unknown> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.sellerProfile.status).toBe("active");
    expect(body.data.sellerProfile.userId).toBe(sellerUserId);
    expect(body.data.store.status).toBe("active");
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

  it("G: a suspended profile cannot be activated (409 SELLER_ACTIVATION_BLOCKED)", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    const user = userRepository.getUser(userId)!;
    userRepository.setUser({ ...user, role: "admin" });

    const sellerUserId = createId();
    sellerRepository.seedProfile({
      id: createId(),
      userId: sellerUserId,
      slug: "suspended-shop",
      displayName: "Suspended Seller",
      status: "suspended",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await postJson(`/api/admin/sellers/${sellerUserId}/activate`, cookie, csrfToken);

    const body = await expectFailure(response, "SELLER_ACTIVATION_BLOCKED", 409);
    expect(body.error.message).toBe("This seller profile cannot be activated.");
  });
});