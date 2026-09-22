import { eq } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { users } from "../schema/identities";
import type { UserRepository } from "./repository";

/**
 * Cloudflare D1 implementation of the user repository.
 *
 * Concrete implementation of {@link UserRepository} against the Drizzle D1
 * client created by {@link createD1Client}. Mirrors the local better-sqlite3
 * implementation exactly: the created row is returned, email is matched
 * exactly as supplied (normalization is the auth service's job), and lookups
 * resolve to `null` when unknown.
 *
 * Worker-safe: only the Drizzle D1 driver and the user contract are imported;
 * the Node-only SQLite stack is never pulled into the Worker bundle.
 */
export function createD1UserRepository(
  db: DrizzleD1Database<DatabaseSchema>,
): UserRepository {
  return {
    async create(input) {
      const row = await db.insert(users).values(input).returning().get();
      if (row === undefined) {
        throw new Error("user insert returned no row");
      }
      return row;
    },

    async findByEmail(email) {
      const row = await db.select().from(users).where(eq(users.email, email)).get();
      return row ?? null;
    },

    async findById(id) {
      const row = await db.select().from(users).where(eq(users.id, id)).get();
      return row ?? null;
    },
  };
}