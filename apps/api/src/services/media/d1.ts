/**
 * D1-backed implementation of the {@link MediaStorage} port: the bytes of every
 * object live in the `media_objects` table next to the rest of the data.
 *
 * Edge-safe by construction, for the same reasons as `r2.ts`: no
 * `@cloudflare/workers-types`, no `node:` specifiers and no `Buffer`. Bytes
 * cross this boundary as `ArrayBuffer`, and the repository behind it is the
 * raw-statement D1 driver (`@zelora/db/media/d1`), which is Worker-safe by
 * necessity rather than by convention.
 *
 * What this driver does *not* do is pretend the storage key is the row's
 * identity. Rows have their own generated id and the unique constraint is on
 * `storage_key`, so every operation resolves the key to a row first:
 *
 * - `put` replaces, like R2 and the filesystem driver. Because a row cannot be
 *   updated in place through the repository port, a re-put deletes the previous
 *   row and inserts a new one; the delete is what removes any `product_media`
 *   rows pointing at the old bytes (see the `ON DELETE CASCADE` in migration
 *   0007). Keys embed a fresh UUID, so this path is only reachable by a caller
 *   that reuses a key on purpose.
 * - `get` reports absence as `null`, matching the port.
 * - `delete` is idempotent: an unknown key is a success, exactly as R2's and
 *   `rm --force`'s are.
 */

import { PRODUCT_IMAGE_LIMITS } from "@zelora/shared";
import { createD1MediaObjectRepository } from "@zelora/db/media/d1";
import type { MediaObjectRepository } from "@zelora/db/media";
import {
  assertMediaObjectSize,
  joinMediaPublicUrl,
  type MediaObjectInput,
  type MediaObjectOutput,
  type MediaStorage,
} from "./storage";

export interface D1MediaStorageOptions {
  /**
   * The media-object repository the bytes are stored through. Injected rather
   * than constructed from a binding here so the driver stays independent of how
   * the database is reached, and so a test can drive it with a fake.
   */
  repository: MediaObjectRepository;
  /**
   * Absolute `http(s)` base the objects are publicly readable from, already
   * validated and trailing-slash-stripped by `loadConfig`.
   *
   * D1 has no object store to serve a path from, so the public URL is composed
   * the same way as for R2 and the local filesystem: this phase builds the
   * driver and the URL shape, and serving bytes at that path is a later phase's
   * route. `put` therefore never assumes the URL resolves yet.
   */
  publicBaseUrl: string;
}

export function createD1MediaStorage(options: D1MediaStorageOptions): MediaStorage {
  const { repository, publicBaseUrl } = options;
  return {
    async put(key: string, object: MediaObjectInput) {
      assertMediaObjectSize(key, object);
      // D1's own per-value BLOB ceiling, asserted here as defense in depth. The
      // enforced per-image cap is far stricter (1.5 MiB), so this can only fire
      // if a future caller bypasses validation — and firing here names the
      // object that would have failed, instead of surfacing an opaque D1 write
      // error (or, worse, a truncated row) at the storage layer.
      if (object.bytes.byteLength > PRODUCT_IMAGE_LIMITS.maxStoredObjectBytes) {
        throw new Error(
          `Media object for key "${key}" is ${object.bytes.byteLength} bytes, which exceeds the D1 BLOB limit of ${PRODUCT_IMAGE_LIMITS.maxStoredObjectBytes} bytes.`,
        );
      }
      // Replace, matching R2's `put` and the filesystem driver's overwrite.
      // A unique-constraint failure here would be a caller bug (a storage key
      // is supposed to be server-generated and unique), so the previous row is
      // removed first rather than letting the write fail.
      const existing = await repository.findByStorageKey(key);
      if (existing !== null) {
        await repository.delete(existing.id);
      }
      await repository.create({
        storageKey: key,
        contentType: object.contentType,
        bytes: object.bytes,
        // `checksum` stays `null` here: nothing in this phase has agreed on a
        // hashing format, and inventing one would bake an unverifiable value
        // into the column that exists to be trusted.
      });
    },

    async get(key: string) {
      const record = await repository.findByStorageKey(key);
      if (record === null) {
        return null;
      }
      return {
        // The repository hands back a canonical `Uint8Array` that already owns
        // its memory, so copying it into a buffer the caller can consume is
        // exact — no pool window, no re-encoding.
        bytes: record.bytes.buffer.slice(
          record.bytes.byteOffset,
          record.bytes.byteOffset + record.bytes.byteLength,
        ) as ArrayBuffer,
        contentType: record.contentType,
      } satisfies MediaObjectOutput;
    },

    async delete(key: string) {
      const existing = await repository.findByStorageKey(key);
      if (existing === null) {
        return;
      }
      await repository.delete(existing.id);
    },

    publicUrl(key: string) {
      return joinMediaPublicUrl(publicBaseUrl, key);
    },
  };
}

/** Re-exported so a composition root can build the driver from a D1 binding. */
export { createD1MediaObjectRepository };
