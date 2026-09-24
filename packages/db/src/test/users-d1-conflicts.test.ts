import { describe, expect, it } from "vitest";
import { mapD1UserCreateConflict } from "../users/d1-repository";

/**
 * Unit tests for the D1/Drizzle UNIQUE-conflict → driver-neutral reason
 * mapping used by the D1 user repository's `createAdmin`.
 *
 * True D1 runtime tests require `workerd`/`miniflare`, which are not part of
 * this repository's dependencies, so this suite does NOT fake a D1 driver.
 * Instead it exercises the pure conflict-translation contract against the
 * error shapes both real D1 (`D1_ERROR: ...: SQLITE_CONSTRAINT_UNIQUE`) and
 * Drizzle's driver forwarding can produce.
 */

describe("D1 user createAdmin conflict mapping", () => {
  it("maps each D1 UNIQUE constraint message to its driver-neutral reason", () => {
    expect(
      mapD1UserCreateConflict(
        new Error("D1_ERROR: UNIQUE constraint failed: users.role: SQLITE_CONSTRAINT_UNIQUE"),
      ),
    ).toBe("ADMIN_ALREADY_EXISTS");
    expect(
      mapD1UserCreateConflict(
        new Error("D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT_UNIQUE"),
      ),
    ).toBe("EMAIL_IN_USE");
  });

  it("is tolerant of the bare SQLite message without the D1 prefix or trailing code", () => {
    expect(
      mapD1UserCreateConflict(new Error("UNIQUE constraint failed: users.role")),
    ).toBe("ADMIN_ALREADY_EXISTS");
    expect(
      mapD1UserCreateConflict(new Error("UNIQUE constraint failed: users.email")),
    ).toBe("EMAIL_IN_USE");
  });

  it("handles error objects that are not Error instances (cross-realm objects)", () => {
    const fakeError = { message: "D1_ERROR: UNIQUE constraint failed: users.role: SQLITE_CONSTRAINT_UNIQUE" };
    expect(mapD1UserCreateConflict(fakeError)).toBe("ADMIN_ALREADY_EXISTS");
  });

  it("walks a wrapped cause chain to reach the underlying driver error", () => {
    const inner = new Error("D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT_UNIQUE");
    const outer = new Error("drizzle transaction failed");
    (outer as { cause?: unknown }).cause = inner;
    expect(mapD1UserCreateConflict(outer)).toBe("EMAIL_IN_USE");
  });

  it("returns null for unrelated failures so they propagate unchanged", () => {
    expect(mapD1UserCreateConflict(new Error("D1_ERROR: FOREIGN KEY constraint failed"))).toBeNull();
    expect(mapD1UserCreateConflict(new Error("D1_ERROR: no such table: users"))).toBeNull();
    expect(mapD1UserCreateConflict(new Error("UNIQUE constraint failed: other_table.role"))).toBeNull();
    expect(mapD1UserCreateConflict(new Error("network error"))).toBeNull();
  });

  it("returns null for non-error inputs", () => {
    expect(mapD1UserCreateConflict(undefined)).toBeNull();
    expect(mapD1UserCreateConflict(null)).toBeNull();
    expect(mapD1UserCreateConflict(42)).toBeNull();
    expect(mapD1UserCreateConflict("")).toBeNull();
  });
});