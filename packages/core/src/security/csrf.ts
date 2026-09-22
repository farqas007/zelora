import { bytesToBase64Url } from "./base64";
import { getRandomBytes } from "./random";

/** CSRF synchronizer tokens are 32 random bytes, base64url-encoded. */
export const CSRF_TOKEN_BYTES = 32;

/** Generate a cryptographically random CSRF token as an unpadded base64url string. */
export function generateCsrfToken(): string {
  return bytesToBase64Url(getRandomBytes(CSRF_TOKEN_BYTES));
}