import { describe, expect, it } from "vitest";
import { mapD1CartConflict } from "../cart/d1-repository";

/**
 * Unit tests for the D1/Drizzle UNIQUE-conflict → driver-neutral reason
 * mapping used by the D1 cart repository.
 *
 * True D1 runtime tests live in the Miniflare integration suite; this suite
 * exercises the pure conflict-translation contract against the error shapes
 * both real D1 (`D1_ERROR: ...: SQLITE_CONSTRAINT_UNIQUE`) and Drizzle's
 * driver forwarding can produce.
 */

describe("D1 cart conflict mapping", () => {
  it("maps the one-cart-per-user constraint to CART_EXISTS", () => {
    expect(
      mapD1CartConflict(
        new Error("D1_ERROR: UNIQUE constraint failed: carts.user_id: SQLITE_CONSTRAINT_UNIQUE"),
        "USER",
      ),
    ).toBe("USER");
  });

  it("maps either column of the (cart_id, variant_id) constraint to CART_ITEM_EXISTS", () => {
    expect(
      mapD1CartConflict(
        new Error("D1_ERROR: UNIQUE constraint failed: cart_items.cart_id, cart_items.variant_id: SQLITE_CONSTRAINT_UNIQUE"),
        "ITEM",
      ),
    ).toBe("ITEM");
    expect(
      mapD1CartConflict(
        new Error("UNIQUE constraint failed: cart_items.variant_id"),
        "ITEM",
      ),
    ).toBe("ITEM");
  });

  it("is tolerant of the bare SQLite message without the D1 prefix or trailing code", () => {
    expect(mapD1CartConflict(new Error("UNIQUE constraint failed: carts.user_id"), "USER")).toBe("USER");
    expect(mapD1CartConflict(new Error("UNIQUE constraint failed: cart_items.cart_id"), "ITEM")).toBe("ITEM");
  });

  it("handles error objects that are not Error instances (cross-realm objects)", () => {
    const fakeError = { message: "D1_ERROR: UNIQUE constraint failed: cart_items.cart_id: SQLITE_CONSTRAINT_UNIQUE" };
    expect(mapD1CartConflict(fakeError, "ITEM")).toBe("ITEM");
  });

  it("walks a wrapped cause chain to reach the underlying driver error", () => {
    const inner = new Error("D1_ERROR: UNIQUE constraint failed: carts.user_id: SQLITE_CONSTRAINT_UNIQUE");
    const outer = new Error("drizzle query failed");
    (outer as { cause?: unknown }).cause = inner;
    expect(mapD1CartConflict(outer, "USER")).toBe("USER");
  });

  it("returns null when the expected kind does not match (a mismatch is never conflated)", () => {
    expect(mapD1CartConflict(new Error("UNIQUE constraint failed: carts.user_id"), "ITEM")).toBeNull();
  });

  it("returns null for unrelated failures so they propagate unchanged", () => {
    expect(mapD1CartConflict(new Error("D1_ERROR: FOREIGN KEY constraint failed"), "ITEM")).toBeNull();
    expect(mapD1CartConflict(new Error("D1_ERROR: no such table: carts"), "USER")).toBeNull();
    expect(mapD1CartConflict(new Error("UNIQUE constraint failed: orders.id"), "ITEM")).toBeNull();
    expect(mapD1CartConflict(new Error("network error"), "USER")).toBeNull();
  });

  it("returns null for non-error inputs", () => {
    expect(mapD1CartConflict(undefined, "USER")).toBeNull();
    expect(mapD1CartConflict(null, "ITEM")).toBeNull();
    expect(mapD1CartConflict(42, "USER")).toBeNull();
    expect(mapD1CartConflict("", "ITEM")).toBeNull();
  });
});