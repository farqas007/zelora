import { describe, expect, it } from "vitest";
import { base64UrlToBytes } from "./base64";
import { getDummyPasswordHash } from "./dummy";
import {
  PBKDF2PasswordHasher,
  PASSWORD_DIGEST_BYTES,
  PASSWORD_HASH_ALGORITHM,
  PASSWORD_SALT_BYTES,
  parsePasswordHash,
} from "./password";

const TEST_ITERATIONS = 1000;

describe("dummy password hash", () => {
  it("parses as a valid PBKDF2 hash at the requested iteration count", async () => {
    const encoded = await getDummyPasswordHash(TEST_ITERATIONS);
    const parsed = parsePasswordHash(encoded);
    expect(parsed).not.toBeNull();
    expect(parsed!.algorithm).toBe(PASSWORD_HASH_ALGORITHM);
    expect(parsed!.iterations).toBe(TEST_ITERATIONS);
    expect(parsed!.salt).toHaveLength(PASSWORD_SALT_BYTES);
    expect(parsed!.digest).toHaveLength(PASSWORD_DIGEST_BYTES);
    expect(encoded).toContain(`$${TEST_ITERATIONS}$`);
  });

  it("is deterministic for the same iteration count", async () => {
    const first = await getDummyPasswordHash(TEST_ITERATIONS);
    const second = await getDummyPasswordHash(TEST_ITERATIONS);
    expect(first).toBe(second);
  });

  it("is precomputed for the production-default 210,000 iterations", async () => {
    const encoded = await getDummyPasswordHash(210_000);
    expect(encoded).toContain("$210000$");
    const parsed = parsePasswordHash(encoded);
    expect(parsed).not.toBeNull();
    expect(parsed!.iterations).toBe(210_000);
  });

  it("derives deterministic dummy hashes for arbitrary iteration counts", async () => {
    const first = await getDummyPasswordHash(1500);
    const second = await getDummyPasswordHash(1500);
    expect(first).toBe(second);
    expect(parsePasswordHash(first)!.iterations).toBe(1500);
  });

  it("runs a real PBKDF2 verification path in verify()", async () => {
    const encoded = await getDummyPasswordHash(TEST_ITERATIONS);
    const hasher = new PBKDF2PasswordHasher(TEST_ITERATIONS);
    const result = await hasher.verify("whatever-attempt", encoded);
    expect(result).toBe(false);
  });

  it("does not accidentally verify any known password", async () => {
    const encoded = await getDummyPasswordHash(TEST_ITERATIONS);
    const hasher = new PBKDF2PasswordHasher(TEST_ITERATIONS);
    const common = ["password", "12345678", "correct horse battery staple", "admin", ""];
    for (const candidate of common) {
      await expect(hasher.verify(candidate, encoded)).resolves.toBe(false);
    }
  });

  it("embeds base64url salt and digest of the expected lengths", async () => {
    const encoded = await getDummyPasswordHash(TEST_ITERATIONS);
    const parts = encoded.split("$");
    const salt = base64UrlToBytes(parts[2]!);
    const digest = base64UrlToBytes(parts[3]!);
    if (salt === null || digest === null) {
      throw new Error("expected valid base64url salt and digest");
    }
    expect(salt).toHaveLength(PASSWORD_SALT_BYTES);
    expect(digest).toHaveLength(PASSWORD_DIGEST_BYTES);
  });

  it("rejects invalid iteration counts", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001]) {
      expect(() => getDummyPasswordHash(bad)).toThrow(RangeError);
    }
  });
});