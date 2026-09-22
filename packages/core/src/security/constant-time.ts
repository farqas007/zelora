/**
 * Constant-time byte comparison so that password hash digests (and any other
 * secret byte material) cannot be compared byte-by-byte with early return.
 *
 * Deliberately avoids Node-specific crypto APIs so it runs on Cloudflare
 * Workers and in the browser. Length differences are rejected up front — the
 * length of a derived digest is never secret.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a[i]! ^ b[i]!;
  }
  return difference === 0;
}