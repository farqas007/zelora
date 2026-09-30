import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { IDEMPOTENCY_FINGERPRINT_HEX_LENGTH, IDEMPOTENCY_KEY_LIMITS } from "@zelora/shared";
import * as schema from "../schema";
import { createId } from "../ids";
import type { DatabaseSchema } from "../client";
import { expectConstraintError } from "./helpers";

/**
 * Migration 0008 (`cooing_aqueduct`) run against a database that is in the
 * state production is in: migrations 0000-0007 applied, real order rows with
 * their `order_items` and `order_addresses` children already present.
 *
 * This suite exists because the migration it covers is a production fix. The
 * first version of 0008 rebuilt `orders` the way Drizzle's own generator emits
 * (`CREATE TABLE __new_orders`, copy, `DROP TABLE orders`, rename), which cannot
 * run on a populated database: `order_items` and `order_addresses` reference
 * `orders` with `ON DELETE RESTRICT`, and D1 applies migrations inside a
 * transaction where `PRAGMA foreign_keys=OFF` is a no-op, so the `DROP` aborts
 * the whole migration with `FOREIGN KEY constraint failed`. Production lost no
 * data because D1 rolled the migration back, but no order could be written
 * against a schema still stuck at 0007.
 *
 * So the migration is asserted on the properties that make it safe to apply to
 * live data: it never drops, renames or rewrites `orders`; every existing order
 * row, line and address survives; the idempotency pair is backfilled; and the
 * unique index, the length CHECKs and NOT NULL all hold afterwards. Each
 * assertion below runs against real SQLite with foreign keys ON — the state D1
 * enforces — so a regression in the migration SQL fails here rather than in
 * production.
 *
 * The NOT NULL guarantee deserves a note, because it is the one place this
 * migration cannot use the obvious tool. SQLite refuses `ALTER TABLE ADD COLUMN
 * ... NOT NULL` on a table that already has rows, and the only way to add it is
 * the table rebuild this migration exists to avoid. The column is therefore
 * added nullable and NOT NULL is enforced by BEFORE INSERT/UPDATE triggers that
 * abort with the same message a real NOT NULL column raises — SQLite would
 * otherwise let a NULL key past the UNIQUE index (NULLs compare distinct), which
 * is exactly the hole the idempotency guarantee must not have. The Drizzle
 * schema keeps its `notNull()` declarations because they remain true of every
 * row; `assertNullKeyIsRejected` and `assertNullFingerprintIsRejected` are what
 * hold them there.
 */

/** The fingerprint the migration backfills: 64 zeroes. */
const BACKFILLED_FINGERPRINT = "0".repeat(IDEMPOTENCY_FINGERPRINT_HEX_LENGTH);

/**
 * Migration file names up to but excluding `0008_cooing_aqueduct.sql`, i.e. the
 * exact revision production is sitting on.
 */
const PRE_0008_MIGRATIONS = [
  "0000_stiff_swordsman.sql",
  "0001_wandering_lionheart.sql",
  "0002_serious_overlord.sql",
  "0003_oval_frightful_four.sql",
  "0004_amusing_molecule_man.sql",
  "0005_nappy_screwball.sql",
  "0006_lovely_arachne.sql",
  "0007_lucky_amazoness.sql",
] as const;

interface LegacyGraph {
  customerUserId: string;
  orderId: string;
  itemId: string;
  addressId: string;
  storeId: string;
  variantId: string;
}

/**
 * The DDL of 0000-0007, then one complete pre-idempotency order graph.
 *
 * Written as literal SQL rather than through the Drizzle schema on purpose: the
 * current schema describes the post-0008 shape (it has the idempotency columns,
 * which do not exist yet at this revision), so building rows through it would
 * insert columns the target database has not got. Raw SQL also keeps this suite
 * honest about what production actually holds: orders whose rows have no key and
 * no fingerprint at all.
 */
