import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateCsrfToken, generateSessionToken, hashSessionToken } from "@zelora/core";
import { createLocalAuthSessionRepository } from "../auth/local-repository";
import type { LocalDatabase } from "../client";
import { isValidId } from "../ids";
import * as schema from "../schema";
import { createTestDatabase, expectConstraintError } from "./helpers";

/**
 * Real-SQLite integration tests for the auth session repository. Each test
 * uses an isolated in-memory database with the committed migrations applied
 * (foreign keys ON), matching the Cloudflare D1 runtime behavior.
 */

let userSeq = 0;

function insertUser(db: LocalDatabase): string {
  userSeq += 1;
  return db
    .insert(schema.users)
    .values({ email: `session-user-${userSeq}@example.test`, name: "Session User" })
    .returning({ id: schema.users.id })
    .get().id;
}

function future(): Date {
  return new Date(Date.now() + 60_000);
}

function past(): Date {
  return new Date(Date.now() - 60_000);
}

describe("auth session repository", () => {
  it("creates a session and returns the persisted row", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalAuthSessionRepository(db);

    const tokenHash = await hashSessionToken(generateSessionToken());
    const csrfToken = generateCsrfToken();
    const expiresAt = future();

    const session = await repo.create({ userId, tokenHash, csrfToken, expiresAt });

    expect(isValidId(session.id)).toBe(true);
    expect(session.userId).toBe(userId);
    expect(session.tokenHash).toBe(tokenHash);
    expect(session.csrfToken).toBe(csrfToken);
    expect(session.expiresAt).toEqual(expiresAt);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.lastUsedAt).toBeNull();

    const stored = db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.id, session.id))
      .get();
    expect(stored?.tokenHash).toBe(tokenHash);
  });

  it("finds a session by its token hash", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalAuthSessionRepository(db);

    const tokenHash = await hashSessionToken(generateSessionToken());
    const session = await repo.create({ userId, tokenHash, csrfToken: generateCsrfToken(), expiresAt: future() });

    const found = await repo.findByTokenHash(tokenHash);
    expect(found?.id).toBe(session.id);
    expect(found?.userId).toBe(userId);
  });

  it("returns null for an unknown token hash", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuthSessionRepository(db);

    expect(await repo.findByTokenHash(await hashSessionToken(generateSessionToken()))).toBeNull();
    await expect(repo.findByTokenHash("not-a-session")).resolves.toBeNull();
  });

  it("enforces token_hash uniqueness", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalAuthSessionRepository(db);

    const tokenHash = await hashSessionToken(generateSessionToken());
    await repo.create({ userId, tokenHash, csrfToken: generateCsrfToken(), expiresAt: future() });

    await expect(
      repo.create({ userId, tokenHash, csrfToken: generateCsrfToken(), expiresAt: future() }),
    ).rejects.toThrow(/UNIQUE constraint failed: auth_sessions\.token_hash/);
  });

  it("allows multiple sessions to belong to one user", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalAuthSessionRepository(db);

    const first = await repo.create({
      userId,
      tokenHash: await hashSessionToken(generateSessionToken()),
      csrfToken: generateCsrfToken(),
      expiresAt: future(),
    });
    const second = await repo.create({
      userId,
      tokenHash: await hashSessionToken(generateSessionToken()),
      csrfToken: generateCsrfToken(),
      expiresAt: future(),
    });

    expect(first.id).not.toBe(second.id);
    const rows = db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.userId, userId))
      .all();
    expect(rows).toHaveLength(2);
  });

  it("deleting one session does not delete another", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalAuthSessionRepository(db);

    const firstHash = await hashSessionToken(generateSessionToken());
    const secondHash = await hashSessionToken(generateSessionToken());
    const first = await repo.create({ userId, tokenHash: firstHash, csrfToken: generateCsrfToken(), expiresAt: future() });
    const second = await repo.create({ userId, tokenHash: secondHash, csrfToken: generateCsrfToken(), expiresAt: future() });

    expect(await repo.deleteById(first.id)).toBe(true);
    expect(await repo.findByTokenHash(firstHash)).toBeNull();
    expect((await repo.findByTokenHash(secondHash))?.id).toBe(second.id);

    expect(await repo.deleteById(second.id)).toBe(true);
    expect(await repo.deleteById(second.id)).toBe(false);
  });

  it("deleting all sessions for a user removes only that user's sessions", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuthSessionRepository(db);
    const userA = insertUser(db);
    const userB = insertUser(db);

    const aHash1 = await hashSessionToken(generateSessionToken());
    const aHash2 = await hashSessionToken(generateSessionToken());
    const bHash = await hashSessionToken(generateSessionToken());
    await repo.create({ userId: userA, tokenHash: aHash1, csrfToken: generateCsrfToken(), expiresAt: future() });
    await repo.create({ userId: userA, tokenHash: aHash2, csrfToken: generateCsrfToken(), expiresAt: future() });
    const bSession = await repo.create({ userId: userB, tokenHash: bHash, csrfToken: generateCsrfToken(), expiresAt: future() });

    expect(await repo.deleteAllForUser(userA)).toBe(2);
    expect(await repo.findByTokenHash(aHash1)).toBeNull();
    expect(await repo.findByTokenHash(aHash2)).toBeNull();
    expect((await repo.findByTokenHash(bHash))?.id).toBe(bSession.id);

    expect(await repo.deleteAllForUser(userB)).toBe(1);
    expect(await repo.deleteAllForUser(userB)).toBe(0);
  });

  it("updates last_used_at", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalAuthSessionRepository(db);

    const tokenHash = await hashSessionToken(generateSessionToken());
    const session = await repo.create({ userId, tokenHash, csrfToken: generateCsrfToken(), expiresAt: future() });
    expect(session.lastUsedAt).toBeNull();

    const lastUsedAt = new Date(Date.now() + 500);
    expect(await repo.updateLastUsedAt(session.id, lastUsedAt)).toBe(true);
    expect((await repo.findByTokenHash(tokenHash))?.lastUsedAt).toEqual(lastUsedAt);

    expect(await repo.updateLastUsedAt("00000000-0000-7000-8000-000000000001", lastUsedAt)).toBe(false);
  });

  it("purges expired sessions", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalAuthSessionRepository(db);

    const expiredHash = await hashSessionToken(generateSessionToken());
    const alsoExpiredHash = await hashSessionToken(generateSessionToken());
    await repo.create({ userId, tokenHash: expiredHash, csrfToken: generateCsrfToken(), expiresAt: past() });
    await repo.create({ userId, tokenHash: alsoExpiredHash, csrfToken: generateCsrfToken(), expiresAt: past() });

    const now = new Date();
    expect(await repo.purgeExpired(now)).toBe(2);
    expect(await repo.findByTokenHash(expiredHash)).toBeNull();
    expect(await repo.findByTokenHash(alsoExpiredHash)).toBeNull();
  });

  it("non-expired sessions survive a purge", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuthSessionRepository(db);
    const expiredUser = insertUser(db);
    const activeUser = insertUser(db);

    const expiredHash = await hashSessionToken(generateSessionToken());
    const activeHash = await hashSessionToken(generateSessionToken());
    await repo.create({ userId: expiredUser, tokenHash: expiredHash, csrfToken: generateCsrfToken(), expiresAt: past() });
    const active = await repo.create({ userId: activeUser, tokenHash: activeHash, csrfToken: generateCsrfToken(), expiresAt: future() });

    const now = new Date();
    expect(await repo.purgeExpired(now)).toBe(1);
    expect((await repo.findByTokenHash(activeHash))?.id).toBe(active.id);
    expect(await repo.findByTokenHash(expiredHash)).toBeNull();

    expect(await repo.purgeExpired(now)).toBe(0);
  });

  it("cascades session deletion when a user is deleted", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuthSessionRepository(db);
    const userId = insertUser(db);

    await repo.create({ userId, tokenHash: await hashSessionToken(generateSessionToken()), csrfToken: generateCsrfToken(), expiresAt: future() });
    await repo.create({ userId, tokenHash: await hashSessionToken(generateSessionToken()), csrfToken: generateCsrfToken(), expiresAt: future() });

    db.delete(schema.users).where(eq(schema.users.id, userId)).run();

    const remaining = db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.userId, userId))
      .all();
    expect(remaining).toHaveLength(0);
  });

  it("never stores the raw session token", async () => {
    const { db, sqlite } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalAuthSessionRepository(db);

    const rawToken = generateSessionToken();
    const tokenHash = await hashSessionToken(rawToken);
    const csrfToken = generateCsrfToken();
    const session = await repo.create({ userId, tokenHash, csrfToken, expiresAt: future() });

    expect(session.tokenHash).toBe(tokenHash);
    expect(session.tokenHash).not.toBe(rawToken);

    const raw = sqlite
      .prepare("SELECT * FROM auth_sessions WHERE id = ?")
      .get(session.id) as Record<string, unknown>;
    expect(raw).toBeDefined();
    expect(raw.token_hash).toBe(tokenHash);
    expect(JSON.stringify(Object.values(raw))).not.toContain(rawToken);
    expect(raw).not.toHaveProperty("token");
  });

  it("persists only the hashed-token columns, with no raw token or cookie column", () => {
    const { sqlite } = createTestDatabase();
    const columns = sqlite
      .prepare("PRAGMA table_info('auth_sessions')")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "token_hash",
      "csrf_token",
      "expires_at",
      "created_at",
      "last_used_at",
    ]);
  });
});

