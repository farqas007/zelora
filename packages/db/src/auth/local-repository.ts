import { eq, lte } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { authSessions } from "../schema/auth";
import type { AuthSessionRepository } from "./repository";

/**
 * Local (better-sqlite3) implementation of the auth session repository.
 *
 * Built on the existing local Drizzle client. Even though better-sqlite3 is
 * synchronous, the methods here still present the async port contract so
 * callers and tests are driver-agnostic and a Cloudflare D1 implementation can
 * satisfy the same interface later.
 */
export function createLocalAuthSessionRepository(db: LocalDatabase): AuthSessionRepository {
  return {
    async create(input) {
      const row = db.insert(authSessions).values(input).returning().get();
      if (row === undefined) {
        throw new Error("auth session insert returned no row");
      }
      return row;
    },

    async findByTokenHash(tokenHash) {
      return db.select().from(authSessions).where(eq(authSessions.tokenHash, tokenHash)).get() ?? null;
    },

    async deleteById(id) {
      return db.delete(authSessions).where(eq(authSessions.id, id)).run().changes > 0;
    },

    async deleteAllForUser(userId) {
      return db.delete(authSessions).where(eq(authSessions.userId, userId)).run().changes;
    },

    async updateLastUsedAt(id, lastUsedAt) {
      return db
        .update(authSessions)
        .set({ lastUsedAt })
        .where(eq(authSessions.id, id))
        .run().changes > 0;
    },

    async purgeExpired(now = new Date()) {
      return db.delete(authSessions).where(lte(authSessions.expiresAt, now)).run().changes;
    },
  };
}