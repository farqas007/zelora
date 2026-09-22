/** Cryptographically secure random bytes via `crypto.getRandomValues()`. */
export function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}