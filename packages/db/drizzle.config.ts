import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration for the Zelora database layer.
 *
 * The schema is written against the SQLite dialect (portable to Cloudflare D1).
 * `dbCredentials.url` points at the local development SQLite file; production
 * uses Cloudflare D1 and is applied with `wrangler d1 migrations apply`.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: ".data/zelora.db",
  },
});