const LEGACY_SETUP_SQL = [
  `INSERT INTO "users" ("id", "email", "name", "role", "status", "password_hash", "created_at", "updated_at")
   VALUES ('{customerUserId}', 'legacy-customer@example.test', 'Legacy Customer', 'customer', 'active', 'hash', 1, 1)`,
  `INSERT INTO "users" ("id", "email", "name", "role", "status", "password_hash", "created_at", "updated_at")
   VALUES ('{sellerUserId}', 'legacy-seller@example.test', 'Legacy Seller', 'seller', 'active', 'hash', 1, 1)`,
  `INSERT INTO "seller_profiles" ("id", "user_id", "slug", "display_name", "status", "created_at", "updated_at")
   VALUES ('{sellerProfileId}', '{sellerUserId}', 'legacy-seller', 'Legacy Seller', 'active', 1, 1)`,
  `INSERT INTO "stores" ("id", "seller_profile_id", "name", "slug", "status", "created_at", "updated_at")
   VALUES ('{storeId}', '{sellerProfileId}', 'Legacy Store', 'legacy-store', 'active', 1, 1)`,
  `INSERT INTO "products" ("id", "store_id", "name", "slug", "status", "created_at", "updated_at")
   VALUES ('{productId}', '{storeId}', 'Legacy Product', 'legacy-product', 'active', 1, 1)`,
  `INSERT INTO "product_variants" ("id", "product_id", "sku", "name", "currency", "price_amount_cents", "status", "created_at", "updated_at")
   VALUES ('{variantId}', '{productId}', 'LEGACY-1', 'Legacy Variant', 'USD', 1000, 'active', 1, 1)`,
  `INSERT INTO "orders" ("id", "customer_user_id", "status", "currency", "subtotal_amount_cents", "shipping_amount_cents", "discount_amount_cents", "total_amount_cents", "created_at", "updated_at")
   VALUES ('{orderId}', '{customerUserId}', 'confirmed', 'USD', 1000, 0, 0, 1000, 1, 1)`,
  `INSERT INTO "order_items" ("id", "order_id", "variant_id", "store_id", "product_name", "variant_name", "sku", "quantity", "unit_amount_cents", "line_total_amount_cents", "currency", "status", "created_at", "updated_at")
   VALUES ('{itemId}', '{orderId}', '{variantId}', '{storeId}', 'Legacy Product', 'Legacy Variant', 'LEGACY-1', 1, 1000, 1000, 'USD', 'pending', 1, 1)`,
  `INSERT INTO "order_addresses" ("id", "order_id", "kind", "recipient_name", "line1", "city", "country_code", "created_at", "updated_at")
   VALUES ('{addressId}', '{orderId}', 'shipping', 'Legacy Customer', '1 Legacy Way', 'Legacyville', 'US', 1, 1)`,
] as const;

/**
 * A database at revision 0007 holding one complete legacy order graph.
 *
 * `foreign_keys = ON` is the D1 default and the state that made the old 0008
 * fail, so it is set explicitly rather than left to the SQLite default: these
 * tests must exercise the same enforcement production does.
 */
function createPre0008Database(): { sqlite: Database.Database; legacy: LegacyGraph } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite, PRE_0008_MIGRATIONS);

  const legacy: LegacyGraph = {
    customerUserId: createId(),
    orderId: createId(),
    itemId: createId(),
    addressId: createId(),
    storeId: createId(),
    variantId: createId(),
  };
  const substitutions = {
    ...legacy,
    sellerUserId: createId(),
    sellerProfileId: createId(),
    productId: createId(),
  };
  for (const statement of LEGACY_SETUP_SQL) {
    sqlite.exec(statement.replace(/\{(\w+)\}/g, (_match, key: string) => substitutions[key as keyof typeof substitutions]));
  }

  return { sqlite, legacy };
}

/** Apply one migration file's statements, split the way every harness splits them. */
function applyMigrations(sqlite: Database.Database, files: readonly string[]): void {
  for (const file of files) {
    const sql = readMigration(file);
    for (const block of sql.split("--> statement-breakpoint")) {
      const statement = block.trim();
      if (statement !== "") {
        sqlite.exec(statement);
      }
    }
  }
}

