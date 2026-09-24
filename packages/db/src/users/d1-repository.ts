import { eq } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { users } from "../schema/identities";
import type { CreateAdminConflictReason, UserRepository } from "./repository";

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

    async createAdmin(input) {
      try {
        const rows = await db.insert(users).values(input).returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("user insert returned no row");
        }
        return { ok: true, user: row };
      } catch (error) {
        const reason = mapD1UserCreateConflict(error);
        if (reason !== null) {
          return { ok: false, reason };
        }
        throw error;
      }
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

/**
 * Table.column selectors (as rendered by SQLite in error messages) for the
 * two UNIQUE constraints a bootstrap insert can hit. The email constraint is
 * `EMAIL_IN_USE`; the single-admin partial index on `role` is
 * `ADMIN_ALREADY_EXISTS`. Both constraints remain the race-condition backstop.
 */
const CONFLICT_TABLE_COLUMNS: Readonly<Record<string, CreateAdminConflictReason>> = {
  "users.email": "EMAIL_IN_USE",
  "users.role": "ADMIN_ALREADY_EXISTS",
};

/**
 * SQLite emits the conflict text as `UNIQUE constraint failed: <table>.<column>`.
 * D1 wraps it as `D1_ERROR: <sqlite text>: SQLITE_CONSTRAINT_UNIQUE`, and
 * Drizzle forwards the driver error verbatim. This matcher extracts the
 * table.column token from any of those shapes and maps it back to the
 * driver-neutral reason.
 */
const UNIQUE_CONFLICT_PATTERN = /UNIQUE constraint failed:\s+([a-z0-9_]+)\.([a-z0-9_]+)/i;

/**
 * Translate a D1/Drizzle UNIQUE constraint failure from a bootstrap insert
 * into the driver-neutral {@link CreateAdminConflictReason}, or `null` when
 * the error is unrelated. Extraction is tolerant of wrapper prefixes
 * (`D1_ERROR:`), the trailing `: SQLITE_CONSTRAINT_UNIQUE` code, nested
 * `cause` chains and cross-realm error objects. This function is pure and
 * exported for tests.
 */
export function mapD1UserCreateConflict(error: unknown): CreateAdminConflictReason | null {
  for (const message of collectErrorMessages(error)) {
    const match = UNIQUE_CONFLICT_PATTERN.exec(message);
    if (match === null) {
      continue;
    }
    const table = match[1]?.toLowerCase();
    const column = match[2]?.toLowerCase();
    const conflict = CONFLICT_TABLE_COLUMNS[`${table}.${column}`];
    if (conflict !== undefined) {
      return conflict;
    }
  }
  return null;
}

/**
 * Collect non-empty error messages across up to three levels of `cause`
 * nesting, tolerating plain objects (D1 errors can cross realm boundaries
 * where `instanceof Error` is unreliable) and bare strings. Wrapper layers
 * established by Drizzle/Driver adapters often carry their own message with
 * the driver error attached as `cause`, so the conflict matcher above
 * inspects every collected message rather than only the outermost one.
 */
function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== null && current !== undefined; depth++) {
    if (typeof current === "string" && current !== "") {
      messages.push(current);
    } else if (typeof current === "object") {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string" && message !== "") {
        messages.push(message);
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return messages;
}