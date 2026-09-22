import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth";
import { AppError, PBKDF2PasswordHasher } from "@zelora/core";
import type {
  AppConfig,
  PasswordHasher,
} from "@zelora/core";
import { AUTH_ERROR_CODES, type UserRole, type UserStatus } from "@zelora/shared";
import type { Clock } from "./clock";
import type { RateLimitOutcome, RateLimiter } from "./rate-limit";
import type {
  UserRepository,
  UserRecord,
  CreateUserInput,
} from "@zelora/db/users";
import type {
  AuthSessionRepository,
  AuthSessionRecord,
  CreateAuthSessionInput,
} from "@zelora/db/auth";

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

  async create(input: CreateUserInput): Promise<UserRecord> {
    const id = `user-${this.nextId++}`;
    const now = new Date();
    const record: UserRecord = {
      id,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? "customer",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(id, record);
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

  clear(): void {
    this.users.clear();
    this.usersByEmail.clear();
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

  clear(): void {
    this.sessions.clear();
    this.lastCreateInput = null;
    this.nextId = 1;
  }
}

async function expectAuthError(
  run: () => Promise<unknown>,
  code: string,
  statusCode: number,
): Promise<void> {
  try {
    await run();
    expect.unreachable(`expected an AppError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    if (!(error instanceof AppError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    expect(error.statusCode).toBe(statusCode);
  }
}

const allowedOutcome: RateLimitOutcome = {
  allowed: true,
  remaining: 9,
  resetAt: new Date("2026-01-01T00:00:00.000Z"),
};

const blockedOutcome: RateLimitOutcome = {
  allowed: false,
  remaining: 0,
  resetAt: new Date("2026-01-01T00:00:15.000Z"),
};

function makeRateLimiter(): {
  limiter: RateLimiter;
  consume: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  sweep: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  const consume = vi.fn(async (): Promise<RateLimitOutcome> => allowedOutcome);
  const reset = vi.fn(async (): Promise<void> => undefined);
  const sweep = vi.fn(async (): Promise<void> => undefined);
  const clear = vi.fn((): void => undefined);
  const limiter: RateLimiter = { consume, reset, sweep, clear };
  return { limiter, consume, reset, sweep, clear };
}

describe("AuthService", () => {
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
  };

  let clock: FakeClock;
  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let passwordHasher: PasswordHasher;
  let authService: AuthService;

  beforeEach(() => {
    vi.restoreAllMocks();
    clock = new FakeClock();
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();
    passwordHasher = new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations);
    authService = new AuthService({
      config: baseConfig,
      userRepository,
      sessionRepository,
      passwordHasher,
      clock,
    });
  });

  describe("register", () => {
    it("successful registration", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada Lovelace",
      });

      expect(result.user).toBeDefined();
      expect(result.user.id).toBeDefined();
      expect(result.user.email).toBe("user@example.com");
      expect(result.user.name).toBe("Ada Lovelace");
      expect(result.user.role).toBe("customer");
      expect(result.user.status).toBe("active");
      expect(result.user.createdAt).toBeDefined();
      expect(result.session).toBeDefined();
      expect(result.session.id).toBeDefined();
      expect(result.session.createdAt).toBeDefined();
      expect(result.session.expiresAt).toBeDefined();
      expect(result.session.csrfToken).toBeDefined();
      expect(result.rawSessionToken).toBeDefined();
    });

    it("email normalization", async () => {
      const result = await authService.register({
        email: "  USER@Example.COM ",
        password: "password123",
        name: "Ada",
      });

      expect(result.user.email).toBe("user@example.com");
      const stored = await userRepository.findByEmail("user@example.com");
      expect(stored?.email).toBe("user@example.com");
    });

    it("name trimming", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "  Ada Lovelace  ",
      });

      expect(result.user.name).toBe("Ada Lovelace");
    });

    it("customer role is assigned server-side regardless of request role", async () => {
      const request = {
        email: "user@example.com",
        password: "password123",
        name: "Ada",
        role: "admin",
      } as Parameters<AuthService["register"]>[0];

      const result = await authService.register(request);

      expect(result.user.role).toBe("customer");
      const stored = await userRepository.findById(result.user.id);
      expect(stored?.role).toBe("customer");
    });

    it("existing email returns EMAIL_IN_USE", async () => {
      await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      await expectAuthError(
        () =>
          authService.register({
            email: "user@example.com",
            password: "different123",
            name: "Bob",
          }),
        AUTH_ERROR_CODES.EMAIL_IN_USE,
        409,
      );
    });

    it("password is hashed through PasswordHasher", async () => {
      const hashSpy = vi.spyOn(passwordHasher, "hash");

      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      expect(hashSpy).toHaveBeenCalledTimes(1);
      expect(hashSpy).toHaveBeenCalledWith("password123");
      const stored = await userRepository.findById(result.user.id);
      expect(stored?.passwordHash).toBeDefined();
      expect(stored?.passwordHash).not.toBe("password123");
    });

    it("session is created", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      const sessions = sessionRepository.getSessionsForUser(result.user.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.userId).toBe(result.user.id);
    });

    it("raw token is not passed to session repository", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      const lastInput = sessionRepository.getLastCreateInput();
      expect(lastInput).not.toBeNull();
      expect(Object.values(lastInput as object)).not.toContain(
        result.rawSessionToken,
      );
      expect(lastInput?.tokenHash).not.toBe(result.rawSessionToken);
    });

    it("expiry uses injected clock + TTL", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      const lastInput = sessionRepository.getLastCreateInput();
      const expectedExpiry = new Date(
        clock.now().getTime() + baseConfig.sessionTtlSeconds * 1000,
      );
      expect(lastInput?.expiresAt.getTime()).toBe(expectedExpiry.getTime());
      expect(new Date(result.session.expiresAt).getTime()).toBe(
        expectedExpiry.getTime(),
      );
    });

    it("invalid request throws a ValidationError before touching the repositories", async () => {
      await expectAuthError(
        () =>
          authService.register({
            email: "not-an-email",
            password: "short",
            name: "",
          } as Parameters<AuthService["register"]>[0]),
        "VALIDATION_ERROR",
        422,
      );
    });
  });

  describe("login", () => {
    beforeEach(async () => {
      await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });
    });

    it("successful login", async () => {
      const result = await authService.login({
        email: "user@example.com",
        password: "password123",
      });

      expect(result.user.email).toBe("user@example.com");
      expect(result.session.csrfToken).toBeDefined();
      expect(result.rawSessionToken).toBeDefined();
    });

    it("email normalization", async () => {
      const result = await authService.login({
        email: "  USER@Example.COM ",
        password: "password123",
      });

      expect(result.user.email).toBe("user@example.com");
    });

    it("wrong password returns generic INVALID_CREDENTIALS", async () => {
      await expectAuthError(
        () =>
          authService.login({
            email: "user@example.com",
            password: "wrongpassword",
          }),
        AUTH_ERROR_CODES.INVALID_CREDENTIALS,
        401,
      );
    });

    it("unknown email also returns generic INVALID_CREDENTIALS", async () => {
      await expectAuthError(
        () =>
          authService.login({
            email: "unknown@example.com",
            password: "password123",
          }),
        AUTH_ERROR_CODES.INVALID_CREDENTIALS,
        401,
      );
    });

    it("unknown email triggers dummy password verification", async () => {
      const verifySpy = vi.spyOn(passwordHasher, "verify");

      await expect(
        authService.login({
          email: "unknown@example.com",
          password: "password123",
        }),
      ).rejects.toBeInstanceOf(AppError);

      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(verifySpy).toHaveBeenCalledWith(
        "password123",
        expect.any(String),
      );
    });

    it("user with null passwordHash triggers dummy password verification", async () => {
      const user = await userRepository.findByEmail("user@example.com");
      const noHashUser: UserRecord = {
        ...user!,
        passwordHash: null,
      };
      userRepository.setUser(noHashUser);

      const verifySpy = vi.spyOn(passwordHasher, "verify");

      await expect(
        authService.login({
          email: "user@example.com",
          password: "password123",
        }),
      ).rejects.toBeInstanceOf(AppError);

      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(verifySpy).toHaveBeenCalledWith(
        "password123",
        expect.any(String),
      );
    });

    it("suspended user + correct password gets ACCOUNT_SUSPENDED after password verification", async () => {
      const user = await userRepository.findByEmail("user@example.com");
      userRepository.setUser({ ...user!, status: "suspended" });

      const verifySpy = vi.spyOn(passwordHasher, "verify");

      await expectAuthError(
        () =>
          authService.login({
            email: "user@example.com",
            password: "password123",
          }),
        AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
        403,
      );

      expect(verifySpy).toHaveBeenCalledTimes(1);
    });

    it("suspended user + wrong password returns generic INVALID_CREDENTIALS", async () => {
      const user = await userRepository.findByEmail("user@example.com");
      userRepository.setUser({ ...user!, status: "suspended" });

      const verifySpy = vi.spyOn(passwordHasher, "verify");

      await expectAuthError(
        () =>
          authService.login({
            email: "user@example.com",
            password: "wrongpassword",
          }),
        AUTH_ERROR_CODES.INVALID_CREDENTIALS,
        401,
      );

      expect(verifySpy).toHaveBeenCalledTimes(1);
    });

    it("deleted user + correct password gets ACCOUNT_DELETED after password verification", async () => {
      const user = await userRepository.findByEmail("user@example.com");
      userRepository.setUser({ ...user!, status: "deleted" });

      const verifySpy = vi.spyOn(passwordHasher, "verify");

      await expectAuthError(
        () =>
          authService.login({
            email: "user@example.com",
            password: "password123",
          }),
        AUTH_ERROR_CODES.ACCOUNT_DELETED,
        403,
      );

      expect(verifySpy).toHaveBeenCalledTimes(1);
    });

    it("deleted user + wrong password returns generic INVALID_CREDENTIALS", async () => {
      const user = await userRepository.findByEmail("user@example.com");
      userRepository.setUser({ ...user!, status: "deleted" });

      const verifySpy = vi.spyOn(passwordHasher, "verify");

      await expectAuthError(
        () =>
          authService.login({
            email: "user@example.com",
            password: "wrongpassword",
          }),
        AUTH_ERROR_CODES.INVALID_CREDENTIALS,
        401,
      );

      expect(verifySpy).toHaveBeenCalledTimes(1);
    });

    it("successful login creates a fresh session", async () => {
      const user = await userRepository.findByEmail("user@example.com");
      const before = sessionRepository.getSessionsForUser(user!.id).length;

      const result = await authService.login({
        email: "user@example.com",
        password: "password123",
      });

      const after = sessionRepository.getSessionsForUser(user!.id).length;
      expect(after).toBe(before + 1);
      expect(result.rawSessionToken).toBeDefined();
    });

    it("previous sessions are not deleted during normal login", async () => {
      const user = await userRepository.findByEmail("user@example.com");
      const sessionCountBefore =
        sessionRepository.getSessionsForUser(user!.id).length;
      expect(sessionCountBefore).toBe(1);

      await authService.login({
        email: "user@example.com",
        password: "password123",
      });

      const sessionCountAfter =
        sessionRepository.getSessionsForUser(user!.id).length;
      expect(sessionCountAfter).toBe(2);
    });
  });

  describe("login email rate limiting", () => {
    let current: ReturnType<typeof makeRateLimiter>;
    let limitedService: AuthService;

    beforeEach(async () => {
      current = makeRateLimiter();
      limitedService = new AuthService({
        config: baseConfig,
        userRepository,
        sessionRepository,
        passwordHasher,
        clock,
        rateLimiter: current.limiter,
      });
      await limitedService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });
    });

    function rejected(
      run: () => Promise<unknown>,
    ): Promise<AppError> {
      return run().then(
        () => {
          throw new Error("expected login to reject");
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(AppError);
          return error as AppError;
        },
      );
    }

    it("consumes the email bucket (after normalization) before any user lookup", async () => {
      const findByEmailSpy = vi.spyOn(userRepository, "findByEmail");

      await limitedService.login({
        email: "  USER@Example.COM ",
        password: "password123",
      });

      expect(current.consume).toHaveBeenCalledWith(
        "auth:login:email:user@example.com",
        baseConfig.rateLimitLoginEmailMax,
        baseConfig.rateLimitLoginEmailWindowSeconds,
      );
      const consumeOrder = current.consume.mock.invocationCallOrder[0]!;
      const lookupOrder = findByEmailSpy.mock.invocationCallOrder[0]!;
      expect(consumeOrder).toBeLessThan(lookupOrder);
    });

    it("skips the email limiter when rate limiting is disabled", async () => {
      const service = new AuthService({
        config: { ...baseConfig, rateLimitEnabled: false },
        userRepository,
        sessionRepository,
        passwordHasher,
        clock,
        rateLimiter: current.limiter,
      });

      const result = await service.login({
        email: "user@example.com",
        password: "password123",
      });

      expect(result.user.email).toBe("user@example.com");
      expect(current.consume).not.toHaveBeenCalled();
    });

    it("over-limit email runs dummy password verification", async () => {
      current.consume.mockResolvedValueOnce(blockedOutcome);
      const verifySpy = vi.spyOn(passwordHasher, "verify");

      await expect(
        limitedService.login({
          email: "user@example.com",
          password: "whatever",
        }),
      ).rejects.toBeInstanceOf(AppError);

      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(verifySpy).toHaveBeenCalledWith("whatever", expect.any(String));
    });

    it("over-limit email does not call findByEmail", async () => {
      current.consume.mockResolvedValueOnce(blockedOutcome);
      const findByEmailSpy = vi.spyOn(userRepository, "findByEmail");

      await expect(
        limitedService.login({
          email: "user@example.com",
          password: "password123",
        }),
      ).rejects.toBeInstanceOf(AppError);

      expect(findByEmailSpy).not.toHaveBeenCalled();
    });

    it("over-limit email returns the generic INVALID_CREDENTIALS 401", async () => {
      current.consume.mockResolvedValueOnce(blockedOutcome);

      const error = await rejected(() =>
        limitedService.login({
          email: "user@example.com",
          password: "password123",
        }),
      );

      expect(error.code).toBe(AUTH_ERROR_CODES.INVALID_CREDENTIALS);
      expect(error.statusCode).toBe(401);
      expect(error.message).toBe("Invalid email or password.");
      expect(error.details).toBeUndefined();
    });

    it("over-limit email does not expose whether the account exists", async () => {
      current.consume.mockResolvedValue(blockedOutcome);

      const known = await rejected(() =>
        limitedService.login({
          email: "user@example.com",
          password: "password123",
        }),
      );
      const unknown = await rejected(() =>
        limitedService.login({
          email: "nobody@example.com",
          password: "password123",
        }),
      );

      expect(known.code).toBe(unknown.code);
      expect(known.statusCode).toBe(unknown.statusCode);
      expect(known.message).toBe(unknown.message);
      expect(known.details).toBeUndefined();
      expect(unknown.details).toBeUndefined();
    });

    it("keys the bucket by the attempted (normalized) email regardless of existence", async () => {
      await expect(
        limitedService.login({
          email: "nobody@example.com",
          password: "password123",
        }),
      ).rejects.toBeInstanceOf(AppError);

      expect(current.consume).toHaveBeenCalledWith(
        "auth:login:email:nobody@example.com",
        baseConfig.rateLimitLoginEmailMax,
        baseConfig.rateLimitLoginEmailWindowSeconds,
      );
    });

    it("successful login resets the email bucket", async () => {
      const result = await limitedService.login({
        email: "user@example.com",
        password: "password123",
      });

      expect(result.user.email).toBe("user@example.com");
      expect(current.reset).toHaveBeenCalledWith("auth:login:email:user@example.com");
    });

    it("failed login does not reset the email bucket", async () => {
      await expect(
        limitedService.login({
          email: "user@example.com",
          password: "wrong-password",
        }),
      ).rejects.toBeInstanceOf(AppError);

      expect(current.reset).not.toHaveBeenCalled();
    });

    it("never leaks the password or rate-limit details to the caller", async () => {
      current.consume.mockResolvedValueOnce({
        allowed: true,
        remaining: 9,
        resetAt: new Date(),
      });
      current.consume.mockResolvedValueOnce(blockedOutcome);

      await expect(
        limitedService.login({
          email: "nobody@example.com",
          password: "hunter2hunter",
        }),
      ).rejects.toBeInstanceOf(AppError);

      const consumedArgs = current.consume.mock.calls;
      expect(JSON.stringify(consumedArgs)).not.toContain("hunter2hunter");

      current.consume.mockClear();
      current.consume.mockResolvedValue(blockedOutcome);
      const error = await rejected(() =>
        limitedService.login({
          email: "user@example.com",
          password: "supersecret42",
        }),
      );
      expect(error.message).not.toContain("supersecret42");
      expect(error.details).toBeUndefined();
      const blockedArgs = current.consume.mock.calls;
      expect(JSON.stringify(blockedArgs)).not.toContain("supersecret42");
    });

    it("registration never consumes the email limiter", async () => {
      await limitedService.register({
        email: "another@example.com",
        password: "password123",
        name: "Bob",
      });

      expect(current.consume).not.toHaveBeenCalled();
    });
  });

  describe("DTO/security", () => {
    it("passwordHash is never exposed", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      expect("passwordHash" in result.user).toBe(false);
      expect(Object.keys(result.user)).toEqual([
        "id",
        "email",
        "name",
        "role",
        "status",
        "createdAt",
      ]);
    });

    it("session DTO contains CSRF token and the required shape", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      expect(result.session.csrfToken).toBeDefined();
      expect(typeof result.session.csrfToken).toBe("string");
      expect(result.session.csrfToken.length).toBeGreaterThan(0);
      expect(Object.keys(result.session)).toEqual([
        "id",
        "createdAt",
        "expiresAt",
        "csrfToken",
      ]);
    });

    it("raw session token is available only in the internal service result", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      expect(result.rawSessionToken).toBeDefined();
      expect("rawSessionToken" in result).toBe(true);

      const registered = await authService.login({
        email: "user@example.com",
        password: "password123",
      });
      expect(registered.rawSessionToken).toBeDefined();
    });

    it("token hash is what reaches the repository", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      const lastInput = sessionRepository.getLastCreateInput();
      expect(lastInput?.tokenHash).toBeDefined();
      expect(lastInput?.tokenHash).not.toBe(result.rawSessionToken);
      expect(lastInput?.tokenHash).not.toMatch(/=+$/);
    });

    it("token hash is deterministic from the raw token and not reversible", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      const lastInput = sessionRepository.getLastCreateInput();
      expect(lastInput?.tokenHash).toBeDefined();
      expect(result.rawSessionToken).not.toBe(lastInput?.tokenHash);
    });

    it("DTO user role and status are typed from the shared contracts", async () => {
      const result = await authService.register({
        email: "user@example.com",
        password: "password123",
        name: "Ada",
      });

      const role: UserRole = result.user.role;
      const status: UserStatus = result.user.status;
      expect(role).toBe("customer");
      expect(status).toBe("active");
    });
  });
});