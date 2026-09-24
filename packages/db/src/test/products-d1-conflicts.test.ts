import { describe, expect, it } from "vitest";
import { mapD1ProductCreateConflict } from "../products/d1-repository";

/**
 * Unit tests for the D1/Drizzle UNIQUE-conflict → driver-neutral reason
 * mapping used by the D1 product repository.
 *
 * True D1 runtime tests require `workerd`/`miniflare`, which are not part of
 * this repository's dependencies, so this suite does NOT fake a D1 driver.
 * Instead it exercises the pure conflict-translation contract against the
 * error shapes both real D1 (`D1_ERROR: ...: SQLITE_CONSTRAINT_UNIQUE`) and
 * Drizzle's driver forwarding can produce.
 */

describe("D1 product create conflict mapping", () => {
  it("maps a products (store_id, slug) UNIQUE constraint message to PRODUCT_SLUG_IN_USE", () => {
    expect(
      mapD1ProductCreateConflict(
        new Error("D1_ERROR: UNIQUE constraint failed: products.store_id, products.slug: SQLITE_CONSTRAINT_UNIQUE"),
      ),
    ).toBe("PRODUCT_SLUG_IN_USE");
  });

  it("is tolerant of the bare SQLite message without the D1 prefix or trailing code", () => {
    expect(
      mapD1ProductCreateConflict(new Error("UNIQUE constraint failed: products.store_id, products.slug")),
    ).toBe("PRODUCT_SLUG_IN_USE");
  });

  it("handles error objects that are not Error instances (cross-realm objects)", () => {
    const fakeError = {
      message: "D1_ERROR: UNIQUE constraint failed: products.store_id, products.slug: SQLITE_CONSTRAINT_UNIQUE",
    };
    expect(mapD1ProductCreateConflict(fakeError)).toBe("PRODUCT_SLUG_IN_USE");
  });

  it("walks a wrapped cause chain to reach the underlying driver error", () => {
    const inner = new Error("D1_ERROR: UNIQUE constraint failed: products.store_id, products.slug: SQLITE_CONSTRAINT_UNIQUE");
    const outer = new Error("drizzle transaction failed");
    (outer as { cause?: unknown }).cause = inner;
    expect(mapD1ProductCreateConflict(outer)).toBe("PRODUCT_SLUG_IN_USE");
  });

  it("returns null for unrelated failures so they propagate unchanged", () => {
    expect(mapD1ProductCreateConflict(new Error("D1_ERROR: FOREIGN KEY constraint failed"))).toBeNull();
    expect(mapD1ProductCreateConflict(new Error("D1_ERROR: no such table: products"))).toBeNull();
    expect(mapD1ProductCreateConflict(new Error("UNIQUE constraint failed: stores.slug"))).toBeNull();
    expect(mapD1ProductCreateConflict(new Error("UNIQUE constraint failed: products.slug"))).toBeNull();
    expect(mapD1ProductCreateConflict(new Error("network error"))).toBeNull();
  });

  it("returns null for non-error inputs", () => {
    expect(mapD1ProductCreateConflict(undefined)).toBeNull();
    expect(mapD1ProductCreateConflict(null)).toBeNull();
    expect(mapD1ProductCreateConflict(42)).toBeNull();
    expect(mapD1ProductCreateConflict("")).toBeNull();
  });
});