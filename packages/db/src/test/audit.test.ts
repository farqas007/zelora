import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { isValidId } from "../ids";
import * as schema from "../schema";
import { createLocalAuditLogRepository } from "../audit/local-repository";
import { createTestDatabase } from "./helpers";

/**
 * Real-SQLite integration tests for the audit-log repository. Audit rows are
 * append-only: `create` always inserts, and there is no update or delete path.
 * Each test uses an isolated in-memory database with the committed migrations
 * applied (foreign keys ON), matching the Cloudflare D1 runtime behavior.
 */

let userSeq = 0;

function insertUser(db: LocalDatabase): string {
  userSeq += 1;
  return db
    .insert(schema.users)
    .values({ email: `audit-user-${userSeq}@example.test`, name: "Audit User" })
    .returning({ id: schema.users.id })
    .get().id;
}

describe("audit log repository", () => {
  it("appends a row with a generated id, action and nullable actor/target", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuditLogRepository(db);

    const actor = insertUser(db);
    const target = insertUser(db);
    const row = await repo.create({
      actorUserId: actor,
      action: "seller.reject",
      targetUserId: target,
      details: JSON.stringify({ sellerProfileId: "profile-1" }),
    });

    expect(isValidId(row.id)).toBe(true);
    expect(row.actorUserId).toBe(actor);
    expect(row.targetUserId).toBe(target);
    expect(row.action).toBe("seller.reject");
    expect(row.details).toBe(JSON.stringify({ sellerProfileId: "profile-1" }));
    expect(row.createdAt).toBeInstanceOf(Date);

    const persisted = db.select().from(schema.auditLogs).where(eq(schema.auditLogs.id, row.id)).get();
    expect(persisted?.action).toBe("seller.reject");
    expect(persisted?.actorUserId).toBe(actor);
    expect(persisted?.targetUserId).toBe(target);
  });

  it("supports system events with no actor, no target and no details", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuditLogRepository(db);

    const target = insertUser(db);
    const row = await repo.create({
      actorUserId: null,
      action: "admin.bootstrap",
      targetUserId: target,
    });

    expect(row.actorUserId).toBeNull();
    expect(row.targetUserId).toBe(target);
    expect(row.details).toBeNull();
  });

  it("lists rows for an action newest-first", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuditLogRepository(db);

    const target = insertUser(db);
    const older = db
      .insert(schema.auditLogs)
      .values({
        actorUserId: null,
        action: "admin.bootstrap",
        targetUserId: target,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      })
      .returning()
      .get();
    const newer = db
      .insert(schema.auditLogs)
      .values({
        actorUserId: null,
        action: "admin.bootstrap",
        targetUserId: target,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      })
      .returning()
      .get();

    const rows = await repo.listByAction("admin.bootstrap");
    expect(rows.map((row) => row.id)).toEqual([newer.id, older.id]);
  });

  it("does not mix other actions into the listing", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuditLogRepository(db);

    const target = insertUser(db);
    await repo.create({ actorUserId: null, action: "seller.activate", targetUserId: target });
    const bootstrap = await repo.create({
      actorUserId: null,
      action: "admin.bootstrap",
      targetUserId: target,
    });

    const rows = await repo.listByAction("admin.bootstrap");
    expect(rows.map((row) => row.id)).toEqual([bootstrap.id]);
  });

  it("bounds the listing limit to the [1, 200] window", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuditLogRepository(db);

    const target = insertUser(db);
    for (let index = 0; index < 5; index += 1) {
      await repo.create({ actorUserId: null, action: "seller.activate", targetUserId: target });
    }

    const overBounded = await repo.listByAction("seller.activate", 1_000);
    expect(overBounded).toHaveLength(5);

    const underBounded = await repo.listByAction("seller.activate", 0);
    expect(underBounded).toHaveLength(1);
  });

  it("cannot reference a user that does not exist", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuditLogRepository(db);

    await expect(
      repo.create({
        actorUserId: "00000000-0000-7000-8000-000000000999",
        action: "seller.activate",
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("nulls the actor on user deletion instead of orphaning the audit row", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalAuditLogRepository(db);

    const actor = insertUser(db);
    const target = insertUser(db);
    const row = await repo.create({
      actorUserId: actor,
      action: "seller.reject",
      targetUserId: target,
    });

    db.delete(schema.users).where(eq(schema.users.id, actor)).run();

    const persisted = db.select().from(schema.auditLogs).where(eq(schema.auditLogs.id, row.id)).get();
    expect(persisted?.actorUserId).toBeNull();
    expect(persisted?.targetUserId).toBe(target);
  });
});