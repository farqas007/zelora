import { base64UrlToBytes, bytesToBase64Url } from "./base64";
import { getRandomBytes } from "./random";

/**
 * Opaque session-token primitives.
 *
 * A raw session token is a 32-byte cryptographically secure random value,
 * base64url-encoded (no padding) so it is safe to place in an HttpOnly cookie
 * and URL contexts. The raw token is never stored: the database only ever sees
 * its SHA-256 hash.
 */

export const SESSION_TOKEN_BYTES = 32;

/** Generate a fresh opaque session token as an unpadded base64url string. */
export function generateSessionToken(): string {
  return bytesToBase64Url(getRandomBytes(SESSION_TOKEN_BYTES));
}

/**
 * SHA-256 hash of a raw session token, base64url-encoded.
 *
 * Only the result of this function may be persisted. Throws when the input is
 * not a valid unpadded base64url string.
 */
export async function hashSessionToken(rawToken: string): Promise<string> {
  const rawBytes = base64UrlToBytes(rawToken);
  if (rawBytes === null) {
    throw new Error("session token is not valid base64url");
  }
  const digest = await crypto.subtle.digest("SHA-256", rawBytes);
  return bytesToBase64Url(new Uint8Array(digest));
}