import { describe, expect, it } from "vitest";
import { mapCreateOrderConflict } from "../orders/conflicts";

/**
 * Unit tests for the driver-neutral order conflict mapping.
 *
 * True D1 runtime behaviour (batch atomicity + the inventory CHECK guard)
 * lives in the Miniflare integration suite; this suite exercises the pure
 * translation contract against the error shapes both real D1
 * (`D1_ERROR: ...: SQLITE_CONSTRAINT_CHECK`) and Drizzle's driver forwarding
 * can produce. The same mapper drives the local now-sqlite stack.
 */

describe("order conflict mapping", () => {
  it("maps the inventory CHECK undershoot to INSUFFICIENT_STOCK", () => {
    expect(
      mapCreateOrderConflict(
        new Error("D1_ERROR: CHECK constraint failed: inventory_quantity_non_negative: SQLITE_CONSTRAINT_CHECK"),
      ),
    ).toBe("INSUFFICIENT_STOCK");
    expect(
      mapCreateOrderConflict(new Error("CHECK constraint failed: inventory_quantity_non_negative")),
    ).toBe("INSUFFICIENT_STOCK");
  });

  it("also matches the anonymous-equivalent table-based CHECK message", () => {
    // Some SQLite builds/D1 responses report the CHECK by the affected table.
    expect(mapCreateOrderConflict(new Error("CHECK constraint failed: inventory"))).toBe("INSUFFICIENT_STOCK");
  });

  it("maps a foreign-key failure to VARIANT_NOT_FOUND", () => {
    expect(mapCreateOrderConflict(new Error("D1_ERROR: FOREIGN KEY constraint failed"))).toBe("VARIANT_NOT_FOUND");
    expect(mapCreateOrderConflict(new Error("FOREIGN KEY constraint failed"))).toBe("VARIANT_NOT_FOUND");
  });

  it("walks a wrapped cause chain to reach the underlying driver error", () => {
    const inner = new Error("D1_ERROR: CHECK constraint failed: inventory_quantity_non_negative: SQLITE_CONSTRAINT_CHECK");
    const outer = new Error("drizzle query failed");
    (outer as { cause?: unknown }).cause = inner;
    expect(mapCreateOrderConflict(outer)).toBe("INSUFFICIENT_STOCK");
  });

  it("handles error objects that are not Error instances (cross-realm objects)", () => {
    const fakeError = { message: "D1_ERROR: CHECK constraint failed: inventory_quantity_non_negative" };
    expect(mapCreateOrderConflict(fakeError)).toBe("INSUFFICIENT_STOCK");
  });

  it("returns null for unrelated failures so they propagate unchanged", () => {
    expect(mapCreateOrderConflict(new Error("UNIQUE constraint failed: orders.id"))).toBeNull();
    expect(mapCreateOrderConflict(new Error("D1_ERROR: no such table: orders"))).toBeNull();
    expect(mapCreateOrderConflict(new Error("network error"))).toBeNull();
    // A CHECK in a different table is not a stock signal.
    expect(mapCreateOrderConflict(new Error("CHECK constraint failed: order_items_quantity_positive"))).toBeNull();
  });

  it("returns null for non-error inputs", () => {
    expect(mapCreateOrderConflict(undefined)).toBeNull();
    expect(mapCreateOrderConflict(null)).toBeNull();
    expect(mapCreateOrderConflict(42)).toBeNull();
    expect(mapCreateOrderConflict("")).toBeNull();
  });
});