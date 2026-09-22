import { eq, lte } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { authSessions } from "../schema/auth";
import type { AuthSessionRepository } from "./repository";

/**
 * Cloudflare D1 implementation of the auth session repository.
 *
 * Concrete implementation of {@link AuthSessionRepository} against the Drizzle
 * D1 client created by {@link createD1Client}. Every method is async (D1 is
 * promise-based) and mirrors the local better-sqlite3 implementation, so the
 * auth service and middleware behave identically on both runtimes.
 *
 * This module is deliberately Worker-safe: it imports only the Drizzle D1
 * driver and the session contract. The Node-only SQLite stack never appears
 * here, so the Worker bundle stays free of `better-sqlite3`.
 */
export function createD1AuthSessionRepository(
  db: DrizzleD1Database<DatabaseSchema>,
): AuthSessionRepository {
  return {
    async create(input) {
      const row = await db.insert(authSessions).values(input).returning().get();
      if (row === undefined) {
        throw new Error("auth session insert returned no row");
      }
      return row;
    },

    async findByTokenHash(tokenHash) {
      const row = await db.select().from(authSessions).where(eq(authSessions.tokenHash, tokenHash)).get();
      return row ?? null;
    },

    async deleteById(id) {
      const result = await db.delete(authSessions).where(eq(authSessions.id, id)).run();
      return changes(result) > 0;
    },

    async deleteAllForUser(userId) {
      const result = await db.delete(authSessions).where(eq(authSessions.userId, userId)).run();
      return changes(result);
    },

    async updateLastUsedAt(id, lastUsedAt) {
      const result = await db.update(authSessions).set({ lastUsedAt }).where(eq(authSessions.id, id)).run();
      return changes(result) > 0;
    },

    async purgeExpired(now = new Date()) {
      const result = await db.delete(authSessions).where(lte(authSessions.expiresAt, now)).run();
      return changes(result);
    },
  };
}

/**
 * Read the `changes` count off a D1 write result.
 *
 * D1 exposes its row-count on the `.meta.changes` field of the result returned
 * by `run()`. The Drizzle D1 driver types intentionally stay loose here
 * (Cloudflare worker types are not a runtime dependency), so the value is
 * resolved defensively and never surfaced raw.
 */
function changes(result: { meta?: { changes?: unknown } }): number {
  const value = result.meta?.changes;
  return typeof value === "number" ? value : 0;
}