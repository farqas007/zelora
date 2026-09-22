import { describe, expect, it } from "vitest";
import { base64UrlToBytes } from "./base64";
import { SESSION_TOKEN_BYTES, generateSessionToken, hashSessionToken } from "./session-token";

const BASE64URL_CHARSET = /^[A-Za-z0-9_-]+$/;

describe("generateSessionToken", () => {
  it("returns a non-empty token", () => {
    expect(generateSessionToken().length).toBeGreaterThan(0);
  });

  it("returns different tokens on each call", () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });

  it("encodes exactly 32 random bytes as unpadded base64url", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(BASE64URL_CHARSET.test(token)).toBe(true);
    expect(base64UrlToBytes(token)).toHaveLength(SESSION_TOKEN_BYTES);
    expect(token).not.toContain("=");
  });
});

describe("hashSessionToken", () => {
  it("hashes the same raw token deterministically", async () => {
    const token = generateSessionToken();
    const first = await hashSessionToken(token);
    const second = await hashSessionToken(token);
    expect(first).toBe(second);
  });

  it("produces different hashes for different tokens", async () => {
    const first = await hashSessionToken(generateSessionToken());
    const second = await hashSessionToken(generateSessionToken());
    expect(first).not.toBe(second);
  });

  it("returns a base64url SHA-256 digest of the 32-byte token", async () => {
    const hash = await hashSessionToken(generateSessionToken());
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64UrlToBytes(hash)).toHaveLength(32);
  });

  it("throws for inputs that are not valid base64url", async () => {
    for (const invalid of ["not,a,token!", "abc=", "AAAA===", "a b c", "token with space"]) {
      await expect(hashSessionToken(invalid)).rejects.toThrow();
    }
  });
});