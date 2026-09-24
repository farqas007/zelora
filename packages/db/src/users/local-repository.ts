import { eq } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { users } from "../schema/identities";
import type { CreateAdminConflictReason, UserRepository } from "./repository";

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
 *
 * {@link UserRepository.createAdmin} relies on the shared partial unique index
 * on `users.role` — the same constraint both SQLite and D1 enforce — so two
 * concurrent bootstraps with different emails can never both succeed.
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

    async createAdmin(input) {
      try {
        const row = db.insert(users).values(input).returning().get();
        if (row === undefined) {
          throw new Error("user insert returned no row");
        }
        return { ok: true, user: row };
      } catch (error) {
        const reason = mapUserCreateConflict(error);
        if (reason !== null) {
          return { ok: false, reason };
        }
        throw error;
      }
    },

    async findByEmail(email) {
      return db.select().from(users).where(eq(users.email, email)).get() ?? null;
    },

    async findById(id) {
      return db.select().from(users).where(eq(users.id, id)).get() ?? null;
    },
  };
}

/**
 * Translate a better-sqlite3 UNIQUE constraint failure from a bootstrap insert
 * into the driver-neutral {@link CreateAdminConflictReason}. The email
 * constraint collapses to `EMAIL_IN_USE`; the single-admin partial index on
 * `role` collapses to `ADMIN_ALREADY_EXISTS`.
 */
function mapUserCreateConflict(error: unknown): CreateAdminConflictReason | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (/UNIQUE constraint failed: users\.email/.test(error.message)) {
    return "EMAIL_IN_USE";
  }
  if (/UNIQUE constraint failed: users\.role/.test(error.message)) {
    return "ADMIN_ALREADY_EXISTS";
  }
  return null;
}