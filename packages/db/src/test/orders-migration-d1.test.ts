import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDEMPOTENCY_FINGERPRINT_HEX_LENGTH } from "@zelora/shared";

/**
 * Migration 0008 run on a real D1 runtime (workerd via Miniflare) against a
 * database that already holds orders.
 *
 * This is the suite that matches production most closely, and it exists because
 * of a detail the local SQLite tests cannot see. D1 applies a migration file as
 * one transaction and, inside a transaction, `PRAGMA foreign_keys = OFF` is a
 * no-op. The first version of 0008 therefore hit `FOREIGN KEY constraint failed`
 * the moment it reached its `DROP TABLE orders`, while the same SQL succeeds on
 * a local database where the pragma can be honoured. Testing only against
 * better-sqlite3 would have shown the migration as fine.
 *
 * The upgrade path is built in the order production will take: 0000-0007 first,
 * then a realistic pre-idempotency order graph with its `order_items` and
 * `order_addresses` children, and only then the pending 0008. Applying 0008 to an
 * empty database — as the rest of the D1 suite does — would pass either way and
 * prove nothing.
 *
 * Statements are collapsed to a single line before they reach workerd, the same
 * way `d1-integration.test.ts` prepares every migration. That is not cosmetic:
 * a leading `--` comment becomes one line with whatever follows it and swallows
 * the first statement, so this suite also pins the migration's comment style.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** The 0008 migration's file name, the only one applied after seeding. */
const MIGRATION_0008 = "0008_cooing_aqueduct.sql";

const BACKFILLED_FINGERPRINT = "0".repeat(IDEMPOTENCY_FINGERPRINT_HEX_LENGTH);

type D1Binding = Awaited<ReturnType<Miniflare["getD1Database"]>>;

/**
 * A second Miniflare instance, separate from the one in `d1-integration.test.ts`.
 *
 * It has to be its own: that suite applies all migrations to empty tables in its
 * `beforeAll`, whereas this one has to reach a populated database at revision
 * 0007 first. Sharing the instance would mean 0008 was already applied.
 */
let miniflare: Miniflare;
let binding: D1Binding;

const IDS = {
  customerUserId: "00000000-0000-7000-8000-000000000001",
  sellerUserId: "00000000-0000-7000-8000-000000000002",
  sellerProfileId: "00000000-0000-7000-8000-000000000003",
  storeId: "00000000-0000-7000-8000-0000000000dd",
  productId: "00000000-0000-7000-8000-0000000000bb",
  variantId: "00000000-0000-7000-8000-0000000000cc",
  orderId: "00000000-0000-7000-8000-0000000000aa",
  itemId: "00000000-0000-7000-8000-0000000000ee",
  addressId: "00000000-0000-7000-8000-0000000000ff",
} as const;

/**
 * One complete order graph as it exists before 0008: no idempotency key, no
 * fingerprint, and two child tables pointing at `orders`.
 *
 * Literal SQL, because at revision 0007 the idempotency columns do not exist yet
 * and an insert that named them would fail for the wrong reason.
 */
