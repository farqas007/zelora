/**
 * Seller review-queue keyset cursor.
 *
 * The pending applications index is ordered by `(created_at, id)` ascending
 * (oldest application first). The cursor is the opaque string
 * `<created_at_ms>:<uuid>` of the last item of the previous page; the next
 * page continues strictly after it. Encoded as plain text (digits, `:`, hex
 * digits) so it needs no escaping as a query-string value and round-trips
 * identically on local SQLite and Cloudflare D1.
 */

export interface SellerCursor {
  createdAt: Date;
  id: string;
}

/** True when `value` is a canonical `<created_at_ms>:<id>` cursor. */
function isCursorValue(value: string): boolean {
  return /^\d+:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function encodeSellerCursor(cursor: SellerCursor): string {
  return `${cursor.createdAt.getTime()}:${cursor.id}`;
}

/** Decode an opaque cursor to its `(createdAt, id)` pair, or `null` when malformed. */
export function decodeSellerCursor(value: string): SellerCursor | null {
  if (!isCursorValue(value)) {
    return null;
  }
  const separator = value.indexOf(":");
  if (separator < 1) {
    return null;
  }
  const createdAtMs = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (!Number.isSafeInteger(createdAtMs)) {
    return null;
  }
  return { createdAt: new Date(createdAtMs), id };
}