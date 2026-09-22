import { describe, expect, it } from "vitest";
import { mapD1SellerOnboardingConflict } from "../seller/d1-repository";

/**
 * Unit tests for the D1/Drizzle UNIQUE-conflict → driver-neutral reason
 * mapping used by the D1 seller repository.
 *
 * True D1 runtime tests require `workerd`/`miniflare`, which are not part of
 * this repository's dependencies, so this suite does NOT fake a D1 driver.
 * Instead it exercises the pure conflict-translation contract against the
 * error shapes both real D1 (`D1_ERROR: ...: SQLITE_CONSTRAINT_UNIQUE`) and
 * Drizzle's driver forwarding can produce.
 */

describe("D1 seller onboarding conflict mapping", () => {
  it("maps each D1 UNIQUE constraint message to its driver-neutral reason", () => {
    expect(
      mapD1SellerOnboardingConflict(
        new Error("D1_ERROR: UNIQUE constraint failed: seller_profiles.user_id: SQLITE_CONSTRAINT_UNIQUE"),
      ),
    ).toBe("SELLER_PROFILE_EXISTS");
    expect(
      mapD1SellerOnboardingConflict(
        new Error("D1_ERROR: UNIQUE constraint failed: seller_profiles.slug: SQLITE_CONSTRAINT_UNIQUE"),
      ),
    ).toBe("PROFILE_SLUG_IN_USE");
    expect(
      mapD1SellerOnboardingConflict(
        new Error("D1_ERROR: UNIQUE constraint failed: stores.slug: SQLITE_CONSTRAINT_UNIQUE"),
      ),
    ).toBe("STORE_SLUG_IN_USE");
  });

  it("is tolerant of the bare SQLite message without the D1 prefix or trailing code", () => {
    expect(
      mapD1SellerOnboardingConflict(new Error("UNIQUE constraint failed: seller_profiles.slug")),
    ).toBe("PROFILE_SLUG_IN_USE");
    expect(
      mapD1SellerOnboardingConflict(new Error("UNIQUE constraint failed: stores.slug")),
    ).toBe("STORE_SLUG_IN_USE");
  });

  it("handles error objects that are not Error instances (cross-realm objects)", () => {
    const fakeError = { message: "D1_ERROR: UNIQUE constraint failed: seller_profiles.user_id: SQLITE_CONSTRAINT_UNIQUE" };
    expect(mapD1SellerOnboardingConflict(fakeError)).toBe("SELLER_PROFILE_EXISTS");
  });

  it("walks a wrapped cause chain to reach the underlying driver error", () => {
    const inner = new Error("D1_ERROR: UNIQUE constraint failed: stores.slug: SQLITE_CONSTRAINT_UNIQUE");
    const outer = new Error("drizzle transaction failed");
    (outer as { cause?: unknown }).cause = inner;
    expect(mapD1SellerOnboardingConflict(outer)).toBe("STORE_SLUG_IN_USE");
  });

  it("returns null for unrelated failures so they propagate unchanged", () => {
    expect(mapD1SellerOnboardingConflict(new Error("D1_ERROR: FOREIGN KEY constraint failed"))).toBeNull();
    expect(mapD1SellerOnboardingConflict(new Error("D1_ERROR: no such table: seller_profiles"))).toBeNull();
    expect(mapD1SellerOnboardingConflict(new Error("UNIQUE constraint failed: other_table.slug"))).toBeNull();
    expect(mapD1SellerOnboardingConflict(new Error("network error"))).toBeNull();
  });

  it("returns null for non-error inputs", () => {
    expect(mapD1SellerOnboardingConflict(undefined)).toBeNull();
    expect(mapD1SellerOnboardingConflict(null)).toBeNull();
    expect(mapD1SellerOnboardingConflict(42)).toBeNull();
    expect(mapD1SellerOnboardingConflict("")).toBeNull();
  });
});