import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "./base64";
import {
  PBKDF2PasswordHasher,
  PASSWORD_DIGEST_BYTES,
  PASSWORD_HASH_ALGORITHM,
  PASSWORD_SALT_BYTES,
  derivePasswordDigest,
  encodePasswordHash,
  parsePasswordHash,
} from "./password";

const TEST_ITERATIONS = 1000;
const TEST_PASSWORD = "correct horse battery staple";

const BASE64URL_CHARSET = /^[A-Za-z0-9_-]+$/;

function split(hash: string): [string, string, string, string] {
  const parts = hash.split("$");
  if (parts.length !== 4) {
    throw new Error(`expected a 4-part hash, got ${parts.length}`);
  }
  return parts as [string, string, string, string];
}

function withPart(hash: string, index: number, replacement: string): string {
  const parts = hash.split("$");
  parts[index] = replacement;
  return parts.join("$");
}

describe("derivePasswordDigest", () => {
  it("matches the RFC 7914 PBKDF2-HMAC-SHA256 test vector", async () => {
    // P="password", S="salt", c=1, dkLen=32.
    const digest = await derivePasswordDigest("password", 1, new TextEncoder().encode("salt"));
    const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
  });
});

describe("PBKDF2PasswordHasher", () => {
  const hasher = new PBKDF2PasswordHasher(TEST_ITERATIONS);

  it("returns the expected 4-part self-describing format", async () => {
    const hash = await hasher.hash(TEST_PASSWORD);
    const [algorithm, iterations, salt, digest] = split(hash);

    expect(algorithm).toBe(PASSWORD_HASH_ALGORITHM);
    expect(iterations).toMatch(/^[1-9][0-9]*$/);
    expect(Number(iterations)).toBe(TEST_ITERATIONS);

    const saltBytes = base64UrlToBytes(salt);
    const digestBytes = base64UrlToBytes(digest);
    if (saltBytes === null || digestBytes === null) {
      throw new Error("expected base64url salt and digest");
    }
    expect(salt).toMatch(BASE64URL_CHARSET);
    expect(digest).toMatch(BASE64URL_CHARSET);
    expect(saltBytes).toHaveLength(PASSWORD_SALT_BYTES);
    expect(digestBytes).toHaveLength(PASSWORD_DIGEST_BYTES);
  });

  it("encodes the configured iteration count into the stored hash", async () => {
    const hash = await hasher.hash(TEST_PASSWORD);
    expect(hash).toContain(`$${TEST_ITERATIONS}$`);
    const parsed = parsePasswordHash(hash);
    expect(parsed).not.toBeNull();
    expect(parsed!.iterations).toBe(TEST_ITERATIONS);
    expect(parsed!.algorithm).toBe(PASSWORD_HASH_ALGORITHM);
  });

  it("uses a fresh random salt per hash, so equal passwords differ", async () => {
    const first = await hasher.hash(TEST_PASSWORD);
    const second = await hasher.hash(TEST_PASSWORD);

    expect(first).not.toBe(second);
    expect(split(first)[2]).not.toBe(split(second)[2]);
    expect(new Set([first, second]).size).toBe(2);
  });

  it("verifies the correct password", async () => {
    const hash = await hasher.hash(TEST_PASSWORD);
    await expect(hasher.verify(TEST_PASSWORD, hash)).resolves.toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hasher.hash(TEST_PASSWORD);
    await expect(hasher.verify("not-the-password", hash)).resolves.toBe(false);
  });

  it("verifies using the iteration count embedded in the stored hash, not its own", async () => {
    const hash = await new PBKDF2PasswordHasher(2500).hash(TEST_PASSWORD);
    await expect(new PBKDF2PasswordHasher(TEST_ITERATIONS).verify(TEST_PASSWORD, hash)).resolves.toBe(true);
  });

  it("rejects a constructor iteration count that is not a positive integer", () => {
    expect(() => new PBKDF2PasswordHasher(0)).toThrow(RangeError);
    expect(() => new PBKDF2PasswordHasher(-1)).toThrow(RangeError);
    expect(() => new PBKDF2PasswordHasher(1.5)).toThrow(RangeError);
    expect(() => new PBKDF2PasswordHasher(10_000_001)).toThrow(RangeError);
  });
});

