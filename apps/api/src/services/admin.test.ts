import { describe, expect, it } from "vitest";
import { AppError, NotFoundError, ValidationError, type AppConfig, type PasswordHasher } from "@zelora/core";
import { AUTH_ERROR_CODES } from "@zelora/shared";
import { ADMIN_BOOTSTRAP_SECRET_MIN_LENGTH, ADMIN_ERROR_CODES } from "@zelora/shared";
import type { CreateAuditLogInput, AuditLogRecord, AuditLogRepository } from "@zelora/db/audit";
import type {
  CreateAdminResult,
  CreateUserInput,
  UserRecord,
  UserRepository,
} from "@zelora/db/users";
import type {
  PendingSellerListQuery,
  PendingSellerListPage,
  PendingSellerRecord,
  SellerProfileRecord,
  SellerRepository,
  StoreRecord,
} from "@zelora/db/seller";
import { AdminService } from "./admin";
import type { SellerActivationData, SellerService } from "./seller";

/**
 * Service-level tests for admin operations: bootstrap, review-queue listing,
 * and seller activation/rejection with audit logging. Repositories and the
 * seller service are faked so every security decision (secret gating,
 * idempotency, blocking rules, audit rows) can be asserted without a database.
 */

const BOOTSTRAP_SECRET = "a".repeat(ADMIN_BOOTSTRAP_SECRET_MIN_LENGTH + 8);

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
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
    adminBootstrapSecret: BOOTSTRAP_SECRET,
    ...overrides,
  };
}

class FakePasswordHasher implements PasswordHasher {
  hashes: string[] = [];

  async hash(password: string): Promise<string> {
    this.hashes.push(password);
    return `hashed:${password}`;
  }

  async verify(password: string, hash: string): Promise<boolean> {
    return hash === `hashed:${password}`;
  }
}

class FakeUserRepository implements UserRepository {
  private users: Map<string, UserRecord> = new Map();
  private usersByEmail: Map<string, UserRecord> = new Map();
  private nextId = 1;

  /**
   * Test-only race barrier: when set, every {@link createAdmin} parks on it
   * before its invariant check, so a concurrent-bootstrap test can hold both
   * requests in flight at the exact moment the "exactly one administrator"
   * check happens (mirroring the DB partial-index backstop).
   */
  createAdminGate: Promise<void> | null = null;

  async create(input: CreateUserInput): Promise<UserRecord> {
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
    if (this.createAdminGate !== null) {
      await this.createAdminGate;
    }
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

  adminEmails(): string[] {
    return Array.from(this.users.values())
      .filter((user) => user.role === "admin")
      .map((user) => user.email)
      .sort();
  }
}

class FakeSellerRepository implements SellerRepository {
  profiles: Map<string, SellerProfileRecord> = new Map();
  private stores: Map<string, StoreRecord> = new Map();
  private queue: PendingSellerRecord[] = [];

  rejectTargetMissing = false;
  rejectBlocked = false;

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

  async createOnboarding(): Promise<never> {
    throw new Error("not exercised by admin service tests");
  }

  async activateSeller(): Promise<never> {
    throw new Error("delegated to the seller service, never the repository");
  }

  async listPendingProfiles({ limit, cursor }: PendingSellerListQuery): Promise<PendingSellerListPage> {
    const queue = [...this.queue].sort(
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
      nextCursor: startIndex + limit < queue.length && last !== undefined ? `${last.sellerProfile.id}` : null,
    };
  }

  async rejectSeller(userId: string): Promise<SellerProfileRecord | null> {
    if (this.rejectTargetMissing) {
      return null;
    }
    const profile = Array.from(this.profiles.values()).find(
      (candidate) => candidate.userId === userId && candidate.status === "pending",
    );
    if (profile === undefined) {
      return null;
    }
    if (this.rejectBlocked) {
      return null;
    }
    const rejected: SellerProfileRecord = { ...profile, status: "rejected" };
    this.profiles.set(profile.id, rejected);
    return rejected;
  }

  seedPending(record: PendingSellerRecord): void {
    this.queue.push(record);
    this.profiles.set(record.sellerProfile.id, record.sellerProfile);
    this.stores.set(record.store.id, record.store);
  }
}

class FakeSellerService {
  activation: SellerActivationData | null = null;
  activationError: Error | null = null;
  userIdsActivated: string[] = [];

