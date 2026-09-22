import { integer, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql, type SQL } from "drizzle-orm";
import { createId } from "../ids";

/**
 * Shared column primitives. Every table is built from these so the schema
 * stays consistent and additive.
 */

/** Text primary key pre-populated with a UUIDv7 id on insert. */
export function idColumn() {
  return text("id").primaryKey().$defaultFn(createId);
}

/** `created_at` — Unix epoch milliseconds, populated on insert. */
export function createdAtColumn() {
  return integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());
}

/** `updated_at` — Unix epoch milliseconds, populated on insert and update. */
export function updatedAtColumn() {
  return integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()).$onUpdateFn(() => new Date());
}

/**
 * ISO 4217 currency code stored per monetary record (money is data, not
 * config). Length is enforced with an explicit `CHECK` at table level.
 */
export function currencyColumn(name = "currency") {
  return text(name, { length: 3 }).notNull();
}

/** ISO 3166-1 alpha-2 country code. Length enforced with an explicit `CHECK`. */
export function countryCodeColumn(name = "country_code") {
  return text(name, { length: 2 }).notNull();
}

/**
 * Integer flag (0/1). Not a real boolean so future migration is trivial;
 * membership in `(0, 1)` is enforced with an explicit `CHECK` at table level.
 */
export function flagColumn(name: string, defaultValue = 0) {
  return integer(name).notNull().default(defaultValue);
}

/** Render an enum value list for a generated `CHECK` constraint. */
function enumValues(values: readonly string[]): SQL {
  return sql.join(values.map((value) => sql`${sql.raw(`'${value}'`)}`), sql`, `);
}

/**
 * Build a `CHECK` for an enum column. SQLite has no native enum type and
 * Drizzle does not emit one for `text({ enum })` on SQLite, so this adds the
 * real `col IN (...)` constraint to the schema.
 */
export function enumCheck(column: AnySQLiteColumn, values: readonly string[]): SQL {
  return sql`${column} in (${enumValues(values)})`;
}