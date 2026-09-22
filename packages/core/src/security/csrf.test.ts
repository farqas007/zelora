import { describe, expect, it } from "vitest";
import { base64UrlToBytes } from "./base64";
import { CSRF_TOKEN_BYTES, generateCsrfToken } from "./csrf";

const BASE64URL_CHARSET = /^[A-Za-z0-9_-]+$/;

describe("generateCsrfToken", () => {
  it("returns a non-empty token", () => {
    expect(generateCsrfToken().length).toBeGreaterThan(0);
  });

  it("returns different tokens on each call", () => {
    expect(generateCsrfToken()).not.toBe(generateCsrfToken());
  });

  it("encodes exactly 32 random bytes as unpadded base64url", () => {
    const token = generateCsrfToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(BASE64URL_CHARSET.test(token)).toBe(true);
    expect(base64UrlToBytes(token)).toHaveLength(CSRF_TOKEN_BYTES);
    expect(token).not.toContain("=");
  });
});