/**
 * Client-side idempotency keys for checkout.
 *
 * A checkout POST is a money-moving write that the network, a proxy or the
 * shopper will retry, and a retry that is not recognised as one creates a second
 * order. The server de-duplicates on the `Idempotency-Key` header, so the client
 * owes exactly one thing: to hand the *same* key to every attempt at the *same*
 * checkout, and a fresh key only once that attempt has definitively finished.
 */

/**
 * Generate a key for one checkout attempt.
 *
 * A random UUID (v4) has 122 bits of entropy, so keys never collide between
 * shoppers and a key cannot be guessed from an order id. The 36-character form
 * also sits inside the shared 8-64 length limit and uses only characters the
 * shared pattern allows, so the server's own validation can never reject a key
 * this function produced.
 */
export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}