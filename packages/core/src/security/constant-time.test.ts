import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "./constant-time";

describe("constantTimeEqual", () => {
  it("returns true for equal arrays", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  it("returns false for different arrays", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 6]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("returns false for different arrays of the same length with a single flipped bit", () => {
    const a = new Uint8Array(32);
    const b = new Uint8Array(32);
    b[31] = 1;
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("returns false for unequal lengths", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(16), new Uint8Array(32))).toBe(false);
  });

  it("handles empty arrays correctly", () => {
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array([1]))).toBe(false);
  });
});