/** Read a migration file from the committed `migrations/` folder. */
function readMigration(file: string): string {
  return readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8");
}

/** The committed 0008 migration, which every test in this suite applies. */
const MIGRATION_0008 = "0008_cooing_aqueduct.sql";

interface MigratedDatabase {
  db: ReturnType<typeof drizzle<DatabaseSchema>>;
  sqlite: Database.Database;
  legacy: LegacyGraph;
}

/**
 * A database migrated through 0008 the way production will be: 0000-0007 and the
 * legacy order graph first, then the pending migration on top.
 *
 * The whole sequence runs in one transaction so a failure anywhere leaves
 * nothing half-applied, matching how D1 executes a migration file.
 */
function createMigratedDatabase(): MigratedDatabase {
  const { sqlite, legacy } = createPre0008Database();
  sqlite.exec("BEGIN");
  try {
    applyMigrations(sqlite, [MIGRATION_0008]);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    sqlite.close();
    throw error;
  }
  return { db: drizzle(sqlite, { schema }), sqlite, legacy };
}

/**
 * Read one row as a plain object.
 *
 * better-sqlite3 returns `undefined` for a missing row, which TypeScript widens
 * to `any`; the cast keeps the assertions below honest about what they handle.
 */
function selectRow(sqlite: Database.Database, sql: string): Record<string, unknown> {
  return sqlite.prepare(sql).get() as Record<string, unknown>;
}

function countRows(sqlite: Database.Database, table: string): number {
  return (selectRow(sqlite, `SELECT COUNT(*) AS n FROM "${table}"`)?.n as number) ?? 0;
}

