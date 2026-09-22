import { v7 } from "uuid";

/**
 * RFC 9562 UUIDv7 pattern: version nibble `7` at position 14, variant
 * nibble in `8|9|a|b` at position 19, lowercase canonical form.
 */
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Create a new primary key id.
 *
 * UUIDv7 is time-ordered (lexicographic order approximates creation order,
 * which keeps B-tree locality good), globally unique without coordination,
 * non-enumerable (privacy-sensitive for a public marketplace), and generated
 * application-side with no database round-trip. Stored as canonical lowercase
 * text so it is byte-for-byte portable between local SQLite and Cloudflare D1.
 */
export function createId(): string {
  const id = v7();
  if (!UUIDV7_PATTERN.test(id)) {
    throw new Error(`Generated id is not a valid UUIDv7: "${id}".`);
  }
  return id;
}

/** Whether a value is a canonical lowercase UUIDv7 usable as a Zelora id. */
export function isValidId(value: string): boolean {
  return UUIDV7_PATTERN.test(value);
}