import { beforeEach, describe, expect, it, vi } from "vitest";
import { PBKDF2PasswordHasher, type AppConfig, type PasswordHasher } from "@zelora/core";
import type {
  AuthSessionRecord,
  AuthSessionRepository,
  CreateAuthSessionInput,
} from "@zelora/db/auth";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { UserRecord, UserRepository, CreateAdminResult, CreateUserInput } from "@zelora/db/users";
import type { SellerRepository } from "@zelora/db/seller";
import type { CartRepository } from "@zelora/db/cart";
import type { CatalogRepository } from "@zelora/db/catalog";
import type { ProductRepository } from "@zelora/db/products";
import type { ApiFailure, AuthUserResponse } from "@zelora/shared";
import { createApp } from "../app";
import type { Clock } from "../services/clock";
import type { ClientIpResolver } from "../services/client-ip";
import { MemoryWindowRateLimiter } from "../services/rate-limit";

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
    return Array.from(this.sessions.values()).filter(
      (session) => session.userId === userId,
    );
  }

  clear(): void {
    this.sessions.clear();
    this.nextId = 1;
  }
}

/**
 * Auth routes never touch the seller repository; this stub fails loudly if
 * anything surprised us by invoking it.
 */
const unimplementedSeller = (): never => {
  throw new Error("unexpected seller repository call");
};

const sellerRepository: SellerRepository = {
  findByUserId: unimplementedSeller,
  findByProfileSlug: unimplementedSeller,
  findStoreBySlug: unimplementedSeller,
  findStoreBySellerProfileId: unimplementedSeller,
  createOnboarding: unimplementedSeller,
  activateSeller: unimplementedSeller,
  listPendingProfiles: unimplementedSeller,
  rejectSeller: unimplementedSeller,
};

const inertAuditLogRepository: AuditLogRepository = {
  create: unimplementedSeller,
  listByAction: unimplementedSeller,
};

/**
 * Auth route tests never hit the catalog, but `createApp` composes it. Any
 * accidental invocation would reveal a wiring bug loudly.
 */
const inertCatalogRepository: CatalogRepository = {
  listActiveCategories: unimplementedSeller,
  listActiveProducts: unimplementedSeller,
  findProductBySlug: unimplementedSeller,
  findVariantById: unimplementedSeller,
  findActiveStoreBySlug: unimplementedSeller,
  listStoreProducts: unimplementedSeller,
};

/**
 * Auth route tests never touch the product repository, but `createApp`
 * composes the seller service with it. Any accidental invocation would reveal
 * a wiring bug loudly.
 */
