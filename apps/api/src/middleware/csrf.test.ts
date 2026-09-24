import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  constantTimeEqual,
  generateSessionToken,
  hashSessionToken,
  type AppConfig,
  type Logger,
} from "@zelora/core";
import { AUTH_ERROR_CODES, type ApiFailure } from "@zelora/shared";
import type {
  AuthSessionRecord,
  AuthSessionRepository,
  CreateAuthSessionInput,
} from "@zelora/db/auth";
import type { UserRecord, UserRepository, CreateAdminResult, CreateUserInput } from "@zelora/db/users";
import type { Clock } from "../services/clock";
import type { AppEnv } from "../context";
import { createErrorHandler } from "./error";
import { createAuthMiddleware } from "./auth";
import { createCsrfMiddleware, CSRF_HEADER } from "./csrf";
import type * as CoreModule from "@zelora/core";

vi.mock("@zelora/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    constantTimeEqual: vi.fn(actual.constantTimeEqual),
  };
});

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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
    return record;
  }

  async createAdmin(input: CreateUserInput): Promise<CreateAdminResult> {
    return { ok: true, user: await this.create(input) };
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    for (const user of this.users.values()) {
      if (user.email === email) {
        return user;
      }
    }
    return null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  setUser(record: UserRecord): void {
    this.users.set(record.id, record);
  }

  clear(): void {
    this.users.clear();
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

  clear(): void {
    this.sessions.clear();
    this.nextId = 1;
  }
}

describe("csrf middleware", () => {
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
    adminBootstrapSecret: null,
  };

  const expectedCsrfToken = "expected-csrf-token";

  let clock: FakeClock;
  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let user: UserRecord;
  let rawToken: string;
  let cookie: string;
  let app: Hono<AppEnv>;

  function buildApp(): Hono<AppEnv> {
    const testApp = new Hono<AppEnv>();
    testApp.onError(createErrorHandler(silentLogger));
    testApp.use(
      "/csrf",
      createAuthMiddleware({
        sessionRepository,
        userRepository,
        clock,
        config: baseConfig,
      }),
      createCsrfMiddleware(),
    );
    testApp.get("/csrf", (c) => c.json({ ok: true, method: "GET" }));
    testApp.on("HEAD", "/csrf", (c) => c.json({ ok: true, method: "HEAD" }));
    testApp.options("/csrf", (c) => c.json({ ok: true, method: "OPTIONS" }));
    testApp.post("/csrf", (c) => c.json({ ok: true, method: "POST" }));
    testApp.put("/csrf", (c) => c.json({ ok: true, method: "PUT" }));
    testApp.patch("/csrf", (c) => c.json({ ok: true, method: "PATCH" }));
    testApp.delete("/csrf", (c) => c.json({ ok: true, method: "DELETE" }));
    return testApp;
  }

  function buildCsrfOnlyApp(): Hono<AppEnv> {
    const testApp = new Hono<AppEnv>();
    testApp.onError(createErrorHandler(silentLogger));
    testApp.use("/csrf", createCsrfMiddleware());
    testApp.post("/csrf", (c) => c.json({ ok: true, method: "POST" }));
    return testApp;
  }

  async function request(
    method: string,
    options: { csrf?: string; cookie?: string } = {},
  ): Promise<Response> {
    return await app.request("/csrf", {
      method,
      headers: {
        ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
        ...(options.csrf === undefined ? {} : { [CSRF_HEADER]: options.csrf }),
      },
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

  beforeEach(async () => {
    vi.clearAllMocks();
    clock = new FakeClock();
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();

    user = await userRepository.create({
      email: "user@example.com",
      name: "Ada",
      passwordHash: "hash",
    });
    rawToken = generateSessionToken();
    const tokenHash = await hashSessionToken(rawToken);
    cookie = `${baseConfig.sessionCookieName}=${rawToken}`;
    await sessionRepository.create({
      userId: user.id,
      tokenHash,
      csrfToken: expectedCsrfToken,
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });

    app = buildApp();
  });

  it("A: GET skips CSRF and reaches next", async () => {
    const response = await request("GET", { cookie: cookie });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, method: "GET" });
    expect(constantTimeEqual).not.toHaveBeenCalled();
  });

  it("B: HEAD skips CSRF and reaches next", async () => {
    const response = await request("HEAD", { cookie: cookie });

    expect(response.status).toBe(200);
    expect(constantTimeEqual).not.toHaveBeenCalled();
  });

  it("C: OPTIONS skips CSRF and reaches next", async () => {
    const response = await request("OPTIONS", { cookie: cookie });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, method: "OPTIONS" });
    expect(constantTimeEqual).not.toHaveBeenCalled();
  });

  it("D: POST without CSRF header returns 403 CSRF_FAILED", async () => {
    const response = await request("POST", { cookie: cookie });

    const failure = await expectFailure(response, AUTH_ERROR_CODES.CSRF_FAILED, 403);
    expect(failure.error.message).toBe("CSRF validation failed.");
    expect(failure.error.details).toBeUndefined();
    expect(constantTimeEqual).not.toHaveBeenCalled();
  });

  it("E: POST with an empty CSRF header returns 403 CSRF_FAILED", async () => {
    const response = await request("POST", { cookie: cookie, csrf: "" });

    const failure = await expectFailure(response, AUTH_ERROR_CODES.CSRF_FAILED, 403);
    expect(failure.error.message).toBe("CSRF validation failed.");
    expect(failure.error.details).toBeUndefined();
    expect(constantTimeEqual).not.toHaveBeenCalled();
  });

  it("F: POST with an incorrect CSRF token returns 403 CSRF_FAILED", async () => {
    const response = await request("POST", {
      cookie: cookie,
      csrf: "wrong-token",
    });

    const failure = await expectFailure(response, AUTH_ERROR_CODES.CSRF_FAILED, 403);
    expect(failure.error.message).toBe("CSRF validation failed.");
    expect(constantTimeEqual).toHaveBeenCalledTimes(1);
  });

  it("G: POST with the correct CSRF token calls next", async () => {
    const response = await request("POST", {
      cookie: cookie,
      csrf: expectedCsrfToken,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, method: "POST" });
  });

  it("H: PUT with the correct CSRF token calls next", async () => {
    const response = await request("PUT", {
      cookie: cookie,
      csrf: expectedCsrfToken,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, method: "PUT" });
  });

  it("I: PATCH with the correct CSRF token calls next", async () => {
    const response = await request("PATCH", {
      cookie: cookie,
      csrf: expectedCsrfToken,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, method: "PATCH" });
  });

  it("J: DELETE with the correct CSRF token calls next", async () => {
    const response = await request("DELETE", {
      cookie: cookie,
      csrf: expectedCsrfToken,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, method: "DELETE" });
  });

  it("K: unsafe request without authenticated context fails safely with CSRF_FAILED", async () => {
    app = buildCsrfOnlyApp();

    const response = await request("POST", { csrf: expectedCsrfToken });

    const failure = await expectFailure(response, AUTH_ERROR_CODES.CSRF_FAILED, 403);
    expect(failure.error.message).toBe("CSRF validation failed.");
    expect(failure.error.details).toBeUndefined();
  });

  it("L: the expected CSRF token never appears in an error response", async () => {
    const wrongToken = "definitely-wrong";
    const response = await request("POST", { cookie: cookie, csrf: wrongToken });

    expect(response.status).toBe(403);
    const rawBody = await response.text();
    const body = JSON.parse(rawBody) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(AUTH_ERROR_CODES.CSRF_FAILED);
    expect(body.error.details).toBeUndefined();
    expect(rawBody).not.toContain(expectedCsrfToken);
    expect(rawBody).not.toContain(wrongToken);
  });

  it("M: compares tokens with constantTimeEqual rather than ==", async () => {
    const response = await request("POST", {
      cookie: cookie,
      csrf: expectedCsrfToken,
    });

    expect(response.status).toBe(200);
    expect(constantTimeEqual).toHaveBeenCalledTimes(1);
    const call = vi.mocked(constantTimeEqual).mock.calls[0]!;
    expect(call[0]).toBeInstanceOf(Uint8Array);
    expect(call[1]).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(call[0])).toBe(expectedCsrfToken);
    expect(new TextDecoder().decode(call[1])).toBe(expectedCsrfToken);
  });
});