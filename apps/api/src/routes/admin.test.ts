import { beforeEach, describe, expect, it } from "vitest";
import { PBKDF2PasswordHasher, type AppConfig, type PasswordHasher } from "@zelora/core";
import type {
  AuthSessionRecord,
  AuthSessionRepository,
  CreateAuthSessionInput,
} from "@zelora/db/auth";
import type { AuditLogRecord, AuditLogRepository, CreateAuditLogInput } from "@zelora/db/audit";
import type { UserRecord, UserRepository, CreateAdminResult, CreateUserInput } from "@zelora/db/users";
import type {
  PendingSellerListPage,
  PendingSellerRecord,
  SellerProfileRecord,
  SellerRepository,
  StoreRecord,
} from "@zelora/db/seller";
import type { CatalogRepository } from "@zelora/db/catalog";
import type { ProductRepository } from "@zelora/db/products";
import type { CartRepository } from "@zelora/db/cart";
import { createId } from "@zelora/db";
import type { ApiFailure, AuthUserResponse } from "@zelora/shared";
import { createApp } from "../app";
import { ADMIN_BOOTSTRAP_HEADER } from "./admin";
import type { Clock } from "../services/clock";
import type { ClientIpResolver } from "../services/client-ip";

/**
 * End-to-end route tests for the admin surface through the real composed app:
 * session auth, the admin-role gate, CSRF, then the handler and service.
 * Authorization decisions (401/403), the bootstrap endpoint and the
 * activation/rejection/pending-list transitions are all asserted here; the
 * promotion of profile/store/user is covered at the repository level.
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

  async createAdmin(input: CreateUserInput): Promise<CreateAdminResult> {
    if (this.usersByEmail.get(input.email) !== undefined) {
      return { ok: false, reason: "EMAIL_IN_USE" };
    }
    if (Array.from(this.users.values()).some((user) => user.role === "admin")) {
      return { ok: false, reason: "ADMIN_ALREADY_EXISTS" };
    }
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

class FakeAuditLogRepository implements AuditLogRepository {
  entries: AuditLogRecord[] = [];
  private nextId = 1;

  async create(input: CreateAuditLogInput): Promise<AuditLogRecord> {
    const record: AuditLogRecord = {
      id: `audit-${this.nextId++}`,
      actorUserId: input.actorUserId,
      action: input.action,
      targetUserId: input.targetUserId ?? null,
      details: input.details ?? null,
      createdAt: new Date(),
    };
    this.entries.push(record);
    return record;
  }

  async listByAction(action: string): Promise<AuditLogRecord[]> {
    return this.entries.filter((entry) => entry.action === action);
  }

  clear(): void {
    this.entries = [];
    this.nextId = 1;
  }
}

class FakeSellerRepository implements SellerRepository {
  private profiles: Map<string, SellerProfileRecord> = new Map();
  private stores: Map<string, StoreRecord> = new Map();
  private pendingQueue: PendingSellerRecord[] = [];

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

  async listPendingProfiles({ limit, cursor }: { limit: number; cursor: string | null }): Promise<PendingSellerListPage> {
    const queue = [...this.pendingQueue].sort(
      (a, b) =>
        a.sellerProfile.createdAt.getTime() - b.sellerProfile.createdAt.getTime() ||
        a.sellerProfile.id.localeCompare(b.sellerProfile.id),
    );
    let startIndex = 0;
    if (cursor !== null) {
      const separator = cursor.lastIndexOf(":");
      const id = separator >= 0 ? cursor.slice(separator + 1) : cursor;
      const index = queue.findIndex((item) => item.sellerProfile.id === id);
      startIndex = index >= 0 ? index + 1 : queue.length;
    }
    const page = queue.slice(startIndex, startIndex + limit);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor:
        startIndex + limit < queue.length && last !== undefined
          ? `${last.sellerProfile.createdAt.getTime()}:${last.sellerProfile.id}`
          : null,
    };
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

  seedProfile(profile: SellerProfileRecord): void {
    this.profiles.set(profile.id, profile);
  }

  seedStore(store: StoreRecord): void {
    this.stores.set(store.id, store);
  }

  seedPendingSeller(record: PendingSellerRecord): void {
    this.pendingQueue.push(record);
    this.profiles.set(record.sellerProfile.id, record.sellerProfile);
    this.stores.set(record.store.id, record.store);
  }
}

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

function extractSessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) {
    throw new Error("expected a set-cookie header");
  }
  return setCookie.split(";")[0] ?? "";
}

async function expectFailure(response: Response, code: string, status: number): Promise<ApiFailure> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as ApiFailure;
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe(code);
  return body;
}

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
 * Cart routes are composed by `createApp` but never reached by admin route
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

/**
 * Product creation is composed by `createApp` but never reached by admin route
 * tests. Any accidental invocation would reveal a wiring bug loudly.
 */
