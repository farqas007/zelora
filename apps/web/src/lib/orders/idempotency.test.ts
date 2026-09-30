import { describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_LIMITS, IDEMPOTENCY_KEY_PATTERN } from "@zelora/shared";
import { createIdempotencyKey } from "./idempotency";

/**
 * The key generator has to satisfy the shared contract without knowing it:
 * a key the client mints must never be one the server rejects, because a
 * rejected key turns a retryable checkout into a hard failure.
 */

describe("createIdempotencyKey", () => {
  it("produces a key the server's own validation accepts", () => {
    const key = createIdempotencyKey();
    expect(key.length).toBeGreaterThanOrEqual(IDEMPOTENCY_KEY_LIMITS.minLength);
    expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_LIMITS.maxLength);
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it("produces a different key each time", () => {
    // Two attempts at two different checkouts must not collide: a shared key
    // would make the second one look like a retry of the first.
    const keys = new Set(Array.from({ length: 500 }, () => createIdempotencyKey()));
    expect(keys.size).toBe(500);
  });

  it("does not leak anything but randomness into the key", () => {
    // A key built from a timestamp, a counter or an order id would let one
    // shopper guess another's key, and the key is a bearer token for the order
    // it names.
    const random = vi.spyOn(crypto, "randomUUID");
    const key = createIdempotencyKey();
    expect(random).toHaveBeenCalledTimes(1);
    expect(key).toBe(random.mock.results[0]?.value);
  });
});