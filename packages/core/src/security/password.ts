import { base64UrlToBytes, bytesToBase64Url } from "./base64";
import { constantTimeEqual } from "./constant-time";
import { getRandomBytes } from "./random";

/**
 * PBKDF2-HMAC-SHA256 password hashing built exclusively on Web Crypto, so it
 * runs unchanged in Node, browsers and Cloudflare Workers.
 *
 * Hashes are self-describing and stored as:
 *
 *   pbkdf2-sha256$<iterations>$<salt-b64url>$<digest-b64url>
 *
 * A fresh 16-byte random salt and a 256-bit digest are produced per password.
 * The salt and digest are base64url-encoded without padding.
 */

export const PASSWORD_HASH_ALGORITHM = "pbkdf2-sha256";
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_DIGEST_BYTES = 32;

/** A stored hash is only trusted for a sane iteration range. */
export const PASSWORD_HASH_MIN_ITERATIONS = 1;
export const PASSWORD_HASH_MAX_ITERATIONS = 10_000_000;

/** Parsed view of an encoded password hash (untrusted persisted data). */
export interface ParsedPasswordHash {
  algorithm: string;
  iterations: number;
  salt: Uint8Array;
  digest: Uint8Array;
}

/**
 * Dependency-injectable password hashing port. The auth service depends on
 * this abstraction rather than on a concrete implementation.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
}

/** Derive the PBKDF2-HMAC-SHA256 digest for a password/salt/iteration triple. */
export async function derivePasswordDigest(
  password: string,
  iterations: number,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    PASSWORD_DIGEST_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Encode the parts of a password hash into the canonical stored format. */
export function encodePasswordHash(
  iterations: number,
  salt: Uint8Array,
  digest: Uint8Array,
): string {
  return `${PASSWORD_HASH_ALGORITHM}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(digest)}`;
}

/**
 * Parse and strictly validate an encoded password hash.
 *
 * Returns `null` for anything that is not a canonical, well-formed hash:
 * unknown algorithm, non-positive iteration count, invalid base64url, wrong
 * salt/digest lengths or extra/missing components.
 */
export function parsePasswordHash(encodedHash: string): ParsedPasswordHash | null {
  const parts = encodedHash.split("$");
  if (parts.length !== 4) {
    return null;
  }

  const [algorithm, iterationsRaw, saltRaw, digestRaw] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== PASSWORD_HASH_ALGORITHM) {
    return null;
  }

  if (!/^[1-9][0-9]*$/.test(iterationsRaw)) {
    return null;
  }
  const iterations = Number(iterationsRaw);
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < PASSWORD_HASH_MIN_ITERATIONS ||
    iterations > PASSWORD_HASH_MAX_ITERATIONS
  ) {
    return null;
  }

  const salt = base64UrlToBytes(saltRaw);
  if (salt === null || salt.length !== PASSWORD_SALT_BYTES) {
    return null;
  }

  const digest = base64UrlToBytes(digestRaw);
  if (digest === null || digest.length !== PASSWORD_DIGEST_BYTES) {
    return null;
  }

  return { algorithm, iterations, salt, digest };
}

/** PBKDF2-HMAC-SHA256 implementation of the {@link PasswordHasher} port. */
export class PBKDF2PasswordHasher implements PasswordHasher {
  readonly iterations: number;

  constructor(iterations: number) {
    if (
      !Number.isSafeInteger(iterations) ||
      iterations < PASSWORD_HASH_MIN_ITERATIONS ||
      iterations > PASSWORD_HASH_MAX_ITERATIONS
    ) {
      throw new RangeError(
        `iterations must be an integer between ${PASSWORD_HASH_MIN_ITERATIONS} and ${PASSWORD_HASH_MAX_ITERATIONS}`,
      );
    }
    this.iterations = iterations;
  }

  async hash(password: string): Promise<string> {
    const salt = getRandomBytes(PASSWORD_SALT_BYTES);
    const digest = await derivePasswordDigest(password, this.iterations, salt);
    return encodePasswordHash(this.iterations, salt, digest);
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    const parsed = parsePasswordHash(encodedHash);
    if (parsed === null) {
      return false;
    }
    const candidate = await derivePasswordDigest(password, parsed.iterations, parsed.salt);
    return constantTimeEqual(candidate, parsed.digest);
  }
}