import { beforeEach, describe, expect, it } from "vitest";
import { RATE_LIMIT_MAX_ENTRIES, MemoryWindowRateLimiter } from "./rate-limit";
import type { Clock } from "./clock";

class FakeClock implements Clock {
  private currentTime: Date;

  constructor(startTime: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.currentTime = startTime;
  }

  now(): Date {
    return new Date(this.currentTime.getTime());
  }

  set(time: Date): void {
    this.currentTime = new Date(time.getTime());
  }

  advance(ms: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + ms);
  }
}

describe("MemoryWindowRateLimiter", () => {
  let clock: FakeClock;
  let limiter: MemoryWindowRateLimiter;

  beforeEach(() => {
    clock = new FakeClock();
    limiter = new MemoryWindowRateLimiter(clock);
  });

  const START = new Date("2026-01-01T00:00:00.000Z").getTime();

  describe("consume", () => {
    it("first request is allowed with the full remaining budget", async () => {
      const outcome = await limiter.consume("k", 5, 60);

      expect(outcome.allowed).toBe(true);
      expect(outcome.remaining).toBe(4);
      expect(outcome.resetAt.getTime()).toBe(START + 60_000);
    });

    it("decrements the remaining count on each allowed request", async () => {
      expect((await limiter.consume("k", 5, 60)).remaining).toBe(4);
      expect((await limiter.consume("k", 5, 60)).remaining).toBe(3);
      expect((await limiter.consume("k", 5, 60)).remaining).toBe(2);
    });

    it("exactly at the limit is still allowed with zero remaining", async () => {
      for (let i = 0; i < 4; i += 1) {
        await limiter.consume("k", 5, 60);
      }
      const outcome = await limiter.consume("k", 5, 60);

      expect(outcome.allowed).toBe(true);
      expect(outcome.remaining).toBe(0);
    });

    it("over the limit is blocked with zero remaining", async () => {
      for (let i = 0; i < 5; i += 1) {
        await limiter.consume("k", 5, 60);
      }
      const outcome = await limiter.consume("k", 5, 60);

      expect(outcome.allowed).toBe(false);
      expect(outcome.remaining).toBe(0);
    });

    it("blocked requests do not keep increasing the count", async () => {
      for (let i = 0; i < 5; i += 1) {
        await limiter.consume("k", 5, 60);
      }
      await limiter.consume("k", 5, 60);
      await limiter.consume("k", 5, 60);

      const blocked = await limiter.consume("k", 5, 60);
      expect(blocked.allowed).toBe(false);

      clock.advance(59_999);
      const justBeforeReset = await limiter.consume("k", 5, 60);
      expect(justBeforeReset.allowed).toBe(false);
    });

    it("keeps the same resetAt across a window", async () => {
      await limiter.consume("k", 5, 60);
      clock.advance(30_000);
      const outcome = await limiter.consume("k", 5, 60);

      expect(outcome.resetAt.getTime()).toBe(START + 60_000);
    });

    it("rolls the window over once the reset time passes", async () => {
      await limiter.consume("k", 2, 60);
      await limiter.consume("k", 2, 60);
      expect((await limiter.consume("k", 2, 60)).allowed).toBe(false);

      clock.advance(60_000);

      const outcome = await limiter.consume("k", 2, 60);
      expect(outcome.allowed).toBe(true);
      expect(outcome.remaining).toBe(1);
      expect(outcome.resetAt.getTime()).toBe(START + 120_000);
    });

    it("keeps separate keys independent", async () => {
      await limiter.consume("a", 2, 60);
      await limiter.consume("a", 2, 60);
      expect((await limiter.consume("a", 2, 60)).allowed).toBe(false);

      const other = await limiter.consume("b", 2, 60);
      expect(other.allowed).toBe(true);
      expect(other.remaining).toBe(1);
    });

    it("allows different limits for the same key to coexist", async () => {
      const first = await limiter.consume("k", 3, 60);
      expect(first.allowed).toBe(true);

      const second = await limiter.consume("k", 1, 60);
      expect(second.allowed).toBe(false);
    });
  });

  describe("reset", () => {
    it("deletes the bucket so the next consume starts fresh", async () => {
      await limiter.consume("k", 1, 60);
      expect((await limiter.consume("k", 1, 60)).allowed).toBe(false);

      await limiter.reset("k");

      const outcome = await limiter.consume("k", 1, 60);
      expect(outcome.allowed).toBe(true);
      expect(outcome.remaining).toBe(0);
    });

    it("only resets the requested key", async () => {
      await limiter.consume("a", 1, 60);
      await limiter.consume("b", 1, 60);
      await limiter.reset("a");

      expect((await limiter.consume("a", 1, 60)).allowed).toBe(true);
      expect((await limiter.consume("b", 1, 60)).allowed).toBe(false);
    });
  });

  describe("sweep", () => {
    it("removes expired buckets", async () => {
      await limiter.consume("a", 5, 60);
      await limiter.consume("b", 5, 60);
      clock.advance(60_000);

      await limiter.sweep();

      const fresh = await limiter.consume("a", 5, 60);
      expect(fresh.allowed).toBe(true);
    });

    it("accepts an explicit cutoff overriding the injected clock", async () => {
      await limiter.consume("a", 5, 60);
      await limiter.sweep(new Date(START + 60_000));

      const fresh = await limiter.consume("a", 5, 60);
      expect(fresh.allowed).toBe(true);
    });

    it("keeps active buckets", async () => {
      await limiter.consume("a", 5, 60);
      clock.advance(30_000);

      await limiter.sweep();

      const outcome = await limiter.consume("a", 5, 60);
      expect(outcome.allowed).toBe(true);
      expect(outcome.remaining).toBe(3);
    });
  });

  describe("clear", () => {
    it("drops every bucket", async () => {
      await limiter.consume("a", 1, 60);
      await limiter.consume("b", 1, 60);
      limiter.clear();

      expect((await limiter.consume("a", 1, 60)).allowed).toBe(true);
      expect((await limiter.consume("b", 1, 60)).allowed).toBe(true);
    });
  });

  describe("capacity", () => {
    it("evicts the soonest-expiring bucket when the cap is exceeded", async () => {
      const otherClock = new FakeClock();
      const sized = new MemoryWindowRateLimiter(otherClock);

      for (let i = 0; i < RATE_LIMIT_MAX_ENTRIES; i += 1) {
        await sized.consume(`key-${i}`, 5, 60);
      }

      await sized.consume("key-early", 5, 60);

      // All pre-existing keys started at the same instant and expire together,
      // so the oldest inserted bucket is evicted: a fresh consume starts a new
      // window (remaining 4) instead of counting against the old one.
      const evicted = await sized.consume("key-0", 5, 60);
      expect(evicted.remaining).toBe(4);

      // A retained active bucket keeps counting (second consume, remaining 3).
      const retained = await sized.consume("key-9999", 5, 60);
      expect(retained.remaining).toBe(3);
    });

    it("keeps working once the map is back under the cap", async () => {
      const otherClock = new FakeClock();
      const sized = new MemoryWindowRateLimiter(otherClock);

      for (let i = 0; i < RATE_LIMIT_MAX_ENTRIES; i += 1) {
        await sized.consume(`key-${i}`, 5, 60);
      }
      otherClock.advance(61_000);
      await sized.sweep();

      const outcome = await sized.consume("fresh", 5, 60);
      expect(outcome.allowed).toBe(true);
    });
  });
});