describe("verify rejects malformed stored hashes instead of throwing", () => {
  const hasher = new PBKDF2PasswordHasher(TEST_ITERATIONS);

  async function expectRejected(hash: string): Promise<void> {
    await expect(hasher.verify(TEST_PASSWORD, hash)).resolves.toBe(false);
  }

  async function loginHash(): Promise<string> {
    return hasher.hash(TEST_PASSWORD);
  }

  it("handles empty and structurally broken strings", async () => {
    const hash = await loginHash();
    for (const broken of ["", "not-a-hash", "pbkdf2-sha256", "pbkdf2-sha256$1000", "$1000$$", hash.slice(0, -1)]) {
      await expectRejected(broken);
      expect(parsePasswordHash(broken)).toBeNull();
    }
  });

  it("rejects a wrong algorithm identifier", async () => {
    const hash = await loginHash();
    for (const algorithm of ["pbkdf2-sha512", "bcrypt", "PBKDF2-SHA256", "argon2id"]) {
      await expectRejected(withPart(hash, 0, algorithm));
      expect(parsePasswordHash(withPart(hash, 0, algorithm))).toBeNull();
    }
  });

  it("rejects invalid iteration counts", async () => {
    const hash = await loginHash();
    for (const iterations of ["0", "-100", "1.5", "abc", "+1000", "01000", "0x10", "10000001"]) {
      await expectRejected(withPart(hash, 1, iterations));
      expect(parsePasswordHash(withPart(hash, 1, iterations))).toBeNull();
    }
  });

  it("rejects iteration counts that exceed the safe integer range", async () => {
    const hash = await loginHash();
    const oversized = "99999999999999999999";
    await expectRejected(withPart(hash, 1, oversized));
    expect(parsePasswordHash(withPart(hash, 1, oversized))).toBeNull();
  });

  it("rejects invalid base64url salts and digests", async () => {
    const hash = await loginHash();
    for (const field of [2, 3]) {
      for (const invalid of ["!!invalid!!", "a", "abc=", "AAAA===", "a b c"]) {
        await expectRejected(withPart(hash, field, invalid));
        expect(parsePasswordHash(withPart(hash, field, invalid))).toBeNull();
      }
    }
  });

  it("rejects salts that are not exactly 16 bytes", async () => {
    const hash = await loginHash();
    for (const wrongLength of [15, 17]) {
      const salt = bytesToBase64Url(new Uint8Array(wrongLength));
      await expectRejected(withPart(hash, 2, salt));
      expect(parsePasswordHash(withPart(hash, 2, salt))).toBeNull();
    }
  });

  it("rejects digests that are not exactly 32 bytes", async () => {
    const hash = await loginHash();
    for (const wrongLength of [31, 33]) {
      const digest = bytesToBase64Url(new Uint8Array(wrongLength));
      await expectRejected(withPart(hash, 3, digest));
      expect(parsePasswordHash(withPart(hash, 3, digest))).toBeNull();
    }
  });

  it("rejects extra components", async () => {
    const hash = await loginHash();
    await expectRejected(`${hash}$extra`);
    await expectRejected(`${hash}$`);
    expect(parsePasswordHash(`${hash}$extra`)).toBeNull();
  });
});

describe("parsePasswordHash and encodePasswordHash", () => {
  it("round-trips through encodePasswordHash", async () => {
    const hash = await new PBKDF2PasswordHasher(TEST_ITERATIONS).hash(TEST_PASSWORD);
    const parsed = parsePasswordHash(hash);
    if (parsed === null) {
      throw new Error("expected a valid hash");
    }
    expect(encodePasswordHash(parsed.iterations, parsed.salt, parsed.digest)).toBe(hash);
  });
});
  it("maintains self-describing hash format and uses encoded iterations for verification", async () => {
    const highIterHasher = new PBKDF2PasswordHasher(5000);
    const hash = await highIterHasher.hash(TEST_PASSWORD);
    const parts = hash.split("$");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe(PASSWORD_HASH_ALGORITHM);
    expect(parts[1]).toBe("5000");
    const lowIterHasher = new PBKDF2PasswordHasher(1000);
    await expect(lowIterHasher.verify(TEST_PASSWORD, hash)).resolves.toBe(true);
    await expect(highIterHasher.verify(TEST_PASSWORD, hash)).resolves.toBe(true);
  });
