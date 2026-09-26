/**
 * Byte normalization for the media-object repository boundary.
 *
 * Media bytes cross several runtimes and every one of them hands them over in a
 * different shape:
 *
 * - the storage port speaks `ArrayBuffer` (that is what R2, `fetch` and the
 *   filesystem driver all accept),
 * - a Node `Buffer` (a `Uint8Array` subclass) is what better-sqlite3 binds and
 *   what Drizzle's local blob mapper returns,
 * - a real D1 binding returns a BLOB as an `ArrayBuffer`, while D1 reached
 *   through a workerd RPC boundary (Miniflare, and the D1 test harness) hands
 *   back a plain array of byte values.
 *
 * This module is the single place that turns any of those into one canonical
 * `Uint8Array`. It exists as its own file because the conversion must be shared
 * by *both* repository drivers: the D1 driver calls it on the way in and on the
 * way out, and the local driver calls it so its records are byte-for-byte
 * identical to the D1 ones.
 *
 * Two properties are load-bearing:
 *
 * 1. **No Node built-ins.** There is no `Buffer` reference, no `node:` import
 *    and no Node-only type here, so this module is safe inside the Cloudflare
 *    Worker without `nodejs_compat`. `ArrayBuffer.isView` is used instead of
 *    `instanceof Uint8Array` precisely because it checks the internal slot and
 *    therefore also matches a `Buffer` or a view from another realm.
 * 2. **Always a fresh copy.** The result never shares memory with the input, so
 *    a caller that mutates its buffer (or a driver that reuses a read buffer)
 *    can never retroactively change bytes that have already been stored or
 *    handed out. Views are copied by their exact byte window rather than by
 *    their backing buffer, so a view into a 10 MB buffer yields only its own
 *    bytes and not the whole allocation.
 */

/**
 * Every shape stored-object bytes may legitimately arrive in.
 *
 * The `readonly number[]` member exists only for *reads*: it is how a D1 BLOB
 * arrives through a workerd RPC boundary, and no caller ever needs to pass it.
 */
export type MediaByteSource = ArrayBuffer | ArrayBufferView | readonly number[];

/**
 * Convert stored-object bytes to a canonical, freshly allocated `Uint8Array`.
 *
 * `value` is typed `unknown` rather than {@link MediaByteSource} on purpose: on
 * the read path it is whatever a driver handed back, which no type can describe
 * (Drizzle types its `Buffer` blob column as `unknown`), so this function is the
 * runtime check that turns "some driver value" into "bytes or a loud failure".
 *
 * @param value bytes from any driver or caller shape
 * @throws TypeError when the value is not one of the documented shapes. A
 *   silent fallback here would write an empty or misread object and leave the
 *   row disagreeing with the bytes, so an unrecognised shape fails loudly at
 *   the boundary instead.
 */
export function toMediaBytes(value: unknown): Uint8Array {
  if (ArrayBuffer.isView(value)) {
    // `Buffer` and every other typed array land here. Copy only the view's own
    // window so a subarray view of a larger buffer stores just its bytes.
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  throw new TypeError(
    `Media bytes must be an ArrayBuffer, a typed array or an array of byte values, received ${describe(value)}.`,
  );
}

/**
 * The `ArrayBuffer` form of stored-object bytes, for drivers that bind a plain
 * buffer rather than a view (better-sqlite3 accepts a `Uint8Array` but rejects a
 * bare `ArrayBuffer`, while D1 accepts both).
 *
 * Shares no memory with the input and always covers exactly the source bytes:
 * `toMediaBytes` returns a view whose backing buffer is a private copy starting
 * at offset 0, so returning it directly is safe.
 */
export function toMediaArrayBuffer(value: unknown): ArrayBuffer {
  return toMediaBytes(value).buffer as ArrayBuffer;
}

/** Short, safe description of an unexpected value for an error message. */
function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  const type = typeof value;
  if (type === "object") {
    return (value as object).constructor?.name ?? "object";
  }
  return type;
}