const inertProductRepository: ProductRepository = {
  findByStoreAndSlug: unimplementedSeller,
  createProduct: unimplementedSeller,
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

describe("auth routes", () => {
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

  let clock: FakeClock;
  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let passwordHasher: PasswordHasher;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clock = new FakeClock();
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();
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
    });
  });

  function postJson(path: string, body: unknown, cookie?: string, csrfToken?: string) {
    return app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie === undefined ? {} : { Cookie: cookie }),
        ...(csrfToken === undefined ? {} : { "X-Zelora-CSRF": csrfToken }),
      },
      body: JSON.stringify(body),
    });
  }

  function getWithCookie(path: string, cookie: string) {
    return app.request(path, { headers: { Cookie: cookie } });
  }

  function extractSessionCookie(response: Response): string {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie === null) {
      throw new Error("expected a set-cookie header");
    }
    return setCookie.split(";")[0] ?? "";
  }

  async function registerSession(
    overrides: Record<string, unknown> = {},
  ): Promise<{
    response: Response;
    cookie: string;
    csrfToken: string;
    userId: string;
  }> {
    const response = await register(overrides);
    const body = (await response.json()) as { ok: true; data: AuthUserResponse };
    return {
      response,
      cookie: extractSessionCookie(response),
      csrfToken: body.data.session.csrfToken,
      userId: body.data.user.id,
    };
  }

  async function loginSession(): Promise<{
    response: Response;
    cookie: string;
    csrfToken: string;
  }> {
    const response = await postJson("/api/auth/login", {
      email: "user@example.com",
      password: "password123",
    });
    const body = (await response.json()) as { ok: true; data: AuthUserResponse };
    return {
      response,
      cookie: extractSessionCookie(response),
      csrfToken: body.data.session.csrfToken,
    };
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

  async function register(
    overrides: Record<string, unknown> = {},
  ): Promise<Response> {
    return postJson("/api/auth/register", {
      email: "user@example.com",
      password: "password123",
      name: "Ada Lovelace",
      ...overrides,
    });
  }

  describe("POST /api/auth/register", () => {
    it("A: registration works without a CSRF header", async () => {
      const response = await register();

      expect(response.status).toBe(201);
      expect(response.headers.get("set-cookie")).toMatch(/^zelora_session=/);
    });

    it("A: returns 201 with ok=true, user, session, and a session cookie", async () => {
      const response = await register();

      expect(response.status).toBe(201);
      const body = (await response.json()) as { ok: true; data: AuthUserResponse };
      expect(body.ok).toBe(true);

      expect(body.data.user.id).toBeDefined();
      expect(body.data.user.email).toBe("user@example.com");
      expect(body.data.user.name).toBe("Ada Lovelace");
      expect(body.data.user.role).toBe("customer");
      expect(body.data.user.status).toBe("active");
      expect(Number.isNaN(Date.parse(body.data.user.createdAt))).toBe(false);

      expect(body.data.session.id).toBeDefined();
      expect(Number.isNaN(Date.parse(body.data.session.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(body.data.session.expiresAt))).toBe(false);
      expect(body.data.session.csrfToken.length).toBeGreaterThan(0);

      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).toMatch(/^zelora_session=/);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain(`Max-Age=${baseConfig.sessionTtlSeconds}`);
      expect(setCookie).not.toContain("Secure");
    });

    it("A: never exposes passwordHash or the raw session token in the body", async () => {
      const response = await register();
      const rawBody = await response.text();

      expect(rawBody).not.toContain("passwordHash");
      expect(rawBody).not.toContain("$password");

      const cookie = extractSessionCookie(response);
      const rawToken = cookie.slice(cookie.indexOf("=") + 1);
      expect(rawToken.length).toBeGreaterThan(0);
      expect(rawBody).not.toContain(rawToken);
    });

    it("A: registers a customer regardless of client-supplied role/status/id", async () => {
      const response = await register({
        role: "admin",
        status: "deleted",
        id: "spoofed-id",
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as { ok: true; data: AuthUserResponse };
      expect(body.data.user.role).toBe("customer");
      expect(body.data.user.status).toBe("active");
      expect(body.data.user.id).not.toBe("spoofed-id");
    });

    it("B: duplicate email returns EMAIL_IN_USE 409 and no session cookie", async () => {
      const first = await register();
      expect(first.status).toBe(201);
      const userId = ((await first.json()) as { ok: true; data: AuthUserResponse }).data.user.id;

      const response = await register({ name: "Someone Else" });

      const failure = await expectFailure(response, "EMAIL_IN_USE", 409);
      expect(failure.error.message).toBeDefined();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(sessionRepository.getSessionsForUser(userId)).toHaveLength(1);
    });

    it("B: a registration that fails validation issues no session cookie", async () => {
      const response = await postJson("/api/auth/register", {
        email: "not-an-email",
        password: "short",
        name: "",
      });

      const failure = await expectFailure(response, "VALIDATION_ERROR", 422);
      expect(failure.error.fields?.email).toBeDefined();
      expect(failure.error.fields?.password).toBeDefined();
      expect(response.headers.get("set-cookie")).toBeNull();
      await expect(userRepository.findByEmail("not-an-email")).resolves.toBeNull();
    });

    it("B: malformed JSON body fails validation instead of leaking an exception", async () => {
      const response = await app.request("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });

      const failure = await expectFailure(response, "VALIDATION_ERROR", 422);
      expect(failure.error.fields?.body).toBeDefined();
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  });

  describe("POST /api/auth/login", () => {
    beforeEach(async () => {
      expect((await register()).status).toBe(201);
    });

    it("C: login works without a CSRF header", async () => {
      const response = await postJson("/api/auth/login", {
        email: "user@example.com",
        password: "password123",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toMatch(/^zelora_session=/);
    });

    it("C: valid login returns 200 with user, session and a session cookie", async () => {
      const response = await postJson("/api/auth/login", {
        email: "user@example.com",
        password: "password123",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: true; data: AuthUserResponse };
      expect(body.ok).toBe(true);
      expect(body.data.user.email).toBe("user@example.com");
      expect(body.data.user.role).toBe("customer");
      expect(body.data.user.status).toBe("active");
      expect(body.data.session.csrfToken.length).toBeGreaterThan(0);

      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).toMatch(/^zelora_session=/);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");
    });

    it("C: never exposes passwordHash or the raw session token", async () => {
      const response = await postJson("/api/auth/login", {
        email: "user@example.com",
        password: "password123",
      });
      const rawBody = await response.text();

      expect(rawBody).not.toContain("passwordHash");
      const cookie = extractSessionCookie(response);
      const rawToken = cookie.slice(cookie.indexOf("=") + 1);
      expect(rawBody).not.toContain(rawToken);
    });

    it("C: ignores client-supplied role/status/id on login", async () => {
      const response = await postJson("/api/auth/login", {
        email: "user@example.com",
        password: "password123",
        role: "admin",
        status: "deleted",
        id: "spoofed-id",
      });

      const body = (await response.json()) as { ok: true; data: AuthUserResponse };
      expect(body.data.user.role).toBe("customer");
      expect(body.data.user.status).toBe("active");
      expect(body.data.user.id).not.toBe("spoofed-id");
    });

    it("D: a wrong password keeps INVALID_CREDENTIALS 401 and issues no cookie", async () => {
      const response = await postJson("/api/auth/login", {
        email: "user@example.com",
        password: "wrong-password",
      });

      const failure = await expectFailure(response, "INVALID_CREDENTIALS", 401);
      expect(failure.error.message).toBe("Invalid email or password.");
      expect(failure.error.details).toBeUndefined();
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("D: an unknown email keeps INVALID_CREDENTIALS 401 with a generic message", async () => {
      const response = await postJson("/api/auth/login", {
        email: "nobody@example.com",
        password: "password123",
      });

      const failure = await expectFailure(response, "INVALID_CREDENTIALS", 401);
      expect(failure.error.message).toBe("Invalid email or password.");
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  });

  describe("POST /api/auth/logout", () => {
    it("E: unauthenticated request returns 401", async () => {
      const response = await postJson("/api/auth/logout", {});

      await expectFailure(response, "SESSION_EXPIRED", 401);
    });

    it("E: without a CSRF header returns 403 CSRF_FAILED and the session remains", async () => {
      const { cookie, csrfToken, userId } = await registerSession();
      const sessionsBefore = sessionRepository.getSessionsForUser(userId).length;

      const response = await postJson("/api/auth/logout", {}, cookie);

      expect(response.status).toBe(403);
      const rawBody = await response.text();
      const body = JSON.parse(rawBody) as ApiFailure;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("CSRF_FAILED");
      expect(body.error.message).toBe("CSRF validation failed.");
      expect(rawBody).not.toContain(csrfToken);
      expect(sessionRepository.getSessionsForUser(userId)).toHaveLength(
        sessionsBefore,
      );
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("E: with a wrong CSRF header returns 403 CSRF_FAILED and the session remains", async () => {
      const { cookie, csrfToken, userId } = await registerSession();
      const sessionsBefore = sessionRepository.getSessionsForUser(userId).length;

      const response = await postJson(
        "/api/auth/logout",
        {},
        cookie,
        "wrong-token",
      );

      expect(response.status).toBe(403);
      const rawBody = await response.text();
      const body = JSON.parse(rawBody) as ApiFailure;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("CSRF_FAILED");
      expect(body.error.message).toBe("CSRF validation failed.");
      expect(rawBody).not.toContain(csrfToken);
      expect(sessionRepository.getSessionsForUser(userId)).toHaveLength(
        sessionsBefore,
      );
    });

    it("E: deletes only the current session and clears the cookie", async () => {
      const registerResponse = await register();
      const cookieA = extractSessionCookie(registerResponse);
      const registerBody = (await registerResponse.json()) as {
        ok: true;
        data: AuthUserResponse;
      };
      const csrfA = registerBody.data.session.csrfToken;
      const userId = registerBody.data.user.id;

      const loginResponse = await postJson("/api/auth/login", {
        email: "user@example.com",
        password: "password123",
      });
      const cookieB = extractSessionCookie(loginResponse);
      expect(sessionRepository.getSessionsForUser(userId)).toHaveLength(2);

      const response = await postJson(
        "/api/auth/logout",
        {},
        cookieA,
        csrfA,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: true; data: { done: true } };
      expect(body.ok).toBe(true);
      expect(body.data.done).toBe(true);

      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).toMatch(/^zelora_session=;/);
      expect(setCookie).toContain("Max-Age=0");

      expect(sessionRepository.getSessionsForUser(userId)).toHaveLength(1);
      const meWithOther = await getWithCookie("/api/auth/me", cookieB);
      expect(meWithOther.status).toBe(200);
      const meWithLoggedOut = await getWithCookie("/api/auth/me", cookieA);
      await expectFailure(meWithLoggedOut, "SESSION_EXPIRED", 401);
    });
  });

  describe("POST /api/auth/logout-all", () => {
    it("F: unauthenticated request returns 401", async () => {
      const response = await postJson("/api/auth/logout-all", {});

      await expectFailure(response, "SESSION_EXPIRED", 401);
    });

    it("F: without a CSRF header returns 403 and all sessions remain", async () => {
      const { cookie, csrfToken, userId } = await registerSession();
      await loginSession();
      const sessionsBefore = sessionRepository.getSessionsForUser(userId).length;
      expect(sessionsBefore).toBe(2);

      const response = await postJson("/api/auth/logout-all", {}, cookie);

      expect(response.status).toBe(403);
      const rawBody = await response.text();
      const body = JSON.parse(rawBody) as ApiFailure;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("CSRF_FAILED");
      expect(body.error.message).toBe("CSRF validation failed.");
      expect(rawBody).not.toContain(csrfToken);
      expect(sessionRepository.getSessionsForUser(userId)).toHaveLength(
        sessionsBefore,
      );
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("F: deletes every session for the user and clears the cookie", async () => {
      const { cookie: cookieA, csrfToken: csrfA, userId } = await registerSession();

      const cookieB = extractSessionCookie(
        await postJson("/api/auth/login", {
          email: "user@example.com",
          password: "password123",
        }),
      );
      expect(sessionRepository.getSessionsForUser(userId)).toHaveLength(2);

      const response = await postJson(
        "/api/auth/logout-all",
        {},
        cookieA,
        csrfA,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: true; data: { done: true } };
      expect(body.ok).toBe(true);
      expect(body.data.done).toBe(true);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

      expect(sessionRepository.getSessionsForUser(userId)).toHaveLength(0);
      await expectFailure(await getWithCookie("/api/auth/me", cookieA), "SESSION_EXPIRED", 401);
      await expectFailure(await getWithCookie("/api/auth/me", cookieB), "SESSION_EXPIRED", 401);
    });
  });

  describe("GET /api/auth/me", () => {
    it("G: unauthenticated request returns 401", async () => {
      const response = await app.request("/api/auth/me");

      await expectFailure(response, "SESSION_EXPIRED", 401);
    });

    it("G: works without a CSRF header", async () => {
      const { cookie } = await registerSession();

      const response = await getWithCookie("/api/auth/me", cookie);

      expect(response.status).toBe(200);
    });

    it("G: returns the user DTO without passwordHash and creates no sessions", async () => {
      const registerResponse = await register();
      const cookie = extractSessionCookie(registerResponse);
      const registered = (await registerResponse.json()) as {
        ok: true;
        data: AuthUserResponse;
      };
      const sessionsBefore = sessionRepository.getSessionsForUser(
        registered.data.user.id,
      ).length;

      const response = await getWithCookie("/api/auth/me", cookie);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: true; data: { user: AuthUserResponse["user"] } };
      expect(body.ok).toBe(true);
      expect(body.data.user).toEqual({
        id: registered.data.user.id,
        email: "user@example.com",
        name: "Ada Lovelace",
        role: "customer",
        status: "active",
        createdAt: registered.data.user.createdAt,
      });
      expect(Object.keys(body.data.user)).not.toContain("passwordHash");
      expect(Object.keys(body.data.user)).not.toContain("updatedAt");

      expect(
        sessionRepository.getSessionsForUser(registered.data.user.id),
      ).toHaveLength(sessionsBefore);
    });
  });

  describe("GET /api/auth/csrf", () => {
    it("K: unauthenticated request returns 401", async () => {
      const response = await app.request("/api/auth/csrf");

      await expectFailure(response, "SESSION_EXPIRED", 401);
    });

    it("K: an authenticated client can obtain its CSRF token without a CSRF header", async () => {
      const { cookie, csrfToken } = await registerSession();

      const response = await getWithCookie("/api/auth/csrf", cookie);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: true;
        data: { csrfToken: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.csrfToken).toBe(csrfToken);
    });

    it("K: after a reload (only the cookie remains) the token is re-obtainable and logout works", async () => {
      const { cookie } = await registerSession();

      const csrfResponse = await getWithCookie("/api/auth/csrf", cookie);
      expect(csrfResponse.status).toBe(200);
      const csrfBody = (await csrfResponse.json()) as {
        ok: true;
        data: { csrfToken: string };
      };
      const reloadedCsrfToken = csrfBody.data.csrfToken;
      expect(reloadedCsrfToken.length).toBeGreaterThan(0);

      const logoutResponse = await postJson(
        "/api/auth/logout",
        {},
        cookie,
        reloadedCsrfToken,
      );
      expect(logoutResponse.status).toBe(200);
      const logoutBody = (await logoutResponse.json()) as {
        ok: true;
        data: { done: true };
      };
      expect(logoutBody.data.done).toBe(true);

      const meAfterLogout = await getWithCookie("/api/auth/me", cookie);
      await expectFailure(meAfterLogout, "SESSION_EXPIRED", 401);
    });

    it("K: never exposes the raw session cookie/token in the response body", async () => {
      const { cookie } = await registerSession();
      const rawToken = cookie.slice(cookie.indexOf("=") + 1);

      const response = await getWithCookie("/api/auth/csrf", cookie);
      const rawBody = await response.text();

      expect(response.status).toBe(200);
      expect(rawBody).not.toContain(rawToken);
    });
  });

  describe("suspended/deleted accounts", () => {
    it("H: login with a suspended account returns ACCOUNT_SUSPENDED 403 without a cookie", async () => {
      expect((await register()).status).toBe(201);
      const user = (await userRepository.findByEmail("user@example.com"))!;
      userRepository.setUser({ ...user, status: "suspended" });

      const response = await postJson("/api/auth/login", {
        email: "user@example.com",
        password: "password123",
      });

      const failure = await expectFailure(response, "ACCOUNT_SUSPENDED", 403);
      expect(failure.error.message).toBe("This account has been suspended.");
      expect(failure.error.details).toBeUndefined();
      expect(failure.error.fields).toBeUndefined();
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("H: login with a deleted account returns ACCOUNT_DELETED 403", async () => {
      expect((await register()).status).toBe(201);
      const user = (await userRepository.findByEmail("user@example.com"))!;
      userRepository.setUser({ ...user, status: "deleted" });

      const response = await postJson("/api/auth/login", {
        email: "user@example.com",
        password: "password123",
      });

      await expectFailure(response, "ACCOUNT_DELETED", 403);
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("H: a suspended account with a wrong password is still generic INVALID_CREDENTIALS", async () => {
      expect((await register()).status).toBe(201);
      const user = (await userRepository.findByEmail("user@example.com"))!;
      userRepository.setUser({ ...user, status: "suspended" });

      const response = await postJson("/api/auth/login", {
        email: "user@example.com",
        password: "wrong-password",
      });

      await expectFailure(response, "INVALID_CREDENTIALS", 401);
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("H: an existing session for a suspended account is revoked on request", async () => {
      const registerResponse = await register();
      const cookie = extractSessionCookie(registerResponse);
      const userId = ((await registerResponse.json()) as {
        ok: true;
        data: AuthUserResponse;
      }).data.user.id;
      const user = (await userRepository.findByEmail("user@example.com"))!;
      userRepository.setUser({ ...user, status: "suspended" });

      const response = await getWithCookie("/api/auth/me", cookie);

      const failure = await expectFailure(response, "ACCOUNT_SUSPENDED", 403);
      expect(failure.error.message).toBe("This account has been suspended.");
      expect(sessionRepository.getSessionsForUser(userId)).toHaveLength(0);
      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).toMatch(/^zelora_session=;/);
      expect(setCookie).toContain("Max-Age=0");
    });
  });

  describe("GET /api/health", () => {
    it("I: the existing health route still works alongside auth routes", async () => {
      const response = await app.request("/api/health");

      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: true; data: { status: string } };
      expect(body.ok).toBe(true);
      expect(body.data.status).toBe("ok");
    });
  });

  describe("auth route rate limiting", () => {
    const headerIpResolver: ClientIpResolver = {
      resolve: (c) => c.req.header("x-test-ip") ?? undefined,
    };

    function rateLimitedConfig(overrides: Partial<AppConfig> = {}): AppConfig {
      return {
        ...baseConfig,
        rateLimitLoginIpMax: 2,
        rateLimitLoginIpWindowSeconds: 900,
        rateLimitLoginEmailMax: 5,
        rateLimitLoginEmailWindowSeconds: 900,
        rateLimitRegisterIpMax: 2,
        rateLimitRegisterIpWindowSeconds: 3_600,
        ...overrides,
      };
    }

    function makeLimitedApp(
      overrides: Partial<AppConfig> = {},
    ): { app: ReturnType<typeof createApp>; limiter: MemoryWindowRateLimiter } {
      const limiter = new MemoryWindowRateLimiter(clock);
      const limitedApp = createApp({
        config: rateLimitedConfig(overrides),
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

    async function postLogin(
      limitedApp: ReturnType<typeof createApp>,
      body: Record<string, unknown>,
      ip?: string,
    ): Promise<Response> {
      return await limitedApp.request("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ip === undefined ? {} : { "X-Test-IP": ip }),
        },
        body: JSON.stringify(body),
      });
    }

    async function postRegister(
      limitedApp: ReturnType<typeof createApp>,
      body: Record<string, unknown>,
      ip?: string,
    ): Promise<Response> {
      return await limitedApp.request("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ip === undefined ? {} : { "X-Test-IP": ip }),
        },
        body: JSON.stringify(body),
      });
    }

    it("J: multiple login attempts from one IP eventually return 429 with Retry-After", async () => {
      const { app } = makeLimitedApp({
        rateLimitLoginIpMax: 3,
        rateLimitLoginEmailMax: 100,
      });

      for (let i = 0; i < 3; i += 1) {
        const response = await postLogin(
          app,
          { email: `user${i}@example.com`, password: "password123" },
          "203.0.113.10",
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("retry-after")).toBeNull();
      }

      const blocked = await postLogin(
        app,
        { email: "user3@example.com", password: "password123" },
        "203.0.113.10",
      );
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("900");
      const body = (await blocked.json()) as ApiFailure;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(body.error.details).toEqual({ retryAfterSeconds: 900, scope: "ip" });
    });

    it("J: multiple registrations from one IP eventually return 429", async () => {
      const { app } = makeLimitedApp();

      expect(
        (
          await postRegister(
            app,
            { email: "a@example.com", password: "password123", name: "A" },
            "203.0.113.20",
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await postRegister(
            app,
            { email: "b@example.com", password: "password123", name: "B" },
            "203.0.113.20",
          )
        ).status,
      ).toBe(201);

      const blocked = await postRegister(
        app,
        { email: "c@example.com", password: "password123", name: "C" },
        "203.0.113.20",
      );
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("3600");
      await expect(userRepository.findByEmail("c@example.com")).resolves.toBeNull();
    });

    it("J: login limits are independent per IP", async () => {
      const { app } = makeLimitedApp({
        rateLimitLoginIpMax: 1,
        rateLimitLoginEmailMax: 100,
      });

      expect(
        (
          await postLogin(
            app,
            { email: "u1@example.com", password: "password123" },
            "203.0.113.30",
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await postLogin(
            app,
            { email: "u1@example.com", password: "password123" },
            "203.0.113.30",
          )
        ).status,
      ).toBe(429);
      expect(
        (
          await postLogin(
            app,
            { email: "u1@example.com", password: "password123" },
            "198.51.100.30",
          )
        ).status,
      ).toBe(401);
    });

    it("J: a successful login resets the email limiter", async () => {
      const { app, limiter } = makeLimitedApp({
        rateLimitLoginIpMax: 100,
        rateLimitLoginEmailMax: 3,
      });
      expect(
        (
          await postRegister(
            app,
            { email: "user@example.com", password: "password123", name: "Ada" },
            "203.0.113.40",
          )
        ).status,
      ).toBe(201);

      expect(
        (
          await postLogin(
            app,
            { email: "user@example.com", password: "wrong-password-1" },
            "203.0.113.40",
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await postLogin(
            app,
            { email: "user@example.com", password: "wrong-password-2" },
            "203.0.113.40",
          )
        ).status,
      ).toBe(401);

      const resetSpy = vi.spyOn(limiter, "reset");
      const good = await postLogin(
        app,
        { email: "user@example.com", password: "password123" },
        "203.0.113.40",
      );
      expect(good.status).toBe(200);
      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(resetSpy).toHaveBeenCalledWith("auth:login:email:user@example.com");
    });

    it("J: an over-limit email stays a generic 401, never a 429", async () => {
      const { app } = makeLimitedApp({
        rateLimitLoginIpMax: 100,
        rateLimitLoginEmailMax: 2,
      });
      expect(
        (
          await postRegister(
            app,
            { email: "user@example.com", password: "password123", name: "Ada" },
            "203.0.113.50",
          )
        ).status,
      ).toBe(201);

      expect(
        (
          await postLogin(
            app,
            { email: "user@example.com", password: "wrong-password-1" },
            "203.0.113.50",
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await postLogin(
            app,
            { email: "user@example.com", password: "wrong-password-2" },
            "203.0.113.50",
          )
        ).status,
      ).toBe(401);

      const blocked = await postLogin(
        app,
        { email: "user@example.com", password: "password123" },
        "203.0.113.50",
      );
      expect(blocked.status).toBe(401);
      expect(blocked.headers.get("retry-after")).toBeNull();
      const body = (await blocked.json()) as ApiFailure;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
      expect(body.error.details).toBeUndefined();
    });
  });
});