const inertProductRepository: ProductRepository = {
  findByStoreAndSlug: () => {
    throw new Error("unexpected product call");
  },
  createProduct: () => {
    throw new Error("unexpected product call");
  },
};

describe("POST /api/admin/sellers/:userId/activate", () => {

  let clock: FakeClock;
  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let sellerRepository: FakeSellerRepository;
  let auditLogRepository: FakeAuditLogRepository;
  let passwordHasher: PasswordHasher;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clock = new FakeClock();
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();
    sellerRepository = new FakeSellerRepository();
    auditLogRepository = new FakeAuditLogRepository();
    passwordHasher = new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations);
    app = createApp({
      config: baseConfig,
      userRepository,
      sessionRepository,
      sellerRepository,
      catalogRepository: inertCatalogRepository,
      productRepository: inertProductRepository,
      cartRepository: inertCartRepository,
      auditLogRepository,
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

describe("POST /api/admin/bootstrap", () => {
  const bootstrapSecret = "a-very-long-test-bootstrap-secret-value";
  const enabledConfig: AppConfig = {
    ...baseConfig,
    adminBootstrapSecret: bootstrapSecret,
  };

  let userRepository: FakeUserRepository;
  let auditLogRepository: FakeAuditLogRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    userRepository = new FakeUserRepository();
    auditLogRepository = new FakeAuditLogRepository();
    const passwordHasher = new PBKDF2PasswordHasher(enabledConfig.pbkdf2Iterations);
    app = createApp({
      config: enabledConfig,
      userRepository,
      sessionRepository: new FakeAuthSessionRepository(),
      sellerRepository: new FakeSellerRepository(),
      catalogRepository: inertCatalogRepository,
      productRepository: inertProductRepository,
      cartRepository: inertCartRepository,
      auditLogRepository,
      passwordHasher,
      clock: new FakeClock(),
      clientIpResolver: headerIpResolver,
    });
  });

  function postBootstrap(body: unknown, secret?: string) {
    return app.request("/api/admin/bootstrap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret === undefined ? {} : { [ADMIN_BOOTSTRAP_HEADER]: secret }),
      },
      body: JSON.stringify(body),
    });
  }

  it("is disabled (404 NOT_FOUND) when no bootstrap secret is configured", async () => {
    const disabledApp = createApp({
      config: baseConfig,
      userRepository,
      sessionRepository: new FakeAuthSessionRepository(),
      sellerRepository: new FakeSellerRepository(),
      catalogRepository: inertCatalogRepository,
      productRepository: inertProductRepository,
      cartRepository: inertCartRepository,
      auditLogRepository,
      passwordHasher: new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations),
      clock: new FakeClock(),
      clientIpResolver: headerIpResolver,
    });
    const response = await disabledApp.request("/api/admin/bootstrap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ADMIN_BOOTSTRAP_HEADER]: bootstrapSecret,
      },
      body: JSON.stringify({ email: "root@example.com", password: "password123", name: "Root" }),
    });
    await expectFailure(response, "NOT_FOUND", 404);
    expect(auditLogRepository.entries).toHaveLength(0);
  });

  it("rejects a missing header with 403 ADMIN_BOOTSTRAP_UNAUTHORIZED", async () => {
    const response = await postBootstrap({
      email: "root@example.com",
      password: "password123",
      name: "Root",
    });
    await expectFailure(response, "ADMIN_BOOTSTRAP_UNAUTHORIZED", 403);
    expect(auditLogRepository.entries).toHaveLength(0);
  });

  it("rejects a wrong secret with 403 ADMIN_BOOTSTRAP_UNAUTHORIZED", async () => {
    const response = await postBootstrap(
      { email: "root@example.com", password: "password123", name: "Root" },
      "not-the-right-secret-at-all",
    );
    await expectFailure(response, "ADMIN_BOOTSTRAP_UNAUTHORIZED", 403);
    expect(auditLogRepository.entries).toHaveLength(0);
  });

  it("creates the first admin (201) and audited admin.bootstrap", async () => {
    const response = await postBootstrap(
      { email: "root@example.com", password: "password123", name: "Root" },
      bootstrapSecret,
    );

    expect(response.status).toBe(201);
    const raw = await response.text();
    expect(raw).not.toContain("passwordHash");
    const body = JSON.parse(raw) as {
      ok: true;
      data: { user: { id: string; email: string; role: string } };
    };
    expect(body.data.user.email).toBe("root@example.com");
    expect(body.data.user.role).toBe("admin");

    const created = userRepository.getUser(body.data.user.id);
    expect(created?.role).toBe("admin");
    expect(auditLogRepository.entries).toHaveLength(1);
    expect(auditLogRepository.entries[0]!.action).toBe("admin.bootstrap");
    expect(auditLogRepository.entries[0]!.actorUserId).toBeNull();
    expect(auditLogRepository.entries[0]!.targetUserId).toBe(body.data.user.id);

    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", password: "password123" }),
    });
    expect(login.status).toBe(200);
  });

  it("is idempotent (200, no audit) for an existing admin email", async () => {
    const first = await postBootstrap(
      { email: "root@example.com", password: "password123", name: "Root" },
      bootstrapSecret,
    );
    expect(first.status).toBe(201);
    const second = await postBootstrap(
      { email: "root@example.com", password: "password123", name: "Root" },
      bootstrapSecret,
    );

    expect(second.status).toBe(200);
    const body = (await second.json()) as { ok: true; data: { user: { email: string; role: string } } };
    expect(body.data.user.role).toBe("admin");
    expect(auditLogRepository.entries).toHaveLength(1);
  });

  it("never promotes an existing non-admin account (409 ADMIN_BOOTSTRAP_CONFLICT)", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", password: "password123", name: "Root" }),
    });
    expect(register.status).toBe(201);
    const body = (await register.json()) as { ok: true; data: AuthUserResponse };
    const customerId = body.data.user.id;

    const response = await postBootstrap(
      { email: "root@example.com", password: "password123", name: "Root" },
      bootstrapSecret,
    );

    await expectFailure(response, "ADMIN_BOOTSTRAP_CONFLICT", 409);
    expect(userRepository.getUser(customerId)?.role).toBe("customer");
  });

  it("rejects an invalid body with 422 VALIDATION_ERROR", async () => {
    const response = await postBootstrap(
      { email: "not-an-email", password: "short", name: "" },
      bootstrapSecret,
    );
    await expectFailure(response, "VALIDATION_ERROR", 422);
    expect(auditLogRepository.entries).toHaveLength(0);
  });
});

