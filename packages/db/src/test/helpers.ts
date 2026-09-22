import { expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema";
import type { DatabaseSchema } from "../client";
import { migrateLocal } from "../migrate";

export interface TestDatabase {
  db: BetterSQLite3Database<DatabaseSchema>;
  sqlite: Database.Database;
}

/**
 * In-memory database with the real committed migrations applied, in the state
 * Cloudflare D1 enforces: foreign keys ON. Every test gets an isolated
 * connection.
 */
export function createTestDatabase(): TestDatabase {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrateLocal(db);
  return { db, sqlite };
}

/** Assert that a statement throws a SQLite constraint error. */
export function expectConstraintError(fn: () => unknown, pattern: RegExp): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect(String(error)).toMatch(pattern);
}