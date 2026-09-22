import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "./client";

/**
 * Minimal structural view of Cloudflare's D1 database binding.
 *
 * The D1 factory is a stable seam for the future production deployment. It is
 * intentionally dependency-free (no `@cloudflare/workers-types`): the set of
 * methods the Drizzle D1 driver actually touches at runtime is small. Passing
 * a real Worker `env.DB` binding satisfies this shape structurally.
 */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta: unknown }>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
  exec(query: string): Promise<unknown>;
}

/**
 * Type of the client parameter expected by the Drizzle D1 driver. Resolved
 * through `Parameters` so it stays correct whether or not
 * `@cloudflare/workers-types` is installed.
 */
type AnyD1Client = Parameters<typeof drizzle>[0];

/**
 * Wrap a Cloudflare D1 binding (`env.DB`) into a typed Drizzle client.
 * Usage is identical to `createLocalClient`, so later phases can switch
 * databases without changing application queries.
 */
export function createD1Client(database: D1DatabaseLike): DrizzleD1Database<DatabaseSchema> {
  return drizzle<DatabaseSchema>(database as unknown as AnyD1Client);
}