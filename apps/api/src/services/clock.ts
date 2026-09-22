/**
 * Minimal clock abstraction so time-dependent logic (session expiry, token
 * rotation, audit timestamps) stays testable without touching the wall clock.
 */

export interface Clock {
  now(): Date;
}

/** Production {@link Clock} backed by the wall clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Shared {@link Clock} instance for production wiring. */
export const systemClock: Clock = new SystemClock();