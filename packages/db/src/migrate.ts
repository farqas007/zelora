import { fileURLToPath } from "node:url";
import { migrate as runBetterSqlite3Migrations } from "drizzle-orm/better-sqlite3/migrator";
import type { LocalDatabase } from "./client";

/**
 * Apply committed migrations to a local (better-sqlite3) database, e.g. on an
 * in-memory database in tests. For Cloudflare D1 use
 * `wrangler d1 migrations apply` with the same `migrations/` folder.
 */
export function migrateLocal(db: LocalDatabase, migrationsFolder?: string): void {
  runBetterSqlite3Migrations(db, {
    migrationsFolder: migrationsFolder ?? fileURLToPath(new URL("../migrations", import.meta.url)),
  });
}