function legacyGraphStatements(): string[] {
  return [
    `INSERT INTO "users" ("id","email","name","role","status","password_hash","created_at","updated_at")
     VALUES ('${IDS.customerUserId}', 'd1-legacy-customer@example.test', 'Legacy Customer', 'customer', 'active', 'hash', 1, 1)`,
    `INSERT INTO "users" ("id","email","name","role","status","password_hash","created_at","updated_at")
     VALUES ('${IDS.sellerUserId}', 'd1-legacy-seller@example.test', 'Legacy Seller', 'seller', 'active', 'hash', 1, 1)`,
    `INSERT INTO "seller_profiles" ("id","user_id","slug","display_name","status","created_at","updated_at")
     VALUES ('${IDS.sellerProfileId}', '${IDS.sellerUserId}', 'd1-legacy-seller', 'Legacy Seller', 'active', 1, 1)`,
    `INSERT INTO "stores" ("id","seller_profile_id","name","slug","status","created_at","updated_at")
     VALUES ('${IDS.storeId}', '${IDS.sellerProfileId}', 'Legacy Store', 'd1-legacy-store', 'active', 1, 1)`,
    `INSERT INTO "products" ("id","store_id","name","slug","status","created_at","updated_at")
     VALUES ('${IDS.productId}', '${IDS.storeId}', 'Legacy Product', 'd1-legacy-product', 'active', 1, 1)`,
    `INSERT INTO "product_variants" ("id","product_id","sku","name","currency","price_amount_cents","status","created_at","updated_at")
     VALUES ('${IDS.variantId}', '${IDS.productId}', 'D1-LEGACY-1', 'Legacy Variant', 'USD', 1000, 'active', 1, 1)`,
    `INSERT INTO "orders" ("id","customer_user_id","status","currency","subtotal_amount_cents","shipping_amount_cents","discount_amount_cents","total_amount_cents","created_at","updated_at")
     VALUES ('${IDS.orderId}', '${IDS.customerUserId}', 'confirmed', 'USD', 1000, 0, 0, 1000, 1, 1)`,
    `INSERT INTO "order_items" ("id","order_id","variant_id","store_id","product_name","variant_name","sku","quantity","unit_amount_cents","line_total_amount_cents","currency","status","created_at","updated_at")
     VALUES ('${IDS.itemId}', '${IDS.orderId}', '${IDS.variantId}', '${IDS.storeId}', 'Legacy Product', 'Legacy Variant', 'D1-LEGACY-1', 1, 1000, 1000, 'USD', 'pending', 1, 1)`,
    `INSERT INTO "order_addresses" ("id","order_id","kind","recipient_name","line1","city","country_code","created_at","updated_at")
     VALUES ('${IDS.addressId}', '${IDS.orderId}', 'shipping', 'Legacy Customer', '1 Legacy Way', 'Legacyville', 'US', 1, 1)`,
  ];
}

/** Split a migration file the way every harness here does, collapsing to one line. */
async function readStatements(file: string): Promise<string[]> {
  const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
  const statements: string[] = [];
  for (const block of sql.split("--> statement-breakpoint")) {
    const statement = block.trim().replace(/\s+/g, " ");
    if (statement !== "") {
      statements.push(statement.endsWith(";") ? statement : `${statement};`);
    }
  }
  return statements;
}

/** Every migration on disk except one, i.e. the set applied before 0008. */
async function readMigrationStatementsExcluding(exclude: string): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => /^\d+_.+\.sql$/.test(file) && file !== exclude)
    .sort();
  const statements: string[] = [];
  for (const file of files) {
    statements.push(...(await readStatements(file)));
  }
  return statements;
}

async function execute(database: D1Binding, statements: string[]): Promise<void> {
  await database.batch(statements.map((statement) => database.prepare(statement)));
}

async function scalar<T>(sql: string): Promise<T> {
  const row = await binding.prepare(sql).first<T>();
  if (row === null) {
    throw new Error(`expected a row from: ${sql}`);
  }
  return Object.values(row)[0] as T;
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default {}",
    d1Databases: { DB: "zelora-migration-test" },
    d1Persist: false,
  });
  binding = await miniflare.getD1Database("DB");

  // Foreign keys are on by default in D1; the assertion below pins that so this
  // suite can never quietly pass under a permissive local configuration.
  expect((await binding.prepare("PRAGMA foreign_keys").all()).results).toEqual([{ foreign_keys: 1 }]);

  // 0000-0007, then a real pre-idempotency order graph...
  await execute(binding, await readMigrationStatementsExcluding(MIGRATION_0008));
  await execute(binding, legacyGraphStatements());
  // ...and only now the pending migration, exactly as `d1 migrations apply` would.
  await execute(binding, await readStatements(MIGRATION_0008));
});

afterAll(async () => {
  await miniflare.dispose();
});