  async activateSeller(userId: string): Promise<SellerActivationData> {
    this.userIdsActivated.push(userId);
    if (this.activationError !== null) {
      throw this.activationError;
    }
    if (this.activation === null) {
      throw new NotFoundError("No seller profile exists for this user.");
    }
    return this.activation;
  }
}

class FakeAuditLogRepository implements AuditLogRepository {
  entries: Array<{ input: CreateAuditLogInput; createdAt: Date }> = [];

  async create(input: CreateAuditLogInput): Promise<AuditLogRecord> {
    this.entries.push({ input, createdAt: new Date() });
    return {
      id: `audit-${this.entries.length}`,
      actorUserId: input.actorUserId,
      action: input.action,
      targetUserId: input.targetUserId ?? null,
      details: input.details ?? null,
      createdAt: new Date(),
    };
  }

  async listByAction(action: string): Promise<AuditLogRecord[]> {
    return this.entries
      .filter((entry) => entry.input.action === action)
      .map((entry) => ({
        id: "audit-row",
        actorUserId: entry.input.actorUserId,
        action,
        targetUserId: entry.input.targetUserId ?? null,
        details: entry.input.details ?? null,
        createdAt: entry.createdAt,
      }));
  }
}

function makeAdmin(overrides: {
  config?: AppConfig;
  passwordHasher?: PasswordHasher;
  actor?: UserRecord;
} = {}): {
  service: AdminService;
  userRepository: FakeUserRepository;
  sellerRepository: FakeSellerRepository;
  sellerService: FakeSellerService;
  auditLogRepository: FakeAuditLogRepository;
  passwordHasher: PasswordHasher;
  actor: UserRecord;
} {
  const config = overrides.config ?? makeConfig();
  const passwordHasher = overrides.passwordHasher ?? new FakePasswordHasher();
  const userRepository = new FakeUserRepository();
  const sellerRepository = new FakeSellerRepository();
  const sellerService = new FakeSellerService();
  const auditLogRepository = new FakeAuditLogRepository();

  const actor: UserRecord =
    overrides.actor ??
    ({
      id: "admin-actor",
      email: "boss@example.com",
      role: "admin",
      status: "active",
      name: "The Administrator",
      passwordHash: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies UserRecord);

  const service = new AdminService({
    config,
    userRepository,
    sellerRepository,
    sellerService: sellerService as unknown as SellerService,
    auditLogRepository,
    passwordHasher,
  });
  return { service, userRepository, sellerRepository, sellerService, auditLogRepository, passwordHasher, actor };
}

const validBootstrapBody = {
  email: "admin@example.com",
  password: "SuperSecret-123",
  name: "Platform Admin",
};

function pendingRecord(id: string, userId: string, email: string, slug: string): PendingSellerRecord {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    sellerProfile: {
      id,
      userId,
      slug,
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

describe("AdminService bootstrapAdmin", () => {
  it("is a missing resource (404) when the bootstrap secret is not configured", async () => {
    const { service } = makeAdmin({
      config: makeConfig({ adminBootstrapSecret: null }),
    });

    await expect(service.bootstrapAdmin(BOOTSTRAP_SECRET, validBootstrapBody)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects a request with no secret (403 ADMIN_BOOTSTRAP_UNAUTHORIZED)", async () => {
    const { service, userRepository } = makeAdmin();

    await expect(service.bootstrapAdmin(undefined, validBootstrapBody)).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.ADMIN_BOOTSTRAP_UNAUTHORIZED,
      statusCode: 403,
    });
    await expect(userRepository.findById("user-1")).resolves.toBeNull();
  });

  it("rejects a wrong secret (403 ADMIN_BOOTSTRAP_UNAUTHORIZED)", async () => {
    const { service } = makeAdmin();

    await expect(service.bootstrapAdmin("wrong-secret-value-123", validBootstrapBody)).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.ADMIN_BOOTSTRAP_UNAUTHORIZED,
      statusCode: 403,
    });
  });

  it("creates the first admin and appends an audit row", async () => {
    const { service, userRepository, auditLogRepository, passwordHasher } = makeAdmin();

    const result = await service.bootstrapAdmin(BOOTSTRAP_SECRET, validBootstrapBody);

    expect(result.created).toBe(true);
    expect(result.user).toMatchObject({
      email: "admin@example.com",
      role: "admin",
      status: "active",
    });
    expect(result.user.id).toBeDefined();

    const created = await userRepository.findById(result.user.id);
    expect(created?.role).toBe("admin");
    expect(created?.passwordHash).not.toBe(validBootstrapBody.password);
    expect(await passwordHasher.verify(validBootstrapBody.password, created?.passwordHash ?? "")).toBe(true);

    expect(auditLogRepository.entries).toHaveLength(1);
    expect(auditLogRepository.entries[0]!.input).toMatchObject({
      actorUserId: null,
      action: "admin.bootstrap",
      targetUserId: result.user.id,
    });
  });

  it("normalizes the email before creating the account", async () => {
    const { service } = makeAdmin();

    const result = await service.bootstrapAdmin(BOOTSTRAP_SECRET, {
      ...validBootstrapBody,
      email: "  Admin@Example.COM ",
    });

    expect(result.user.email).toBe("admin@example.com");
  });

  it("is idempotent for an existing admin and records no audit row", async () => {
    const { service, userRepository, auditLogRepository } = makeAdmin();
    const first = await service.bootstrapAdmin(BOOTSTRAP_SECRET, validBootstrapBody);

    const second = await service.bootstrapAdmin(BOOTSTRAP_SECRET, validBootstrapBody);

    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(auditLogRepository.entries).toHaveLength(1);

    const admin = await userRepository.findById(first.user.id);
    expect(admin?.role).toBe("admin");
  });

  it("never promotes an existing customer (409 ADMIN_BOOTSTRAP_CONFLICT)", async () => {
    const { service, userRepository } = makeAdmin();
    await userRepository.create({
      email: "admin@example.com",
      name: "Existing Customer",
      passwordHash: "hashed",
      role: "customer",
    });

    await expect(service.bootstrapAdmin(BOOTSTRAP_SECRET, validBootstrapBody)).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.ADMIN_BOOTSTRAP_CONFLICT,
      statusCode: 409,
    });

    const existing = await userRepository.findByEmail("admin@example.com");
    expect(existing?.role).toBe("customer");
  });

