import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { countryCodeColumn, createdAtColumn, enumCheck, flagColumn, idColumn, updatedAtColumn } from "./_common";
import { users } from "./identities";
import { ADDRESS_TYPES } from "./enums";

/**
 * Customer address book. Snapshotting: once an order is placed its addresses
 * are copied verbatim into `order_addresses`, so editing (or deleting) a row
 * here never mutates placed orders. Addresses are sensitive PII.
 */
export const addresses = sqliteTable("addresses", {
  id: idColumn(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  type: text("type", { enum: ADDRESS_TYPES }).notNull(),
  isDefault: flagColumn("is_default"),
  recipientName: text("recipient_name").notNull(),
  phone: text("phone"),
  line1: text("line1").notNull(),
  line2: text("line2"),
  city: text("city").notNull(),
  region: text("region"),
  postalCode: text("postal_code"),
  countryCode: countryCodeColumn(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  index("addresses_user_id_type_idx").on(table.userId, table.type),
  /**
   * SQLite treats NULLs as distinct in UNIQUE, so a plain compound unique
   * would not prevent several default addresses. The partial index enforces
   * "at most one default per (user, type)".
   */
  uniqueIndex("addresses_user_type_default_unique").on(table.userId, table.type).where(sql`${table.isDefault} = 1`),
  check("addresses_is_default_flag", sql`${table.isDefault} in (0, 1)`),
  check("addresses_country_code_length", sql`length(${table.countryCode}) = 2`),
  check("addresses_type_check", enumCheck(table.type, ADDRESS_TYPES)),
]);