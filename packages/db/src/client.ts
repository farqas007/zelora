import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type DatabaseSchema = typeof schema;
export type LocalDatabase = BetterSQLite3Database<DatabaseSchema>;

export interface LocalSqliteClient {
  db: LocalDatabase;
  sqlite: Database.Database;
}

const DEFAULT_DB_PATH = ".data/zelora.db";

/** Resolve the local SQLite file path from the environment (config-style). */
export function resolveDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.ZELORA_DB_PATH ?? DEFAULT_DB_PATH;
}

/**
 * Open a local SQLite connection as a typed Drizzle client.
 *
 * Uses the exact SQLite dialect that Cloudflare D1 speaks so schema and
 * behavior stay portable. `PRAGMA foreign_keys = ON` is set explicitly: it is
 * the default in D1, and this guarantees local behavior matches production.
 *
 * @param filename default `:memory:` for tests; otherwise `ZELORA_DB_PATH`.
 *   Relative paths resolve against the process working directory.
 */
export function createLocalClient(
  filename: string | undefined = ":memory:",
): LocalSqliteClient {
  const path = filename ?? resolveDbPath();
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}