  it("blocks a second bootstrap with a different new email once an admin exists", async () => {
    const { service, userRepository, auditLogRepository } = makeAdmin();
    const first = await service.bootstrapAdmin(BOOTSTRAP_SECRET, validBootstrapBody);

    await expect(
      service.bootstrapAdmin(BOOTSTRAP_SECRET, {
        ...validBootstrapBody,
        email: "another-admin@example.com",
      }),
    ).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.ADMIN_BOOTSTRAP_CONFLICT,
      statusCode: 409,
    });

    // The "exactly one administrator" invariant held: the original admin is
    // untouched, no second admin row exists, and no audit row was written for
    // a creation that never happened.
    expect(userRepository.adminEmails()).toEqual([first.user.email]);
    expect(await userRepository.findByEmail("another-admin@example.com")).toBeNull();
    expect(auditLogRepository.entries).toHaveLength(1);
    expect(auditLogRepository.entries[0]!.input).toMatchObject({
      action: "admin.bootstrap",
      targetUserId: first.user.id,
    });
  });

  it("lets concurrent bootstraps with different emails create exactly one admin", async () => {
    const { service, userRepository, auditLogRepository } = makeAdmin();
    let release!: () => void;
    userRepository.createAdminGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const attempts = [
      validBootstrapBody,
      { ...validBootstrapBody, email: "runner-up@example.com" },
    ].map((body) =>
      service.bootstrapAdmin(BOOTSTRAP_SECRET, body).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );

    // Both requests have passed the findByEmail pre-check and are parked on
    // the repository gate at the invariant check. Releasing the gate lets
    // whichever insert lands first claim the single admin slot.
    release();
    const outcome = await Promise.all(attempts);

    const successes = outcome.filter((entry) => entry.ok && entry.result.created);
    const failures = outcome.filter((entry) => !entry.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      ok: false,
      error: { code: ADMIN_ERROR_CODES.ADMIN_BOOTSTRAP_CONFLICT, statusCode: 409 },
    });

    expect(userRepository.adminEmails()).toHaveLength(1);
    expect(auditLogRepository.entries).toHaveLength(1);
    expect(auditLogRepository.entries[0]!.input.action).toBe("admin.bootstrap");
  });

  it("validates the request body before doing any work", async () => {
    const { service, auditLogRepository, userRepository } = makeAdmin();

    await expect(
      service.bootstrapAdmin(BOOTSTRAP_SECRET, { email: "not-an-email", password: "short", name: "" }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(auditLogRepository.entries).toHaveLength(0);
    expect(await userRepository.findByEmail("not-an-email")).toBeNull();
  });

  it("matches the secret in constant time regardless of lengths", async () => {
    const { service } = makeAdmin();

    await expect(
      service.bootstrapAdmin(BOOTSTRAP_SECRET + "x", validBootstrapBody),
    ).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.ADMIN_BOOTSTRAP_UNAUTHORIZED });
  });
});

