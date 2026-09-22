import { eq } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { users } from "../schema/identities";
import type { UserRepository } from "./repository";

/**
 * Local (better-sqlite3) implementation of the user repository.
 *
 * Built on the existing local Drizzle client. Even though better-sqlite3 is
 * synchronous, the methods here still present the async port contract so
 * callers and tests are driver-agnostic and a Cloudflare D1 implementation can
 * satisfy the same interface later.
 *
 * Email is matched exactly as provided: normalization belongs to the
 * authentication service, never to the repository.
 */
export function createLocalUserRepository(db: LocalDatabase): UserRepository {
  return {
    async create(input) {
      const row = db.insert(users).values(input).returning().get();
      if (row === undefined) {
        throw new Error("user insert returned no row");
      }
      return row;
    },

    async findByEmail(email) {
      return db.select().from(users).where(eq(users.email, email)).get() ?? null;
    },

    async findById(id) {
      return db.select().from(users).where(eq(users.id, id)).get() ?? null;
    },
  };
}