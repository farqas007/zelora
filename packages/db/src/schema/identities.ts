import { check, index, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { createdAtColumn, enumCheck, idColumn, updatedAtColumn } from "./_common";
import { SELLER_PROFILE_STATUSES, STORE_STATUSES, USER_ROLES, USER_STATUSES } from "./enums";

/**
 * Identity foundation: users (accounts), seller profiles and stores.
 *
 * A user may hold a single seller profile; a seller profile may own several
 * stores. Hard deletes are never used for users or stores — lifecycle changes
 * are expressed through `status` columns.
 */
export const users = sqliteTable("users", {
  id: idColumn(),
  email: text("email").notNull(),
  role: text("role", { enum: USER_ROLES }).notNull().default("customer"),
  status: text("status", { enum: USER_STATUSES }).notNull().default("active"),
  name: text("name").notNull(),
  /**
   * Reserved for the authentication phase. Zelora never stores plaintext
   * passwords: a later phase writes a salted KDF hash here. This phase never
   * populates it.
   */
  passwordHash: text("password_hash"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("users_email_unique").on(table.email),
  check("users_role_check", enumCheck(table.role, USER_ROLES)),
  check("users_status_check", enumCheck(table.status, USER_STATUSES)),
]);

export const sellerProfiles = sqliteTable("seller_profiles", {
  id: idColumn(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status", { enum: SELLER_PROFILE_STATUSES }).notNull().default("pending"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("seller_profiles_user_id_unique").on(table.userId),
  unique("seller_profiles_slug_unique").on(table.slug),
  check("seller_profiles_status_check", enumCheck(table.status, SELLER_PROFILE_STATUSES)),
]);

export const stores = sqliteTable("stores", {
  id: idColumn(),
  sellerProfileId: text("seller_profile_id").notNull().references(() => sellerProfiles.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  status: text("status", { enum: STORE_STATUSES }).notNull().default("draft"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("stores_slug_unique").on(table.slug),
  index("stores_seller_profile_id_idx").on(table.sellerProfileId),
  check("stores_status_check", enumCheck(table.status, STORE_STATUSES)),
]);