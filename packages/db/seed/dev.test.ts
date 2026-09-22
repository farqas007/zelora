import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/schema";
import { createTestDatabase } from "../src/test/helpers";
import { seedDev } from "./dev";

describe("dev seed (development/test data only)", () => {
  it("loads the fictional multi-vendor fixture", () => {
    const { db } = createTestDatabase();
    const summary = seedDev(db);

    expect(summary.users).toBe(3);
    expect(summary.sellerProfiles).toBe(2);
    expect(summary.stores).toBe(2);
    expect(summary.categories).toBe(1);
    expect(summary.products).toBe(2);
    expect(summary.productVariants).toBe(2);
    expect(summary.orders).toBe(1);
    expect(summary.orderItems).toBe(2);
  });

  it("creates an order spanning two stores with totals in integer cents", () => {
    const { db } = createTestDatabase();
    seedDev(db);

    const items = db.select().from(schema.orderItems).all();
    expect(new Set(items.map((item) => item.storeId)).size).toBe(2);

    const order = db.select().from(schema.orders).get();
    expect(order?.subtotalAmountCents).toBe(84_998);
    expect(order?.totalAmountCents).toBe(84_998);

    const sum = items.reduce((total, item) => total + item.lineTotalAmountCents, 0);
    expect(sum).toBe(order?.subtotalAmountCents);
  });

  it("creates exactly one primary image per product", () => {
    const { db } = createTestDatabase();
    seedDev(db);

    const primaries = db
      .select()
      .from(schema.productImages)
      .where(eq(schema.productImages.isPrimary, 1))
      .all();
    expect(primaries).toHaveLength(2);
    expect(new Set(primaries.map((image) => image.productId)).size).toBe(2);
  });

  it("creates one shipping and one billing address snapshot", () => {
    const { db } = createTestDatabase();
    seedDev(db);

    const snapshots = db.select().from(schema.orderAddresses).all();
    expect(snapshots.map((s) => s.kind).sort()).toEqual(["billing", "shipping"]);
  });

  it("never touches password hashes (no plaintext, no fake credentials)", () => {
    const { db } = createTestDatabase();
    seedDev(db);

    const users = db.select().from(schema.users).all();
    expect(users).toHaveLength(3);
    users.forEach((user) => {
      expect(user.passwordHash).toBeNull();
    });
  });

  it("refuses to run against a non-empty database", () => {
    const { db } = createTestDatabase();
    seedDev(db);
    expect(() => seedDev(db)).toThrowError(/database is not empty/);
  });
});