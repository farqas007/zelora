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
});