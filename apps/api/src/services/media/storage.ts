/**
 * Media storage port for seller-uploaded product images.
 *
 * This module is the runtime-neutral contract every storage implementation
 * satisfies. It is deliberately tiny — write one object, delete one object,
 * derive its public URL — because that is the whole surface Phase 2A needs and
 * anything larger would be speculative.
 *
 * Design notes that are load-bearing rather than stylistic:
 *
 * - **`publicUrl` is synchronous and pure.** It is string composition over a
 *   configured base and is needed both on the write path (to persist
 *   `product_images.url`) and on any future read/repair path. Making it async
 *   would only tempt callers to `await` it inside record mappers, and making
 *   it responsible for anything more would turn a pure function into I/O.
 * - **`put` returns nothing.** The only way to obtain a URL is
 *   `publicUrl(key)`, so exactly one function owns URL shape and changing the
 *   base URL is a one-line change in one place.
 * - **Failures throw.** Constraint *conflicts* in this codebase are modelled as
 *   result unions; infrastructure failures are not. A throwing storage port
 *   lets each driver surface its own cause and lets the shared error boundary
 *   decide the client-facing shape.
 * - **`delete` must be idempotent.** Callers use it to compensate after a
 *   partially completed upload, where the object may legitimately be absent
 *   already; a missing key is a success.
 *
 * Edge-compatible: this module imports nothing at all, so it is safe in the
 * Cloudflare Worker module graph. The concrete drivers live beside it —
 * `r2.ts` (Worker-safe) and `local-fs.ts` (Node-only, imported exclusively by
 * `src/index.ts` and tests).
 */

/** The bytes and metadata of one object to store. */
export interface MediaObjectInput {
  /**
   * The object's bytes. `ArrayBuffer` rather than `Uint8Array`/`Buffer` so the
   * same value is accepted by R2, by the filesystem driver and by a test fake
   * without any driver-specific conversion.
   */
  bytes: ArrayBuffer;
  /**
   * The object's content type, carried through to storage HTTP metadata so a
   * later public read is served with the right type. Callers must pass a
   * *verified* type (sniffed from the bytes), never a client-declared one.
   */
  contentType: string;
  /**
   * The object's length in bytes. Must equal `bytes.byteLength`; both drivers
   * assert this so a caller that computes `size` from somewhere other than the
   * buffer it is about to store fails loudly instead of writing a row that
   * disagrees with the stored object.
   */
  size: number;
}

export interface MediaStorage {
  /** Store `object` under `key`, replacing any object already at that key. */
  put(key: string, object: MediaObjectInput): Promise<void>;
  /** Remove the object at `key`. Resolves successfully when it is absent. */
  delete(key: string): Promise<void>;
  /** The absolute, publicly readable URL the object at `key` is served from. */
  publicUrl(key: string): string;
}

/**
 * Internal error code for storage-layer faults. Deliberately not part of the
 * shared client-facing vocabulary in `@zelora/shared`: it describes a
 * deployment or programming fault, never a request the client can fix, so the
 * error boundary must render it as a generic 500.
 */
export const MEDIA_STORAGE_ERROR_CODE = "MEDIA_STORAGE_ERROR";

/**
 * Join a configured public base URL and a storage key with exactly one
 * separator.
 *
 * Both drivers share this so the URL shape is defined once. The base is
 * validated and trailing-slash-stripped by `loadConfig`
 * (`MEDIA_PUBLIC_BASE_URL`), so this only has to guard the join itself.
 */
export function joinMediaPublicUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

/**
 * Assert the `size` field agrees with the buffer actually being stored.
 *
 * Shared by both drivers so the invariant is enforced identically: a mismatch
 * is a caller bug, and storing the object anyway would leave the database and
 * the bucket permanently disagreeing about how large the image is.
 */
export function assertMediaObjectSize(key: string, object: MediaObjectInput): void {
  if (object.size !== object.bytes.byteLength) {
    throw new Error(
      `Media object for key "${key}" declares size ${object.size} but carries ${object.bytes.byteLength} bytes.`,
    );
  }
}

/**
 * The fail-closed storage used when a composition boundary supplies no
 * implementation.
 *
 * `createApp` defaults to this so an unconfigured deployment cannot silently
 * accept an upload and drop it, and cannot hand out a URL that resolves to
 * nothing. Every method throws: there is no meaningful partial behaviour, and
 * a driver that returned a placeholder URL would move the failure from an
 * obvious 500 at upload time to a broken `<img>` in production.
 */
export function createUnavailableMediaStorage(reason: string): MediaStorage {
  const fail = (operation: string): never => {
    throw new Error(`Media storage is not configured: cannot ${operation} (${reason}).`);
  };
  return {
    put: async (): Promise<void> => {
      fail("put an object");
    },
    delete: async (): Promise<void> => {
      fail("delete an object");
    },
    publicUrl: (key: string): string => fail(`build a public URL for "${key}"`),
  };
}
