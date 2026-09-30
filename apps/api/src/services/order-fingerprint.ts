import { IDEMPOTENCY_FINGERPRINT_HEX_LENGTH, type OrderAddressRequest, type PlaceOrderRequest } from "@zelora/shared";

/**
 * The request fingerprint stored alongside a checkout's idempotency key.
 *
 * An idempotency key alone is not enough to make `POST /api/orders` safe. A
 * key says "this is a retry of *something*"; the fingerprint says *what*, and
 * it is what lets the API answer a genuine retry with the original order while
 * refusing a key that has been reused for a materially different checkout.
 *
 * What goes in:
 *
 * - the authenticated user id. The lookup is already scoped to the customer,
 *   so this is belt and braces — but it costs nothing and means a fingerprint
 *   is never comparable across accounts.
 * - the two addresses that define the order, normalized to the shape the order
 *   actually stores (an absent billing address *is* the shipping address, so
 *   omitting it and sending it explicitly produce the same order and must
 *   produce the same fingerprint).
 *
 * What stays out, deliberately:
 *
 * - the cart. The body carries addresses only, and a retry of a *successful*
 *   checkout arrives after the original cleared the cart — including the
 *   cart's contents would make every real retry look like a different request.
 * - money. Prices are re-read from the catalog on the first attempt and
 *   snapshotted into the order, so two attempts that differ only in pricing
 *   have already produced two different orders; that is what the stock and
 *   currency conflicts are for, and it is not the idempotency key's business.
 *
 * The digest is SHA-256 over a canonical JSON encoding, rendered as hex: fixed
 * width so the schema can `CHECK` it, and one-way so the stored value is not a
 * plaintext copy of the address.
 *
 * Edge-safe: `crypto.subtle` is a Web Crypto global available in both workerd
 * and Node, so no Node-only hashing dependency is pulled into the Worker.
 */

/** A fingerprint's canonical form, exposed for tests to assert stability. */
export function canonicalizeCheckoutRequest(
  customerUserId: string,
  request: PlaceOrderRequest,
): string {
  return JSON.stringify([
    "zelora.checkout.v1",
    customerUserId,
    canonicalizeAddress(request.shippingAddress),
    canonicalizeAddress(request.billingAddress ?? request.shippingAddress),
  ]);
}

/**
 * Hex-encoded SHA-256 of the authenticated customer plus the request's
 * addresses. Stable across retries and across processes; its width matches
 * `IDEMPOTENCY_FINGERPRINT_HEX_LENGTH`, which the `orders` schema checks.
 */
export async function fingerprintCheckoutRequest(
  customerUserId: string,
  request: PlaceOrderRequest,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeCheckoutRequest(customerUserId, request));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

/**
 * One address as a positional JSON array.
 *
 * Arrays of scalars rather than an object, because `JSON.stringify` emits
 * object keys in insertion order: two requests whose keys were built in a
 * different order would otherwise hash differently while meaning the same
 * thing. Every field is a JSON scalar, so no value can be confused with the
 * field boundary around it.
 */
function canonicalizeAddress(address: OrderAddressRequest): readonly (string | null)[] {
  return [
    address.recipientName,
    address.phone ?? null,
    address.line1,
    address.line2 ?? null,
    address.city,
    address.region ?? null,
    address.postalCode ?? null,
    address.countryCode,
  ];
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  if (hex.length !== IDEMPOTENCY_FINGERPRINT_HEX_LENGTH) {
    // Unreachable for SHA-256, but the schema enforces this width, so failing
    // here beats storing a row the database would reject.
    throw new Error(`unexpected fingerprint width: ${hex.length}`);
  }
  return hex;
}