describe("AdminService listPendingSellers", () => {
  it("falls back to the default limit and projects the review queue", async () => {
    const { service, sellerRepository } = makeAdmin();
    sellerRepository.seedPending(pendingRecord("p-1", "u-1", "a@example.com", "pending-a"));

    const result = await service.listPendingSellers({});

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.sellerProfile).toMatchObject({ id: "p-1", userId: "u-1", status: "pending" });
    expect(result.items[0]!.user.email).toBe("a@example.com");
    expect(result.items[0]!.store).toMatchObject({ status: "draft" });
    expect(result.nextCursor).toBeNull();
  });

  it("passes an explicit valid limit and cursor through", async () => {
    const { service, sellerRepository } = makeAdmin();
    sellerRepository.seedPending(pendingRecord("p-1", "u-1", "a@example.com", "pending-a"));
    sellerRepository.seedPending(pendingRecord("p-2", "u-2", "b@example.com", "pending-b"));

    const first = await service.listPendingSellers({ limit: "1" });

    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe("p-1");

    const second = await service.listPendingSellers({ limit: "1", cursor: first.nextCursor ?? undefined });
    expect(second.items.map((item) => item.sellerProfile.id)).toEqual(["p-2"]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects a non-integer limit (422 VALIDATION_ERROR)", async () => {
    const { service } = makeAdmin();

    await expect(service.listPendingSellers({ limit: "abc" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an out-of-bounds limit (422 VALIDATION_ERROR)", async () => {
    const { service } = makeAdmin();

    await expect(service.listPendingSellers({ limit: "0" })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.listPendingSellers({ limit: "51" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("AdminService activateSeller", () => {
  it("delegates the transition and records an audit row", async () => {
    const { service, sellerService, auditLogRepository, actor } = makeAdmin();
    sellerService.activation = {
      transitioned: true,
      sellerProfile: { id: "p-1", userId: "u-1", slug: "shop", displayName: "Shop", status: "active" },
      store: { id: "s-1", name: "Store", slug: "store", description: null, status: "active" },
    };

    const result = await service.activateSeller(actor, "u-1");

    expect(sellerService.userIdsActivated).toEqual(["u-1"]);
    expect(result.sellerProfile.status).toBe("active");
    expect(auditLogRepository.entries[0]!.input).toMatchObject({
      actorUserId: "admin-actor",
      action: "seller.activate",
      targetUserId: "u-1",
    });
  });

  it("propagates the seller service's blocking error", async () => {
    const { service, sellerService, auditLogRepository, actor } = makeAdmin();
    sellerService.activationError = new AppError(
      AUTH_ERROR_CODES.SELLER_ACTIVATION_BLOCKED,
      "This seller profile cannot be activated.",
      409,
    );

    await expect(service.activateSeller(actor, "u-1")).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.SELLER_ACTIVATION_BLOCKED,
      statusCode: 409,
    });
    expect(auditLogRepository.entries).toHaveLength(0);
  });

  it("records a sale activation audit on the real transition but not on an idempotent re-activation", async () => {
    const { service, sellerService, auditLogRepository, actor } = makeAdmin();
    sellerService.activation = {
      transitioned: true,
      sellerProfile: { id: "p-1", userId: "u-1", slug: "shop", displayName: "Shop", status: "active" },
      store: { id: "s-1", name: "Store", slug: "store", description: null, status: "active" },
    };

    await service.activateSeller(actor, "u-1");

    // Re-activating an already-active seller is an idempotent no-op: the
    // service reports `transitioned: false`, so no duplicate audit row is
    // minted for a request that performed no state transition.
    sellerService.activation = {
      transitioned: false,
      sellerProfile: { id: "p-1", userId: "u-1", slug: "shop", displayName: "Shop", status: "active" },
      store: { id: "s-1", name: "Store", slug: "store", description: null, status: "active" },
    };

    const again = await service.activateSeller(actor, "u-1");

    expect(again.sellerProfile.status).toBe("active");
    expect(auditLogRepository.entries).toHaveLength(1);
  });
});

describe("AdminService rejectSeller", () => {
  it("rejects a pending profile and records an audit row", async () => {
    const { service, sellerRepository, auditLogRepository, actor } = makeAdmin();
    sellerRepository.seedPending(pendingRecord("p-1", "u-1", "a@example.com", "pending-a"));

    const result = await service.rejectSeller(actor, "u-1");

    expect(result).toMatchObject({ id: "p-1", userId: "u-1", status: "rejected" });
    expect(auditLogRepository.entries[0]!.input).toMatchObject({
      actorUserId: "admin-actor",
      action: "seller.reject",
      targetUserId: "u-1",
      details: JSON.stringify({ sellerProfileId: "p-1" }),
    });
  });

  it("is idempotent for an already-rejected profile with no second audit row", async () => {
    const { service, sellerRepository, auditLogRepository, actor } = makeAdmin();
    sellerRepository.seedPending(pendingRecord("p-1", "u-1", "a@example.com", "pending-a"));

    await service.rejectSeller(actor, "u-1");
    const second = await service.rejectSeller(actor, "u-1");

    expect(second.status).toBe("rejected");
    expect(auditLogRepository.entries).toHaveLength(1);
  });

  it("is blocked for an active profile (409 SELLER_REJECTION_BLOCKED)", async () => {
    const { service, sellerRepository, auditLogRepository, actor } = makeAdmin();
    const record = pendingRecord("p-1", "u-1", "a@example.com", "pending-a");
    const active: SellerProfileRecord = { ...record.sellerProfile, status: "active" };
    sellerRepository.seedPending({ ...record, sellerProfile: active });

    await expect(service.rejectSeller(actor, "u-1")).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.SELLER_REJECTION_BLOCKED,
      statusCode: 409,
    });
    expect(auditLogRepository.entries).toHaveLength(0);
  });

  it("is blocked for a suspended profile (409 SELLER_REJECTION_BLOCKED)", async () => {
    const { service, sellerRepository, actor } = makeAdmin();
    const record = pendingRecord("p-1", "u-1", "a@example.com", "pending-a");
    const suspended: SellerProfileRecord = { ...record.sellerProfile, status: "suspended" };
    sellerRepository.seedPending({ ...record, sellerProfile: suspended });

    await expect(service.rejectSeller(actor, "u-1")).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.SELLER_REJECTION_BLOCKED,
      statusCode: 409,
    });
  });

  it("is a 404 when the user has no seller profile", async () => {
    const { service, actor } = makeAdmin();

    await expect(service.rejectSeller(actor, "u-missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("re-resolves a raced activation without overwriting it", async () => {
    const { service, sellerRepository, auditLogRepository, actor } = makeAdmin();
    const record = pendingRecord("p-1", "u-1", "a@example.com", "pending-a");
    sellerRepository.seedPending(record);
    // The repository refuses the conditional update (the row changed between
    // the read and the write): the re-read now sees a freshly activated profile.
    sellerRepository.rejectTargetMissing = true;
    sellerRepository.profiles.set("p-1", { ...record.sellerProfile, status: "active" });

    await expect(service.rejectSeller(actor, "u-1")).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.SELLER_REJECTION_BLOCKED,
      statusCode: 409,
    });
    expect(auditLogRepository.entries).toHaveLength(0);
  });
});