describe("auth session schema constraints", () => {
  it("declares ON DELETE CASCADE to users", () => {
    const { sqlite } = createTestDatabase();
    const foreignKeys = sqlite
      .prepare("PRAGMA foreign_key_list('auth_sessions')")
      .all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
    expect(foreignKeys).toContainEqual(
      expect.objectContaining({ table: "users", from: "user_id", to: "id", on_delete: "CASCADE" }),
    );
  });

  it("represents the token uniqueness and user/expiry indexes in the migration", () => {
    const { sqlite } = createTestDatabase();
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'auth_sessions'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((index) => index.name);
    expect(names).toContain("auth_sessions_token_hash_unique");
    expect(names).toContain("auth_sessions_user_id_idx");
    expect(names).toContain("auth_sessions_expires_at_idx");
  });

  it("enforces the 43-character token_hash length", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalAuthSessionRepository(db);

    await expect(
      repo.create({ userId, tokenHash: "short", csrfToken: generateCsrfToken(), expiresAt: future() }),
    ).rejects.toThrow(/CHECK constraint failed: auth_sessions_token_hash_length/);
  });

  it("enforces the 43-character csrf_token length", () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const tokenHashLength = 43;

    expectConstraintError(
      () =>
        db.insert(schema.authSessions).values({
          userId,
          tokenHash: "a".repeat(tokenHashLength),
          csrfToken: "short",
          expiresAt: future(),
        }).run(),
      /CHECK constraint failed: auth_sessions_csrf_token_length/,
    );
  });

  it("rejects a session for a non-existent user", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuthSessionRepository(db);

    await expect(
      repo.create({
        userId: "00000000-0000-7000-8000-000000000001",
        tokenHash: await hashSessionToken(generateSessionToken()),
        csrfToken: generateCsrfToken(),
        expiresAt: future(),
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});