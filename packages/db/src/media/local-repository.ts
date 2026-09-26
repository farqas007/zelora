import { eq } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { mediaObjects } from "../schema/media";
import { toMediaBytes } from "./bytes";
import type { CreateMediaObjectInput, MediaObjectRecord, MediaObjectRepository } from "./repository";

/**
 * Local (better-sqlite3) implementation of the media-object repository.
 *
 * Built on the existing local Drizzle client. Even though better-sqlite3 is
 * synchronous, the methods here still present the async port contract so
 * callers and tests are driver-agnostic and the Cloudflare D1 implementation
 * satisfies the same interface.
 *
 * Bytes are handled through Drizzle's `blob({ mode: "buffer" })` mapper, which
 * is correct here because this driver only ever runs on Node: the mapper reads
 * and writes Node `Buffer`s, and better-sqlite3 binds a `Uint8Array` as a blob
 * but rejects a bare `ArrayBuffer`. The mapper's `Buffer` is converted back to
 * a `Uint8Array` at the record edge by {@link toMediaBytes}, so the value handed
 * to callers is the runtime-neutral one the port promises.
 *
 * The Worker counterpart (`d1-repository.ts`) deliberately does *not* use that
 * mapper — it cannot — which is why both drivers funnel their bytes through the
 * same `toMediaBytes` normalization and return identical records.
 */
export function createLocalMediaObjectRepository(db: LocalDatabase): MediaObjectRepository {
  return {
    async create(input: CreateMediaObjectInput) {
      const bytes = toMediaBytes(input.bytes);
      const row = db
        .insert(mediaObjects)
        .values({
          storageKey: input.storageKey,
          contentType: input.contentType,
          // Derived from the bytes, never taken from the caller: the
          // `media_objects_byte_size_matches_bytes` CHECK is then a tautology
          // rather than a trap, and no caller can record a size that lies.
          byteSize: bytes.byteLength,
          bytes,
          checksum: input.checksum ?? null,
        })
        .returning()
        .get();
      if (row === undefined) {
        throw new Error("media object insert returned no row");
      }
      return toMediaObjectRecord(row);
    },

    async findById(id: string) {
      const row = db.select().from(mediaObjects).where(eq(mediaObjects.id, id)).get();
      return row === undefined ? null : toMediaObjectRecord(row);
    },

    async findByStorageKey(storageKey: string) {
      const row = db.select().from(mediaObjects).where(eq(mediaObjects.storageKey, storageKey)).get();
      return row === undefined ? null : toMediaObjectRecord(row);
    },

    async delete(id: string) {
      const removed = db
        .delete(mediaObjects)
        .where(eq(mediaObjects.id, id))
        .returning({ id: mediaObjects.id })
        .all();
      return removed.length > 0;
    },
  };
}

/** Widen one selected row into the port's record, normalizing its bytes. */
function toMediaObjectRecord(row: typeof mediaObjects.$inferSelect): MediaObjectRecord {
  return {
    id: row.id,
    storageKey: row.storageKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    bytes: toMediaBytes(row.bytes),
    createdAt: row.createdAt,
    checksum: row.checksum,
  };
}
