import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "./base64";

describe("base64url without padding", () => {
  it("round-trips byte arrays of varying lengths", () => {
    const lengths = [0, 1, 2, 3, 4, 5, 16, 32, 33];
    for (const length of lengths) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = (i * 7 + 3) % 256;
      }
      const encoded = bytesToBase64Url(bytes);
      const decoded = base64UrlToBytes(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded).toEqual(bytes);
      expect(encoded).not.toContain("=");
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });

  it("matches known base64url encodings", () => {
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(bytesToBase64Url(new Uint8Array([0x00]))).toBe("AA");
    expect(bytesToBase64Url(new Uint8Array([0xff, 0xff, 0xff]))).toBe("____");
    expect(bytesToBase64Url(new Uint8Array(32))).toHaveLength(43);
  });

  it("encodes an empty array to an empty string and back", () => {
    expect(bytesToBase64Url(new Uint8Array())).toBe("");
    expect(base64UrlToBytes("")).toEqual(new Uint8Array());
  });

  it.each([
    ["non-base64 characters", "!!invalid!!"],
    ["with padding characters", "abc="],
    ["verbose padding", "aaaa=="],
    ["length mod four equals one", "a"],
    ["space inside", "a b"],
    ["uppercase plus-sign alphabet", "ab+cd"],
    ["slash alphabet", "ab/cd"],
    ["non-canonical trailing bits in two-char block", "AB"],
    ["non-canonical trailing bits in three-char block", "ABC"],
    ["high unicode characters", "éàç"],
  ])("rejects %s", (_name, input) => {
    expect(base64UrlToBytes(input)).toBeNull();
  });
});