describe("GET /api/admin/sellers/pending", () => {
  let clock: FakeClock;
  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let sellerRepository: FakeSellerRepository;
  let auditLogRepository: FakeAuditLogRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clock = new FakeClock();
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();
    sellerRepository = new FakeSellerRepository();
    auditLogRepository = new FakeAuditLogRepository();
    app = createApp({
      config: baseConfig,
      userRepository,
      sessionRepository,
      sellerRepository,
      catalogRepository: inertCatalogRepository,
      productRepository: inertProductRepository,
      cartRepository: inertCartRepository,
      auditLogRepository,
      passwordHasher: new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations),
      clock,
      clientIpResolver: headerIpResolver,
    });
  });

  async function registerAdmin(): Promise<{ cookie: string; userId: string }> {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "password123", name: "Admin" }),
    });
    expect(register.status).toBe(201);
    const body = (await register.json()) as { ok: true; data: AuthUserResponse };
    const user = userRepository.getUser(body.data.user.id)!;
    userRepository.setUser({ ...user, role: "admin" });
    return { cookie: extractSessionCookie(register), userId: body.data.user.id };
  }

  async function registerCustomer(email: string): Promise<void> {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123", name: "Customer" }),
    });
    expect(register.status).toBe(201);
    const body = (await register.json()) as { ok: true; data: AuthUserResponse };
    expect(userRepository.getUser(body.data.user.id)).not.toBeUndefined();
  }

  function pendingRecord(
    id: string,
    userId: string,
    email: string,
    createdAt: Date,
  ): PendingSellerRecord {
    return {
      sellerProfile: {
        id,
        userId,
        slug: `slug-${id}`,
        displayName: "Pending Seller",
        status: "pending",
        createdAt,
        updatedAt: createdAt,
      },
      user: {
        id: userId,
        email,
        name: "Pending Seller",
        status: "active",
        createdAt,
      },
      store: {
        id: `store-${id}`,
        sellerProfileId: id,
        name: "Pending Store",
        slug: `store-slug-${id}`,
        description: null,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      },
    };
  }

  it("is gated behind admin auth (401 SESSION_EXPIRED / 403 FORBIDDEN)", async () => {
    const anonymous = await app.request("/api/admin/sellers/pending");
    await expectFailure(anonymous, "SESSION_EXPIRED", 401);

    const customer = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "customer@example.com", password: "password123", name: "C" }),
    });
    expect(customer.status).toBe(201);
    const cookie = extractSessionCookie(customer);
    const forbidden = await app.request("/api/admin/sellers/pending", {
      headers: { Cookie: cookie },
    });
    expect(forbidden.status).toBe(403);
    const envelope = (await forbidden.json()) as ApiFailure;
    expect(envelope.error.code).toBe("FORBIDDEN");
  });

  it("lists only pending applications oldest-first without credential material", async () => {
    const { cookie } = await registerAdmin();
    await registerCustomer("ada@example.com");

    sellerRepository.seedPendingSeller(
      pendingRecord("shop-2", "user-2", "second@example.com", new Date("2026-02-01T00:00:00.000Z")),
    );
    sellerRepository.seedPendingSeller(
      pendingRecord("shop-1", "user-1", "first@example.com", new Date("2026-01-01T00:00:00.000Z")),
    );

    const response = await app.request("/api/admin/sellers/pending", { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("csrfToken");

    const body = JSON.parse(raw) as {
      ok: true;
      data: {
        items: Array<{
          sellerProfile: { id: string; status: string };
          user: { email: string };
          store: { status: string };
        }>;
        nextCursor: string | null;
      };
    };
    expect(body.data.items.map((item) => item.sellerProfile.id)).toEqual(["shop-1", "shop-2"]);
    expect(body.data.items[0]!.user.email).toBe("first@example.com");
    expect(body.data.items[0]!.sellerProfile.status).toBe("pending");
    expect(body.data.items[0]!.store.status).toBe("draft");
    expect(body.data.nextCursor).toBeNull();
  });

  it("clamps the page size and returns a nextCursor when more pages remain", async () => {
    const { cookie } = await registerAdmin();
    for (let index = 0; index < 3; index++) {
      sellerRepository.seedPendingSeller(
        pendingRecord(
          `shop-${index}`,
          `user-${index}`,
          `${index}@example.com`,
          new Date(2026, 0, 1 + index),
        ),
      );
    }

    const response = await app.request("/api/admin/sellers/pending?limit=2", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const first = (await response.json()) as {
      ok: true;
      data: { items: Array<{ sellerProfile: { id: string } }>; nextCursor: string | null };
    };
    expect(first.data.items).toHaveLength(2);
    expect(first.data.nextCursor).not.toBeNull();

    const second = await app.request(
      `/api/admin/sellers/pending?limit=2&cursor=${first.data.nextCursor}`,
      { headers: { Cookie: cookie } },
    );
    expect(second.status).toBe(200);
    const last = (await second.json()) as {
      ok: true;
      data: { items: Array<{ sellerProfile: { id: string } }>; nextCursor: string | null };
    };
    expect(last.data.items).toHaveLength(1);
    expect(last.data.nextCursor).toBeNull();
  });

  it("rejects an out-of-range limit with 422 VALIDATION_ERROR", async () => {
    const { cookie } = await registerAdmin();
    const response = await app.request("/api/admin/sellers/pending?limit=999", {
      headers: { Cookie: cookie },
    });
    await expectFailure(response, "VALIDATION_ERROR", 422);
  });
});

describe("POST /api/admin/sellers/:userId/reject", () => {
  let clock: FakeClock;
  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let sellerRepository: FakeSellerRepository;
  let auditLogRepository: FakeAuditLogRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clock = new FakeClock();
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();
    sellerRepository = new FakeSellerRepository();
    auditLogRepository = new FakeAuditLogRepository();
    app = createApp({
      config: baseConfig,
      userRepository,
      sessionRepository,
      sellerRepository,
      catalogRepository: inertCatalogRepository,
      productRepository: inertProductRepository,
      cartRepository: inertCartRepository,
      auditLogRepository,
      passwordHasher: new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations),
      clock,
      clientIpResolver: headerIpResolver,
    });
  });

  async function postJson(path: string, cookie?: string, csrfToken?: string) {
    return app.request(path, {
      method: "POST",
      headers: {
        ...(cookie === undefined ? {} : { Cookie: cookie }),
        ...(csrfToken === undefined ? {} : { "X-Zelora-CSRF": csrfToken }),
      },
    });
  }

  async function adminSession(): Promise<{ cookie: string; csrfToken: string; userId: string }> {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "password123", name: "Admin" }),
    });
    expect(register.status).toBe(201);
    const body = (await register.json()) as { ok: true; data: AuthUserResponse };
    const user = userRepository.getUser(body.data.user.id)!;
    userRepository.setUser({ ...user, role: "admin" });
    return {
      cookie: extractSessionCookie(register),
      csrfToken: body.data.session.csrfToken,
      userId: body.data.user.id,
    };
  }

  function seedPending(userId: string, id: string, status: "pending" | "rejected" = "pending"): void {
    const now = new Date("2026-01-01T00:00:00.000Z");
    sellerRepository.seedProfile({
      id,
      userId,
      slug: `reject-${id}`,
      displayName: "Pending Seller",
      status,
      createdAt: now,
      updatedAt: now,
    });
    sellerRepository.seedStore({
      id: `store-${id}`,
      sellerProfileId: id,
      name: "Pending Store",
      slug: `store-reject-${id}`,
      description: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
  }

  it("unauthenticated request returns 401 SESSION_EXPIRED", async () => {
    const response = await postJson("/api/admin/sellers/00000000-0000-7000-8000-000000000001/reject");
    await expectFailure(response, "SESSION_EXPIRED", 401);
  });

  it("a customer cannot reject a seller (403 FORBIDDEN)", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "customer@example.com", password: "password123", name: "C" }),
    });
    expect(register.status).toBe(201);
    const cookie = extractSessionCookie(register);
    const response = await postJson(
      "/api/admin/sellers/00000000-0000-7000-8000-000000000001/reject",
      cookie,
    );
    await expectFailure(response, "FORBIDDEN", 403);
  });

  it("an admin without a CSRF token is rejected (403 CSRF_FAILED)", async () => {
    const { cookie } = await adminSession();
    const response = await postJson(
      "/api/admin/sellers/00000000-0000-7000-8000-000000000001/reject",
      cookie,
    );
    await expectFailure(response, "CSRF_FAILED", 403);
  });

  it("a non-UUIDv7 userId path param returns 404 NOT_FOUND", async () => {
    const { cookie, csrfToken } = await adminSession();
    const response = await postJson("/api/admin/sellers/not-an-id/reject", cookie, csrfToken);
    await expectFailure(response, "NOT_FOUND", 404);
  });

  it("rejecting an unknown seller returns 404 NOT_FOUND", async () => {
    const { cookie, csrfToken } = await adminSession();
    const response = await postJson(`/api/admin/sellers/${createId()}/reject`, cookie, csrfToken);
    await expectFailure(response, "NOT_FOUND", 404);
  });

  it("rejects a pending seller and audits seller.reject", async () => {
    const { cookie, csrfToken, userId: adminUserId } = await adminSession();
    const sellerUserId = createId();
    const sellerProfileId = createId();
    seedPending(sellerUserId, sellerProfileId);

    const response = await postJson(`/api/admin/sellers/${sellerUserId}/reject`, cookie, csrfToken);

    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("passwordHash");
    const body = JSON.parse(raw) as {
      ok: true;
      data: { status: string; userId: string };
    };
    expect(body.data.status).toBe("rejected");
    expect(body.data.userId).toBe(sellerUserId);

    const after = sellerRepository.findByUserId(sellerUserId);
    expect(await after).toMatchObject({ status: "rejected" });

    expect(auditLogRepository.entries).toHaveLength(1);
    expect(auditLogRepository.entries[0]!.action).toBe("seller.reject");
    expect(auditLogRepository.entries[0]!.actorUserId).toBe(adminUserId);
    expect(auditLogRepository.entries[0]!.targetUserId).toBe(sellerUserId);
  });

  it("is idempotent for an already-rejected profile (200, no duplicate audit)", async () => {
    const { cookie, csrfToken } = await adminSession();
    const sellerUserId = createId();
    seedPending(sellerUserId, createId(), "rejected");

    const first = await postJson(`/api/admin/sellers/${sellerUserId}/reject`, cookie, csrfToken);
    expect(first.status).toBe(200);
    expect(auditLogRepository.entries).toHaveLength(0);

    const second = await postJson(`/api/admin/sellers/${sellerUserId}/reject`, cookie, csrfToken);
    expect(second.status).toBe(200);
    expect(auditLogRepository.entries).toHaveLength(0);
  });

  it("blocks rejecting an active profile (409 SELLER_REJECTION_BLOCKED)", async () => {
    const { cookie, csrfToken } = await adminSession();
    const sellerUserId = createId();
    const sellerProfileId = createId();
    const now = new Date("2026-01-01T00:00:00.000Z");
    sellerRepository.seedProfile({
      id: sellerProfileId,
      userId: sellerUserId,
      slug: "active-shop",
      displayName: "Active Seller",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const response = await postJson(`/api/admin/sellers/${sellerUserId}/reject`, cookie, csrfToken);
    await expectFailure(response, "SELLER_REJECTION_BLOCKED", 409);
    expect(auditLogRepository.entries).toHaveLength(0);
  });
});