describe("migration 0008 applied to a database that already has orders", () => {
  it("applies without dropping, renaming or rewriting the orders table", () => {
    const { sqlite } = createMigratedDatabase();
    try {
      // The original migration failed here, with exactly this error, because it
      // dropped a table its children reference. The table must still be the one
      // 0000 created: same name, and the customer foreign key still declared.
      const ordersSql = (
        selectRow(sqlite, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'")
          ?.sql as string
      ).replace(/\s+/g, " ");
      expect(ordersSql).toContain("CREATE TABLE `orders`");
      expect(ordersSql).toContain(
        'FOREIGN KEY (`customer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict',
      );
      // The two new columns are appended to that same table, carrying the named
      // CHECKs inline, rather than the table being rebuilt around them.
      expect(ordersSql).toContain('CONSTRAINT "orders_idempotency_key_length"');
      expect(ordersSql).toContain('CONSTRAINT "orders_idempotency_fingerprint_length"');

      // No leftover scaffolding from a recreate-style migration.
      const leftover = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE '__new_%'")
        .all() as unknown as Array<{ name: string }>;
      expect(leftover).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("preserves the existing order row and every column on it", () => {
    const { sqlite, legacy } = createMigratedDatabase();
    try {
      const order = selectRow(sqlite, `SELECT * FROM "orders" WHERE "id" = '${legacy.orderId}'`);
      expect(order).toBeDefined();
      // Every column the pre-0008 schema had, with the values it had.
      expect(order?.id).toBe(legacy.orderId);
      expect(order?.customer_user_id).toBe(legacy.customerUserId);
      expect(order?.status).toBe("confirmed");
      expect(order?.currency).toBe("USD");
      expect(order?.subtotal_amount_cents).toBe(1000);
      expect(order?.shipping_amount_cents).toBe(0);
      expect(order?.discount_amount_cents).toBe(0);
      expect(order?.total_amount_cents).toBe(1000);
      expect(order?.created_at).toBe(1);
      expect(order?.updated_at).toBe(1);

      // And nothing else was invented or lost.
      expect(countRows(sqlite, "orders")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("leaves the order's items and addresses in place and valid", () => {
    const { sqlite, legacy } = createMigratedDatabase();
    try {
      const item = selectRow(sqlite, `SELECT * FROM "order_items" WHERE "id" = '${legacy.itemId}'`);
      expect(item?.order_id).toBe(legacy.orderId);
      expect(item?.variant_id).toBe(legacy.variantId);
      expect(item?.store_id).toBe(legacy.storeId);
      expect(item?.quantity).toBe(1);
      expect(item?.unit_amount_cents).toBe(1000);
      expect(item?.line_total_amount_cents).toBe(1000);

      const address = selectRow(sqlite, `SELECT * FROM "order_addresses" WHERE "id" = '${legacy.addressId}'`);
      expect(address?.order_id).toBe(legacy.orderId);
      expect(address?.kind).toBe("shipping");
      expect(address?.line1).toBe("1 Legacy Way");
      expect(address?.country_code).toBe("US");

      expect(countRows(sqlite, "order_items")).toBe(1);
      expect(countRows(sqlite, "order_addresses")).toBe(1);

      // The referential actions the rebuild would have broken are still enforced.
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      expectConstraintError(
        () => sqlite.exec(`DELETE FROM "orders" WHERE "id" = '${legacy.orderId}'`),
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      sqlite.close();
    }
  });

  it("backfills idempotency_key with the order's own id", () => {
    const { sqlite, legacy } = createMigratedDatabase();
    try {
      const order = selectRow(sqlite, `SELECT * FROM "orders" WHERE "id" = '${legacy.orderId}'`);
      expect(order?.idempotency_key).toBe(legacy.orderId);
      // UUIDv7 is 36 characters, inside the 8..64 the key CHECK requires, so the
      // backfilled value satisfies the constraint it is backfilled under.
      expect((order?.idempotency_key as string).length).toBeGreaterThanOrEqual(IDEMPOTENCY_KEY_LIMITS.minLength);
      expect((order?.idempotency_key as string).length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_LIMITS.maxLength);
    } finally {
      sqlite.close();
    }
  });

  it("backfills a 64-character all-zero fingerprint", () => {
    const { sqlite, legacy } = createMigratedDatabase();
    try {
      const order = selectRow(sqlite, `SELECT * FROM "orders" WHERE "id" = '${legacy.orderId}'`);
      expect(order?.idempotency_fingerprint).toBe(BACKFILLED_FINGERPRINT);
      expect(order?.idempotency_fingerprint as string).toHaveLength(IDEMPOTENCY_FINGERPRINT_HEX_LENGTH);
      expect(order?.idempotency_fingerprint as string).toMatch(/^0+$/);
    } finally {
      sqlite.close();
    }
  });

  it("backfills every legacy order, not just the first", () => {
    const { sqlite } = createPre0008Database();
    const secondOrderId = createId();
    const secondCustomerId = createId();
    sqlite
      .prepare(
        `INSERT INTO "users" ("id", "email", "name", "role", "status", "password_hash", "created_at", "updated_at")
         VALUES (?, ?, ?, 'customer', 'active', 'hash', 1, 1)`,
      )
      .run(secondCustomerId, "second-legacy@example.test", "Second Legacy");
    sqlite
      .prepare(
        `INSERT INTO "orders" ("id", "customer_user_id", "status", "currency", "subtotal_amount_cents", "shipping_amount_cents", "discount_amount_cents", "total_amount_cents", "created_at", "updated_at")
         VALUES (?, ?, 'pending', 'USD', 0, 0, 0, 0, 2, 2)`,
      )
      .run(secondOrderId, secondCustomerId);

    applyMigrations(sqlite, [MIGRATION_0008]);

    const rows = sqlite.prepare("SELECT id, idempotency_key, idempotency_fingerprint FROM orders").all() as unknown as Array<{
      id: string;
      idempotency_key: string;
      idempotency_fingerprint: string;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.idempotency_key).toBe(row.id);
      expect(row.idempotency_fingerprint).toBe(BACKFILLED_FINGERPRINT);
    }
    sqlite.close();
  });
});

describe("the idempotency guarantees after migration 0008", () => {
  it("rejects a duplicate (customer_user_id, idempotency_key)", () => {
    const { db, sqlite, legacy } = createMigratedDatabase();
    try {
      // Replaying the legacy order's own key as a fresh order for the same
      // customer is the duplicate a retry would produce.
      expectConstraintError(
        () =>
          db
            .insert(schema.orders)
            .values({
              customerUserId: legacy.customerUserId,
              idempotencyKey: legacy.orderId,
              idempotencyFingerprint: "a".repeat(IDEMPOTENCY_FINGERPRINT_HEX_LENGTH),
              currency: "USD",
            })
            .run(),
        /UNIQUE constraint failed: orders\.customer_user_id, orders\.idempotency_key/,
      );

      // A second insert with the same key from the same customer is rejected too.
      const otherId = createId();
      const insertDuplicate = () =>
        db
          .insert(schema.orders)
          .values({
            id: otherId,
            customerUserId: legacy.customerUserId,
            idempotencyKey: legacy.orderId,
            idempotencyFingerprint: "a".repeat(IDEMPOTENCY_FINGERPRINT_HEX_LENGTH),
            currency: "USD",
          })
          .run();
      expectConstraintError(insertDuplicate, /UNIQUE constraint failed/);
      expect(countRows(sqlite, "orders")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("lets a different customer use the same idempotency key", () => {
    const { db, sqlite, legacy } = createMigratedDatabase();
    try {
      const otherCustomerId = db
        .insert(schema.users)
        .values({ email: "new-customer@example.test", name: "New Customer" })
        .returning({ id: schema.users.id })
        .get().id;

      // The same key string, a different customer: two independent orders. The
      // uniqueness is per customer precisely so two shoppers' generators
      // colliding cannot merge or expose their orders.
      const inserted = db
        .insert(schema.orders)
        .values({
          customerUserId: otherCustomerId,
          idempotencyKey: legacy.orderId,
          idempotencyFingerprint: "b".repeat(IDEMPOTENCY_FINGERPRINT_HEX_LENGTH),
          currency: "USD",
        })
        .returning()
        .get();

      expect(inserted.customerUserId).toBe(otherCustomerId);
      expect(inserted.idempotencyKey).toBe(legacy.orderId);
      expect(countRows(sqlite, "orders")).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it("rejects an idempotency key outside the shared length bounds", () => {
    const { db, sqlite, legacy } = createMigratedDatabase();
    try {
      // One character under and one over the shared bounds, plus a value that is
      // far too short to be a key. The bounds come from IDEMPOTENCY_KEY_LIMITS so
      // this test and the request validator cannot disagree about what fits.
      const { minLength, maxLength } = IDEMPOTENCY_KEY_LIMITS;
      for (const idempotencyKey of ["short", "k".repeat(minLength - 1), "k".repeat(maxLength + 1)]) {
        expectConstraintError(
          () =>
            db
              .insert(schema.orders)
              .values({
                customerUserId: legacy.customerUserId,
                idempotencyKey,
                idempotencyFingerprint: "c".repeat(IDEMPOTENCY_FINGERPRINT_HEX_LENGTH),
                currency: "USD",
              })
              .run(),
          /CHECK constraint failed: orders_idempotency_key_length/,
        );
      }
      expect(countRows(sqlite, "orders")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("rejects a fingerprint that is not a hex digest's width", () => {
    const { db, sqlite, legacy } = createMigratedDatabase();
    try {
      for (const idempotencyFingerprint of ["", "a".repeat(63), "a".repeat(65)]) {
        expectConstraintError(
          () =>
            db
              .insert(schema.orders)
              .values({
                customerUserId: legacy.customerUserId,
                idempotencyKey: "valid-key-0001",
                idempotencyFingerprint,
                currency: "USD",
              })
              .run(),
          /CHECK constraint failed: orders_idempotency_fingerprint_length/,
        );
      }
      expect(countRows(sqlite, "orders")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("rejects an order that supplies no idempotency key (NOT NULL via triggers)", () => {
    const { sqlite, legacy } = createMigratedDatabase();
    try {
      // SQLite cannot add NOT NULL to an existing column without rebuilding the
      // table, so the migration enforces it with triggers that raise the same
      // message. Without them a NULL key would pass the UNIQUE index, because
      // SQLite treats NULLs as distinct from each other.
      expectConstraintError(
        () =>
          sqlite.exec(
            `INSERT INTO "orders" ("id", "customer_user_id", "idempotency_fingerprint", "status", "currency", "subtotal_amount_cents", "shipping_amount_cents", "discount_amount_cents", "total_amount_cents", "created_at", "updated_at")
             VALUES ('${createId()}', '${legacy.customerUserId}', '${BACKFILLED_FINGERPRINT}', 'pending', 'USD', 0, 0, 0, 0, 3, 3)`,
          ),
        /NOT NULL constraint failed: orders\.idempotency_key/,
      );
      expect(countRows(sqlite, "orders")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("rejects an order that supplies no idempotency fingerprint", () => {
    const { sqlite, legacy } = createMigratedDatabase();
    try {
      expectConstraintError(
        () =>
          sqlite.exec(
            `INSERT INTO "orders" ("id", "customer_user_id", "idempotency_key", "status", "currency", "subtotal_amount_cents", "shipping_amount_cents", "discount_amount_cents", "total_amount_cents", "created_at", "updated_at")
             VALUES ('${createId()}', '${legacy.customerUserId}', 'no-fingerprint-key', 'pending', 'USD', 0, 0, 0, 0, 3, 3)`,
          ),
        /NOT NULL constraint failed: orders\.idempotency_fingerprint/,
      );
      expect(countRows(sqlite, "orders")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("refuses to blank an existing order's key or fingerprint afterwards", () => {
    const { sqlite, legacy } = createMigratedDatabase();
    try {
      // The triggers cover UPDATE as well as INSERT: a later write must not be
      // able to quietly turn a real order into one that can never be replayed.
      expectConstraintError(
        () => sqlite.exec(`UPDATE "orders" SET "idempotency_key" = NULL WHERE "id" = '${legacy.orderId}'`),
        /NOT NULL constraint failed: orders\.idempotency_key/,
      );
      expectConstraintError(
        () => sqlite.exec(`UPDATE "orders" SET "idempotency_fingerprint" = NULL WHERE "id" = '${legacy.orderId}'`),
        /NOT NULL constraint failed: orders\.idempotency_fingerprint/,
      );

      // An unrelated update still works, so the trigger is not over-firing.
      sqlite.exec(`UPDATE "orders" SET "status" = 'completed' WHERE "id" = '${legacy.orderId}'`);
      expect(selectRow(sqlite, `SELECT "status" FROM "orders" WHERE "id" = '${legacy.orderId}'`)?.status).toBe("completed");
    } finally {
      sqlite.close();
    }
  });

  it("adds the unique index the conflict mapper depends on", () => {
    const { sqlite } = createMigratedDatabase();
    try {
      const indexes = sqlite.prepare("PRAGMA index_list('orders')").all() as unknown as Array<{
        name: string;
        unique: number;
      }>;
      const unique = indexes.find((index) => index.name === "orders_customer_idempotency_key_unique");
      expect(unique?.unique).toBe(1);

      const columns = sqlite
        .prepare("PRAGMA index_info('orders_customer_idempotency_key_unique')")
        .all() as unknown as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(["customer_user_id", "idempotency_key"]);

      // The customer listing index from 0000 is still there too: the migration
      // adds to the table rather than replacing it.
      const all = indexes.map((index) => index.name);
      expect(all).toContain("orders_customer_created_at_idx");
    } finally {
      sqlite.close();
    }
  });
});