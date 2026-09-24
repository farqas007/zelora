import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { UserRole, UserStatus } from "@zelora/shared";
import type { LocalDatabase } from "../client";
import { isValidId } from "../ids";
import * as schema from "../schema";
import { createLocalUserRepository } from "../users/local-repository";
import { createTestDatabase, expectConstraintError } from "./helpers";

/**
 * Real-SQLite integration tests for the user repository. Each test uses an
 * isolated in-memory database with the committed migrations applied (foreign
 * keys ON), matching the Cloudflare D1 runtime behavior.
 */

let userSeq = 0;

function createUser(
  db: LocalDatabase,
  overrides: { email?: string; role?: UserRole } = {},
) {
  userSeq += 1;
  const repo = createLocalUserRepository(db);
  return repo.create({
    email: overrides.email ?? `user-${userSeq}@example.test`,
    name: "Test User",
    passwordHash: "test-password-hash",
    ...(overrides.role === undefined ? {} : { role: overrides.role }),
  });
}

describe("user repository", () => {
  it("creates a user and returns the persisted row", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);
    const email = "create-user@example.test";
    const passwordHash = "test-password-hash";

    const user = await repo.create({ email, name: "Create User", passwordHash });

    expect(isValidId(user.id)).toBe(true);
    expect(user.email).toBe(email);
    expect(user.name).toBe("Create User");
    expect(user.passwordHash).toBe(passwordHash);

    const stored = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .get();
    expect(stored?.email).toBe(email);
    expect(stored?.name).toBe("Create User");
    expect(stored?.passwordHash).toBe(passwordHash);
  });

  it("defaults the role to customer and status to active", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);

    const user = await repo.create({
      email: "defaults@example.test",
      name: "Defaults",
      passwordHash: "test-password-hash",
    });

    expect(user.role).toBe("customer");
    expect(user.status).toBe("active");
  });

  it("honors an explicitly assigned server-side role", async () => {
    const { db } = createTestDatabase();

    const user = await createUser(db, { role: "seller" });

    expect(user.role).toBe("seller");
  });

  it("populates createdAt and updatedAt on create", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);

    const user = await repo.create({
      email: "timestamps@example.test",
      name: "Timestamps",
      passwordHash: "test-password-hash",
    });

    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it("finds a user by email", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);
    const user = await createUser(db);

    const found = await repo.findByEmail(user.email);

    expect(found?.id).toBe(user.id);
    expect(found?.email).toBe(user.email);
    expect(found?.name).toBe("Test User");
  });

  it("returns null for an unknown email", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);

    expect(await repo.findByEmail("missing@example.test")).toBeNull();
  });

  it("finds a user by id", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);
    const user = await createUser(db);

    const found = await repo.findById(user.id);

    expect(found?.id).toBe(user.id);
    expect(found?.email).toBe(user.email);
  });

  it("returns null for an unknown id", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);

    expect(await repo.findById("00000000-0000-7000-8000-000000000001")).toBeNull();
  });

  it("rejects a duplicate email with a UNIQUE constraint failure", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);
    const email = "duplicate@example.test";

    await repo.create({ email, name: "First", passwordHash: "test-password-hash" });

    await expect(
      repo.create({ email, name: "Second", passwordHash: "test-password-hash" }),
    ).rejects.toThrow(/UNIQUE constraint failed: users\.email/);
  });

  it("matches email exactly and does not normalize the value", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);
    const user = await createUser(db, { email: "Case.Test@Example.test" });

    expect((await repo.findByEmail("Case.Test@Example.test"))?.id).toBe(user.id);
    expect(await repo.findByEmail("case.test@example.test")).toBeNull();
    expect(await repo.findByEmail(" Case.Test@Example.test ")).toBeNull();
  });
});

