import type { Clock } from "./clock";

/**
 * Fixed-window in-memory rate limiting for the auth endpoints.
 *
 * The {@link RateLimiter} interface is intentionally runtime-neutral and
 * key-agnostic so a later distributed adapter (e.g. Cloudflare KV / Durable
 * Objects / edge rate limiting) can replace the local {@link MemoryWindowRateLimiter}
 * without changing callers: keys are opaque strings, limits/windows are passed
 * per call, and every outcome carries the window reset time needed for a
 * Retry-After response.
 *
 * This module uses no Node-only APIs so it stays deployable on edge runtimes.
 */

export interface RateLimitOutcome {
  /** Whether the request is allowed to proceed. */
  allowed: boolean;
  /** Number of requests still available in the current window (>= 0). */
  remaining: number;
  /** When the current window resets. */
  resetAt: Date;
}

export interface RateLimiter {
  /**
   * Record one request against `key` and report whether it stays within
   * `limit` requests per `windowSeconds`. Blocked hits never grow the
   * underlying counter.
   */
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitOutcome>;
  /** Delete the bucket for `key` (e.g. after a successful login). */
  reset(key: string): Promise<void>;
  /** Remove expired buckets to bound memory. */
  sweep(now?: Date): Promise<void>;
  /** Drop all buckets. Intended for tests. */
  clear(): void;
}

interface WindowBucket {
  count: number;
  resetAtMs: number;
}

/** Hard upper bound on tracked keys so the limiter cannot grow forever. */
export const RATE_LIMIT_MAX_ENTRIES = 10_000;

/**
 * Fixed-window counter backed by a plain map. Expired entries self-reset on
 * their next consume, and a lazy sweep plus a hard entry cap keep memory
 * bounded without any background timer.
 */
export class MemoryWindowRateLimiter implements RateLimiter {
  private readonly clock: Clock;
  private readonly buckets: Map<string, WindowBucket> = new Map();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitOutcome> {
    const nowMs = this.clock.now().getTime();
    const windowMs = windowSeconds * 1000;

    const existing = this.buckets.get(key);
    if (existing !== undefined && nowMs < existing.resetAtMs) {
      if (existing.count < limit) {
        existing.count += 1;
        return {
          allowed: true,
          remaining: Math.max(0, limit - existing.count),
          resetAt: new Date(existing.resetAtMs),
        };
      }
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(existing.resetAtMs),
      };
    }

    this.ensureCapacity(nowMs);
    const resetAtMs = nowMs + windowMs;
    this.buckets.set(key, { count: 1, resetAtMs });
    return {
      allowed: limit >= 1,
      remaining: Math.max(0, limit - 1),
      resetAt: new Date(resetAtMs),
    };
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  async sweep(now: Date = this.clock.now()): Promise<void> {
    const nowMs = now.getTime();
    for (const [key, bucket] of this.buckets) {
      if (nowMs >= bucket.resetAtMs) {
        this.buckets.delete(key);
      }
    }
  }

  clear(): void {
    this.buckets.clear();
  }

  /**
   * Bound the map size: first drop expired entries, then, if the cap is still
   * exceeded (pathological single-window growth), evict the soonest-expiring
   * buckets until the map fits under {@link RATE_LIMIT_MAX_ENTRIES}.
   */
  private ensureCapacity(nowMs: number): void {
    if (this.buckets.size < RATE_LIMIT_MAX_ENTRIES) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (nowMs >= bucket.resetAtMs) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size < RATE_LIMIT_MAX_ENTRIES) {
      return;
    }
    const byExpiry = Array.from(this.buckets.entries()).sort(
      (a, b) => a[1].resetAtMs - b[1].resetAtMs,
    );
    for (const [key] of byExpiry) {
      if (this.buckets.size < RATE_LIMIT_MAX_ENTRIES) {
        break;
      }
      this.buckets.delete(key);
    }
  }
}