describe("migration 0008 on a real D1 runtime with existing orders", () => {
  it("applies to a populated database without dropping the orders table", async () => {
    // Reaching this point at all is the assertion: the destructive version of
    // this migration aborts here with FOREIGN KEY constraint failed.
    const orders = await binding
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'")
      .first<{ sql: string }>();
    expect(orders?.sql.replace(/\s+/g, " ")).toContain("CREATE TABLE `orders`");
    expect(orders?.sql).toContain("ON DELETE restrict");

    const scaffolding = await binding
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE '__new_%'")
      .all<{ name: string }>();
    expect(scaffolding.results).toEqual([]);
  });

  it("keeps the legacy order, its line and its address, and the FKs valid", async () => {
    const order = await binding
      .prepare("SELECT * FROM orders WHERE id = ?")
      .bind(IDS.orderId)
      .first<Record<string, unknown>>();
    expect(order).toBeDefined();
    expect(order?.status).toBe("confirmed");
    expect(order?.total_amount_cents).toBe(1000);
    expect(order?.currency).toBe("USD");

    expect(await scalar<number>("SELECT COUNT(*) FROM orders")).toBe(1);
    expect(await scalar<number>("SELECT COUNT(*) FROM order_items")).toBe(1);
    expect(await scalar<number>("SELECT COUNT(*) FROM order_addresses")).toBe(1);

    // The line still points at the order it was written for.
    const item = await binding
      .prepare("SELECT order_id, variant_id, store_id, quantity FROM order_items WHERE id = ?")
      .bind(IDS.itemId)
      .first<{ order_id: string; variant_id: string; store_id: string; quantity: number }>();
    expect(item?.order_id).toBe(IDS.orderId);
    expect(item?.variant_id).toBe(IDS.variantId);
    expect(item?.store_id).toBe(IDS.storeId);
    expect(item?.quantity).toBe(1);

    // No dangling reference anywhere.
    expect((await binding.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    // And the child rows still hold `orders` in place.
    await expect(
      binding.prepare("DELETE FROM orders WHERE id = ?").bind(IDS.orderId).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("backfills both idempotency columns on the legacy order", async () => {
    const order = await binding
      .prepare("SELECT idempotency_key, idempotency_fingerprint FROM orders WHERE id = ?")
      .bind(IDS.orderId)
      .first<{ idempotency_key: string; idempotency_fingerprint: string }>();

    expect(order?.idempotency_key).toBe(IDS.orderId);
    expect(order?.idempotency_fingerprint).toBe(BACKFILLED_FINGERPRINT);
    expect(order?.idempotency_fingerprint).toHaveLength(IDEMPOTENCY_FINGERPRINT_HEX_LENGTH);
  });

  it("enforces the unique key, the CHECKs and NOT NULL afterwards", async () => {
    const newOrder = (overrides: Record<string, unknown>): D1Binding["prepare"] =>
      binding
        .prepare(
          `INSERT INTO orders (id, customer_user_id, idempotency_key, idempotency_fingerprint, status, currency,
             subtotal_amount_cents, shipping_amount_cents, discount_amount_cents, total_amount_cents, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 'USD', 0, 0, 0, 0, 5, 5)`,
        )
        .bind(
          overrides.id as string,
          overrides.customer_user_id as string,
          (overrides.idempotency_key ?? null) as string | null,
          (overrides.idempotency_fingerprint ?? null) as string | null,
        );

    // The legacy order's own key, replayed by the same customer.
    await expect(
      newOrder({
        id: "00000000-0000-7000-8000-0000000000b1",
        customer_user_id: IDS.customerUserId,
        idempotency_key: IDS.orderId,
        idempotency_fingerprint: BACKFILLED_FINGERPRINT,
      }).run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    // Too short to be a key.
    await expect(
      newOrder({
        id: "00000000-0000-7000-8000-0000000000b2",
        customer_user_id: IDS.customerUserId,
        idempotency_key: "short",
        idempotency_fingerprint: BACKFILLED_FINGERPRINT,
      }).run(),
    ).rejects.toThrow(/CHECK constraint failed: orders_idempotency_key_length/);

    // A fingerprint that is not a hex digest's width.
    await expect(
      newOrder({
        id: "00000000-0000-7000-8000-0000000000b3",
        customer_user_id: IDS.customerUserId,
        idempotency_key: "valid-key-0001",
        idempotency_fingerprint: "abc",
      }).run(),
    ).rejects.toThrow(/CHECK constraint failed: orders_idempotency_fingerprint_length/);

    // No key at all: the trigger stands in for the NOT NULL a rebuild would have
    // given, since a NULL would otherwise pass the UNIQUE index untouched. The
    // fingerprint is supplied so the key's own trigger is the one that fires.
    await expect(
      newOrder({
        id: "00000000-0000-7000-8000-0000000000b4",
        customer_user_id: IDS.customerUserId,
        idempotency_fingerprint: BACKFILLED_FINGERPRINT,
      }).run(),
    ).rejects.toThrow(/NOT NULL constraint failed: orders\.idempotency_key/);

    // And no fingerprint, with a valid key, to cover the other trigger on its own.
    await expect(
      newOrder({
        id: "00000000-0000-7000-8000-0000000000b5",
        customer_user_id: IDS.customerUserId,
        idempotency_key: "no-fingerprint-key",
      }).run(),
    ).rejects.toThrow(/NOT NULL constraint failed: orders\.idempotency_fingerprint/);

    // Both missing at once is rejected too, whichever trigger SQLite reaches
    // first: the order of BEFORE triggers is not guaranteed, so this asserts the
    // outcome rather than the message.
    await expect(
      newOrder({ id: "00000000-0000-7000-8000-0000000000b7", customer_user_id: IDS.customerUserId }).run(),
    ).rejects.toThrow(/NOT NULL constraint failed: orders\.idempotency_(key|fingerprint)/);

    // Nothing above was written: every rejection rolled its statement back.
    expect(await scalar<number>("SELECT COUNT(*) FROM orders")).toBe(1);

    // Blanking a live order's key afterwards is refused too, while an unrelated
    // update still goes through.
    await expect(
      binding.prepare("UPDATE orders SET idempotency_key = NULL WHERE id = ?").bind(IDS.orderId).run(),
    ).rejects.toThrow(/NOT NULL constraint failed: orders\.idempotency_key/);

    await binding.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").bind(IDS.orderId).run();
    expect(
      await binding.prepare("SELECT status FROM orders WHERE id = ?").bind(IDS.orderId).first<{ status: string }>(),
    ).toEqual({ status: "completed" });
  });

  it("scopes the unique key to the customer", async () => {
    const otherCustomerId = "00000000-0000-7000-8000-000000000004";
    await binding
      .prepare(
        `INSERT INTO users (id, email, name, role, status, password_hash, created_at, updated_at)
         VALUES (?, 'd1-other-customer@example.test', 'Other Customer', 'customer', 'active', 'hash', 1, 1)`,
      )
      .bind(otherCustomerId)
      .run();

    // Same key string as the legacy order, different customer: two independent
    // orders. Uniqueness is per customer so two shoppers' key generators cannot
    // collide into one order.
    await binding
      .prepare(
        `INSERT INTO orders (id, customer_user_id, idempotency_key, idempotency_fingerprint, status, currency,
           subtotal_amount_cents, shipping_amount_cents, discount_amount_cents, total_amount_cents, created_at, updated_at)
         VALUES (?, ?, ?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'pending', 'USD', 0, 0, 0, 0, 5, 5)`,
      )
      .bind("00000000-0000-7000-8000-0000000000b6", otherCustomerId, IDS.orderId)
      .run();

    expect(await scalar<number>("SELECT COUNT(*) FROM orders")).toBe(2);
  });

  it("leaves the customer listing index from 0000 in place", async () => {
    // `PRAGMA index_list` gives no rows an element type, so it is annotated here
    // the way `d1-integration.test.ts` annotates its own PRAGMA reads.
    const indexes = await binding
      .prepare("PRAGMA index_list('orders')")
      .all<{ name: string; unique: number }>();
    const names = indexes.results.map((row: { name: string }) => row.name);
    expect(names).toContain("orders_customer_created_at_idx");
    expect(names).toContain("orders_customer_idempotency_key_unique");
    expect(
      indexes.results.find((row: { name: string }) => row.name === "orders_customer_idempotency_key_unique")?.unique,
    ).toBe(1);
  });
});