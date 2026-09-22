import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
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
import type { UserRecord, UserRepository } from "@zelora/db/users";
import type { Clock } from "../services/clock";
import type { AppEnv } from "../context";
import { createErrorHandler } from "./error";
import { createAuthMiddleware } from "./auth";

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
  private lastCreateInput: CreateAuthSessionInput | null = null;
  private nextId = 1;

  async create(input: CreateAuthSessionInput): Promise<AuthSessionRecord> {
    this.lastCreateInput = input;
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

  getLastCreateInput(): CreateAuthSessionInput | null {
    return this.lastCreateInput;
  }

  getSessionsForUser(userId: string): AuthSessionRecord[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.userId === userId,
    );
  }

  getAll(): AuthSessionRecord[] {
    return Array.from(this.sessions.values());
  }

  clear(): void {
    this.sessions.clear();
    this.lastCreateInput = null;
    this.nextId = 1;
  }
}

describe("auth middleware", () => {
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
  };

  let clock: FakeClock;
  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let user: UserRecord;
  let session: AuthSessionRecord;
  let app: Hono<AppEnv>;

  function createApp(): Hono<AppEnv> {
    const testApp = new Hono<AppEnv>();
    testApp.onError(createErrorHandler(silentLogger));
    testApp.use(
      "/protected",
      createAuthMiddleware({
        sessionRepository,
        userRepository,
        clock,
        config: baseConfig,
      }),
    );
    testApp.get("/protected", (c) => {
      const auth = c.get("auth");
      return c.json({ sessionId: auth.session.id, userId: auth.user.id });
    });
    return testApp;
  }

  async function request(cookie?: string): Promise<Response> {
    return app.request("/protected", {
      headers: cookie === undefined ? {} : { Cookie: cookie },
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
    clock = new FakeClock();
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();

    user = await userRepository.create({
      email: "user@example.com",
      name: "Ada",
      passwordHash: "hash",
    });
    const rawToken = generateSessionToken();
    const tokenHash = await hashSessionToken(rawToken);
    session = await sessionRepository.create({
      userId: user.id,
      tokenHash,
      csrfToken: "csrf-token",
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });

    app = createApp();
  });

  it("A: missing cookie returns SESSION_EXPIRED 401 without a session lookup", async () => {
    const findByTokenHash = vi.spyOn(sessionRepository, "findByTokenHash");

    const response = await request();

    await expectFailure(response, AUTH_ERROR_CODES.SESSION_EXPIRED, 401);
    expect(findByTokenHash).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("B: unknown session token is hashed, looked up, cookie cleared, SESSION_EXPIRED 401", async () => {
    sessionRepository.clear();
    const findByTokenHash = vi.spyOn(sessionRepository, "findByTokenHash");
    const unknownToken = generateSessionToken();

    const response = await request(
      `${baseConfig.sessionCookieName}=${unknownToken}`,
    );

    await expectFailure(response, AUTH_ERROR_CODES.SESSION_EXPIRED, 401);
    expect(findByTokenHash).toHaveBeenCalledTimes(1);
    expect(findByTokenHash).toHaveBeenCalledWith(
      await hashSessionToken(unknownToken),
    );
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toMatch(/^zelora_session=;/);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("C: expired session is deleted, cookie cleared, SESSION_EXPIRED 401", async () => {
    const rawToken = generateSessionToken();
    session.tokenHash = await hashSessionToken(rawToken);
    clock.set(session.expiresAt);

    const response = await request(
      `${baseConfig.sessionCookieName}=${rawToken}`,
    );

    await expectFailure(response, AUTH_ERROR_CODES.SESSION_EXPIRED, 401);
    expect(sessionRepository.getAll()).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toMatch(/^zelora_session=;/);
  });

  it("H: session expiring exactly at clock.now() is treated as expired", async () => {
    const rawToken = generateSessionToken();
    session.tokenHash = await hashSessionToken(rawToken);
    session.expiresAt = clock.now();

    const response = await request(
      `${baseConfig.sessionCookieName}=${rawToken}`,
    );

    await expectFailure(response, AUTH_ERROR_CODES.SESSION_EXPIRED, 401);
    expect(sessionRepository.getAll()).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toMatch(/^zelora_session=;/);
  });

  it("D: missing user deletes the session, clears the cookie, SESSION_EXPIRED 401", async () => {
    const rawToken = generateSessionToken();
    session.tokenHash = await hashSessionToken(rawToken);
    userRepository.clear();

    const response = await request(
      `${baseConfig.sessionCookieName}=${rawToken}`,
    );

    await expectFailure(response, AUTH_ERROR_CODES.SESSION_EXPIRED, 401);
    expect(sessionRepository.getAll()).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toMatch(/^zelora_session=;/);
  });

  it("E: suspended user has all sessions deleted, cookie cleared, ACCOUNT_SUSPENDED 403", async () => {
    const rawToken = generateSessionToken();
    session.tokenHash = await hashSessionToken(rawToken);
    userRepository.setUser({ ...user, status: "suspended" });

    const response = await request(
      `${baseConfig.sessionCookieName}=${rawToken}`,
    );

    await expectFailure(response, AUTH_ERROR_CODES.ACCOUNT_SUSPENDED, 403);
    expect(sessionRepository.getSessionsForUser(user.id)).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toMatch(/^zelora_session=;/);
  });

  it("F: deleted user has all sessions deleted, cookie cleared, ACCOUNT_DELETED 403", async () => {
    const rawToken = generateSessionToken();
    session.tokenHash = await hashSessionToken(rawToken);
    userRepository.setUser({ ...user, status: "deleted" });

    const response = await request(
      `${baseConfig.sessionCookieName}=${rawToken}`,
    );

    await expectFailure(response, AUTH_ERROR_CODES.ACCOUNT_DELETED, 403);
    expect(sessionRepository.getSessionsForUser(user.id)).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toMatch(/^zelora_session=;/);
  });

  it("G: valid session loads the user, updates lastUsedAt and calls next()", async () => {
    const rawToken = generateSessionToken();
    session.tokenHash = await hashSessionToken(rawToken);
    const updateLastUsedAt = vi.spyOn(sessionRepository, "updateLastUsedAt");
    const findById = vi.spyOn(userRepository, "findById");

    const response = await request(
      `${baseConfig.sessionCookieName}=${rawToken}`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionId: string; userId: string };
    expect(body.sessionId).toBe(session.id);
    expect(body.userId).toBe(user.id);
    expect(findById).toHaveBeenCalledWith(user.id);
    expect(updateLastUsedAt).toHaveBeenCalledTimes(1);
    expect(updateLastUsedAt).toHaveBeenCalledWith(session.id, clock.now());
    expect(session.lastUsedAt).toEqual(clock.now());
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("G: auth context contains exactly the expected session and user", async () => {
    const rawToken = generateSessionToken();
    session.tokenHash = await hashSessionToken(rawToken);

    const testApp = new Hono<AppEnv>();
    let capturedSession: unknown;
    let capturedUser: unknown;
    testApp.use(
      "/protected",
      createAuthMiddleware({
        sessionRepository,
        userRepository,
        clock,
        config: baseConfig,
      }),
    );
    testApp.get("/protected", (c) => {
      const auth = c.get("auth");
      capturedSession = auth.session;
      capturedUser = auth.user;
      return c.json({ ok: true });
    });

    const response = await testApp.request("/protected", {
      headers: { Cookie: `${baseConfig.sessionCookieName}=${rawToken}` },
    });

    expect(response.status).toBe(200);
    expect(capturedSession).toBe(session);
    expect(capturedUser).toBe(user);
  });

  it("I: raw token is never passed to or stored in the repository", async () => {
    const rawToken = generateSessionToken();
    session.tokenHash = await hashSessionToken(rawToken);
    const findByTokenHash = vi.spyOn(sessionRepository, "findByTokenHash");

    const response = await request(
      `${baseConfig.sessionCookieName}=${rawToken}`,
    );

    expect(response.status).toBe(200);
    expect(findByTokenHash).toHaveBeenCalledTimes(1);
    const lookedUpWith = findByTokenHash.mock.calls[0]![0];
    expect(lookedUpWith).not.toBe(rawToken);
    expect(lookedUpWith).toBe(await hashSessionToken(rawToken));
    for (const stored of sessionRepository.getAll()) {
      expect(stored.tokenHash).not.toBe(rawToken);
      expect(Object.values(stored)).not.toContain(rawToken);
    }
  });

  it("rejects malformed cookies as SESSION_EXPIRED without leaking the raw value", async () => {
    const response = await request(
      `${baseConfig.sessionCookieName}=not!base64url`,
    );

    await expectFailure(response, AUTH_ERROR_CODES.SESSION_EXPIRED, 401);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toMatch(/^zelora_session=;/);
    expect(setCookie).not.toContain("not!base64url");
  });

  it("surfaces failures as AppError instances with the shared envelope", async () => {
    const response = await request();

    const body = await expectFailure(
      response,
      AUTH_ERROR_CODES.SESSION_EXPIRED,
      401,
    );
    expect(body.error.message).toBeDefined();
    expect(body.error.details).toBeUndefined();
    expect(body.error.fields).toBeUndefined();
  });
});
