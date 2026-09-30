import { describe, expect, it } from "vitest";
import {
  ORDER_ADDRESS_KINDS as SHARED_ORDER_ADDRESS_KINDS,
  ORDER_ITEM_STATUSES as SHARED_ORDER_ITEM_STATUSES,
  ORDER_STATUSES as SHARED_ORDER_STATUSES,
  PRODUCT_STATUSES as SHARED_PRODUCT_STATUSES,
  PRODUCT_VARIANT_STATUSES as SHARED_PRODUCT_VARIANT_STATUSES,
  SELLER_PROFILE_STATUSES as SHARED_SELLER_PROFILE_STATUSES,
  STORE_STATUSES as SHARED_STORE_STATUSES,
  USER_ROLES as SHARED_USER_ROLES,
  USER_STATUSES as SHARED_USER_STATUSES,
} from "@zelora/shared";
import {
  ADDRESS_TYPES,
  ORDER_ADDRESS_KINDS,
  ORDER_ITEM_STATUSES,
  ORDER_STATUSES,
  PRODUCT_STATUSES,
  PRODUCT_VARIANT_STATUSES,
  SELLER_PROFILE_STATUSES,
  STORE_STATUSES,
  USER_ROLES,
  USER_STATUSES,
} from "../schema/enums";
import { createTestDatabase } from "./helpers";

/**
 * The status vocabularies are declared twice on purpose: `packages/db` owns
 * them, because the SQL `CHECK` constraints are generated from the Drizzle
 * tuples, and `@zelora/shared` re-declares them so a browser can import the
 * vocabulary without pulling in the database package.
 *
 * That duplication is the whole reason the shared copy exists, and it is
 * completely invisible to the type checker: two independent `as const` tuples
 * of string literals are mutually assignable, so a status added to one side
 * and forgotten on the other type-checks cleanly and then fails at runtime —
 * a `CHECK` that rejects a value the API happily sends. These tests are the
 * assertion the type system cannot make.
 */
const SHARED_VS_DB_VOCABULARIES = {
  USER_ROLES: { shared: SHARED_USER_ROLES, db: USER_ROLES },
  USER_STATUSES: { shared: SHARED_USER_STATUSES, db: USER_STATUSES },
  SELLER_PROFILE_STATUSES: { shared: SHARED_SELLER_PROFILE_STATUSES, db: SELLER_PROFILE_STATUSES },
  STORE_STATUSES: { shared: SHARED_STORE_STATUSES, db: STORE_STATUSES },
  PRODUCT_STATUSES: { shared: SHARED_PRODUCT_STATUSES, db: PRODUCT_STATUSES },
  PRODUCT_VARIANT_STATUSES: {
    shared: SHARED_PRODUCT_VARIANT_STATUSES,
    db: PRODUCT_VARIANT_STATUSES,
  },
  ORDER_STATUSES: { shared: SHARED_ORDER_STATUSES, db: ORDER_STATUSES },
  ORDER_ITEM_STATUSES: { shared: SHARED_ORDER_ITEM_STATUSES, db: ORDER_ITEM_STATUSES },
  ORDER_ADDRESS_KINDS: { shared: SHARED_ORDER_ADDRESS_KINDS, db: ORDER_ADDRESS_KINDS },
} as const;

/**
 * Every column that carries a `CHECK (col IN (...))` in the committed
 * migrations, with the default the database applies when the column is omitted.
 *
 * The default is asserted to be a member of the shared vocabulary as well as
 * the db one: a new row is inserted with this value, and the API and the SPA
 * both render whatever comes back, so a default outside the shared union is a
 * state the client has no way to represent.
 */
const STATUS_COLUMN_DEFAULTS = [
  { column: "users.role", table: "users", name: "role", default: "customer", vocabulary: SHARED_USER_ROLES },
  { column: "users.status", table: "users", name: "status", default: "active", vocabulary: SHARED_USER_STATUSES },
  {
    column: "seller_profiles.status",
    table: "seller_profiles",
    name: "status",
    default: "pending",
    vocabulary: SHARED_SELLER_PROFILE_STATUSES,
  },
  { column: "stores.status", table: "stores", name: "status", default: "draft", vocabulary: SHARED_STORE_STATUSES },
  {
    column: "products.status",
    table: "products",
    name: "status",
    default: "draft",
    vocabulary: SHARED_PRODUCT_STATUSES,
  },
  {
    column: "product_variants.status",
    table: "product_variants",
    name: "status",
    default: "draft",
    vocabulary: SHARED_PRODUCT_VARIANT_STATUSES,
  },
  { column: "orders.status", table: "orders", name: "status", default: "pending", vocabulary: SHARED_ORDER_STATUSES },
  {
    column: "order_items.status",
    table: "order_items",
    name: "status",
    default: "pending",
    vocabulary: SHARED_ORDER_ITEM_STATUSES,
  },
] as const;

describe("shared status vocabularies match the schema enums", () => {
  it.each(Object.entries(SHARED_VS_DB_VOCABULARIES))(
    "%s is the same tuple in @zelora/shared and in packages/db",
    (_name, { shared, db }) => {
      // Order included: both sides drive first-past-the-end iteration and
      // generated `CHECK (... IN (...))` SQL from the same sequence.
      expect([...shared]).toEqual([...db]);
    },
  );

  it("keeps order-address kinds and the legacy address types as one list", () => {
    // ORDER_ADDRESS_KINDS is exported as ADDRESS_TYPES under its schema name, so
    // a divergence here would mean `order_addresses.kind` and the shared
    // contract had quietly stopped describing the same column.
    expect([...ADDRESS_TYPES]).toEqual([...SHARED_ORDER_ADDRESS_KINDS]);
  });
});

describe("the database's status defaults are states the shared contract can express", () => {
  it.each(STATUS_COLUMN_DEFAULTS)(
    "$column defaults to a value in its shared vocabulary",
    ({ default: expected, vocabulary }) => {
      expect(vocabulary).toContain(expected);
    },
  );

  it.each(STATUS_COLUMN_DEFAULTS)(
    "$column really does default to that value in the migrated database",
    ({ table, name, default: expected }) => {
      // Reads the committed migration's own `PRAGMA table_info` rather than the
      // Drizzle object, so this proves the default the database actually runs,
      // on a real database, with the real migrations applied. A default that
      // only exists in the Drizzle schema would satisfy the enum-parity check
      // above while the shipped SQL still applied something else.
      const { sqlite } = createTestDatabase();
      try {
        const rows = sqlite
          .prepare(`PRAGMA table_info(${table})`)
          .all() as unknown as Array<{ name: string; dflt_value: string | null }>;
        const columnRow = rows.find((row) => row.name === name);
        expect(columnRow, `${table}.${name} must exist`).toBeDefined();
        // SQLite reports a string default quoted as 'value'.
        expect(columnRow?.dflt_value).toBe(`'${expected}'`);
      } finally {
        sqlite.close();
      }
    },
  );
});
