import { describe, expect, it } from "vitest";
import { SystemClock, systemClock } from "./clock";

describe("clock", () => {
  it("SystemClock.now returns a valid Date", () => {
    const value = new SystemClock().now();

    expect(value).toBeInstanceOf(Date);
    expect(Number.isNaN(value.getTime())).toBe(false);
  });

  it("does not move backwards between calls", () => {
    const before = systemClock.now();
    const after = systemClock.now();

    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});