describe("createAdmin (exactly one administrator)", () => {
  it("creates the first admin and persists the admin role", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);

    const result = await repo.createAdmin({
      email: "root@example.test",
      name: "Root",
      passwordHash: "test-password-hash",
      role: "admin",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = db.select().from(schema.users).where(eq(schema.users.email, "root@example.test")).get();
    expect(result.user.role).toBe("admin");
    expect(stored?.role).toBe("admin");
  });

  it("rejects a second admin with a DIFFERENT email (ADMIN_ALREADY_EXISTS)", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);

    const first = await repo.createAdmin({
      email: "root@example.test",
      name: "Root",
      passwordHash: "test-password-hash",
      role: "admin",
    });
    expect(first.ok).toBe(true);

    const second = await repo.createAdmin({
      email: "root-2@example.test",
      name: "Root Two",
      passwordHash: "test-password-hash",
      role: "admin",
    });

    expect(second).toEqual({ ok: false, reason: "ADMIN_ALREADY_EXISTS" });
    // The invariant held: no second admin row and no user row at all.
    expect(
      db.select().from(schema.users).where(eq(schema.users.email, "root-2@example.test")).get(),
    ).toBeUndefined();
    const admins = db.select().from(schema.users).where(eq(schema.users.role, "admin")).all();
    expect(admins).toHaveLength(1);
  });

  it("rejects a duplicate admin email (EMAIL_IN_USE) deterministically", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);

    // A customer registered moments before the bootstrap: only the email
    // UNIQUE constraint trips (no admin exists yet, so the single-admin
    // partial index is inactive) and the reason is unambiguous.
    await repo.create({ email: "root@example.test", name: "Customer First", passwordHash: "h" });

    const second = await repo.createAdmin({
      email: "root@example.test",
      name: "Root Duplicate",
      passwordHash: "test-password-hash",
      role: "admin",
    });

    expect(second).toEqual({ ok: false, reason: "EMAIL_IN_USE" });
    const stored = db.select().from(schema.users).where(eq(schema.users.email, "root@example.test")).get();
    expect(stored?.role).toBe("customer");
  });

  it("surfaces a same-email bootstrap race as a clean failure, never a second user", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);

    await repo.createAdmin({
      email: "root@example.test",
      name: "Root",
      passwordHash: "test-password-hash",
      role: "admin",
    });

    // Both UNIQUE constraints trip together in a same-email race; SQLite
    // reports the first it hits, which may be either. The recipient (the
    // admin service) re-resolves by email, so the exact reason is irrelevant —
    // what matters is that no duplicate user row is ever created.
    const racer = await repo.createAdmin({
      email: "root@example.test",
      name: "Root Duplicate",
      passwordHash: "test-password-hash",
      role: "admin",
    });

    expect(racer.ok).toBe(false);
    const matches = db.select().from(schema.users).where(eq(schema.users.email, "root@example.test")).all();
    expect(matches).toHaveLength(1);
  });

  it("allows an admin alongside many customers and sellers", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalUserRepository(db);

    await repo.createAdmin({
      email: "root@example.test",
      name: "Root",
      passwordHash: "test-password-hash",
      role: "admin",
    });
    await repo.create({ email: "c1@example.test", name: "C1", passwordHash: "h" });
    await repo.create({ email: "c2@example.test", name: "C2", passwordHash: "h" });
    await repo.create({ email: "s1@example.test", name: "S1", passwordHash: "h", role: "seller" });

    expect(db.select().from(schema.users).all()).toHaveLength(4);
    expect(
      db.select().from(schema.users).where(eq(schema.users.role, "admin")).all(),
    ).toHaveLength(1);
  });
});

describe("user schema constraints", () => {
  it("enforces that users without a password_hash may still be looked up", async () => {
    const { db, sqlite } = createTestDatabase();
    const repo = createLocalUserRepository(db);

    const result = db.insert(schema.users).values({
      email: "no-hash@example.test",
      name: "No Hash",
    }).returning().get();
    const found = await repo.findById(result.id);

    expect(found?.email).toBe("no-hash@example.test");
    expect(found?.passwordHash).toBeNull();

    const columns = sqlite
      .prepare("PRAGMA table_info('users')")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("password_hash");
  });

  it("rejects an invalid role through the database CHECK constraint", () => {
    const { db } = createTestDatabase();

    expectConstraintError(
      () =>
        db.insert(schema.users).values({
          email: "bad-role@example.test",
          name: "Bad Role",
          passwordHash: "test-password-hash",
          role: "root" as unknown as UserRole,
        }).run(),
      /CHECK constraint failed: users_role_check/,
    );
  });

  it("rejects an invalid status through the database CHECK constraint", () => {
    const { db } = createTestDatabase();

    expectConstraintError(
      () =>
        db.insert(schema.users).values({
          email: "bad-status@example.test",
          name: "Bad Status",
          passwordHash: "test-password-hash",
          status: "banned" as unknown as UserStatus,
        }).run(),
      /CHECK constraint failed: users_status_check/,
    );
  });

  it("enforces the exactly-one-admin invariant at the database level", () => {
    const { db } = createTestDatabase();
    db.insert(schema.users).values({
      email: "root@example.test",
      name: "Root",
      passwordHash: "test-password-hash",
      role: "admin",
    }).run();

    // The second admin row — any path, not just bootstrap — hits the partial
    // unique index on `role`, so a raw race at the driver layer still holds.
    expectConstraintError(
      () =>
        db.insert(schema.users).values({
          email: "root-2@example.test",
          name: "Root Two",
          passwordHash: "test-password-hash",
          role: "admin",
        }).run(),
      /UNIQUE constraint failed: users\.role/,
    );
  });
});