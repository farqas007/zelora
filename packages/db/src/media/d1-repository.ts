import { createId } from "../ids";
import type { D1DatabaseLike } from "../d1";
import { toMediaArrayBuffer, toMediaBytes, type MediaByteSource } from "./bytes";
import type { CreateMediaObjectInput, MediaObjectRecord, MediaObjectRepository } from "./repository";

/**
 * Cloudflare D1 implementation of the media-object repository.
 *
 * **This driver uses raw D1 prepared statements, not the Drizzle D1 client, and
 * that is a hard requirement rather than a style choice.** Drizzle's SQLite
 * `blob({ mode: "buffer" })` mapper calls `Buffer.isBuffer(value)`
 * unconditionally when it reads a BLOB back from the database. In the
 * Cloudflare Worker — which runs without `nodejs_compat`, so there is no
 * `Buffer` at all — that mapper throws a bare `ReferenceError` at runtime, on a
 * path a type check cannot see. The local driver may use it because it only ever
 * runs on Node; this one must not, so every statement here is hand-written SQL
 * against the `D1DatabaseLike` binding and every byte is normalized by
 * {@link toMediaBytes}, which contains no Node dependency of any kind.
 *
 * The consequence is that this file also does not import the Drizzle D1 driver
 * or the schema: the SQL below is written against the `media_objects` DDL
 * directly, which keeps the whole module free of `better-sqlite3` and keeps the
 * Worker bundle honest (see `scripts/check-worker-bundle.mjs`).
 *
 * Statements are parameterised and the SQL is static: no value is ever
 * interpolated, so a hostile storage key is bound, not concatenated.
 */
export function createD1MediaObjectRepository(
  database: D1DatabaseLike,
): MediaObjectRepository {
  return {
    async create(input: CreateMediaObjectInput) {
      const bytes = toMediaBytes(input.bytes);
      // `createId` is the repository-wide UUIDv7 generator, the same format
      // `idColumn()`'s `$defaultFn` produces for every other table. It is called
      // directly because this driver does not go through Drizzle, and
      // `../ids` is Worker-safe (the `uuid` package uses Web Crypto and is
      // already in the Worker bundle through `@zelora/db/ids`).
      const id = createId();
      const createdAt = new Date();
      await database
        .prepare(
          "INSERT INTO media_objects " +
            "(id, storage_key, content_type, byte_size, bytes, created_at, checksum) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          id,
          input.storageKey,
          input.contentType,
          // Derived from the bytes, never taken from the caller, so the
          // `media_objects_byte_size_matches_bytes` CHECK is a tautology rather
          // than a trap.
          bytes.byteLength,
          // Bound as the backing `ArrayBuffer`: D1 accepts both, and this is
          // the shape a real D1 binding returns for a BLOB on the way back, so
          // write and read use the same representation.
          toMediaArrayBuffer(bytes),
          createdAt.getTime(),
          input.checksum ?? null,
        )
        .run();
      return {
        id,
        storageKey: input.storageKey,
        contentType: input.contentType,
        byteSize: bytes.byteLength,
        bytes,
        createdAt,
        checksum: input.checksum ?? null,
      };
    },

    async findById(id: string) {
      const row = await database
        .prepare(
          "SELECT id, storage_key, content_type, byte_size, bytes, created_at, checksum " +
            "FROM media_objects WHERE id = ?",
        )
        .bind(id)
        .first<MediaObjectRow>();
      return row === null ? null : toMediaObjectRecord(row);
    },

    async findByStorageKey(storageKey: string) {
      const row = await database
        .prepare(
          "SELECT id, storage_key, content_type, byte_size, bytes, created_at, checksum " +
            "FROM media_objects WHERE storage_key = ?",
        )
        .bind(storageKey)
        .first<MediaObjectRow>();
      return row === null ? null : toMediaObjectRecord(row);
    },

    async delete(id: string) {
      const result = await database
        .prepare("DELETE FROM media_objects WHERE id = ?")
        .bind(id)
        .run();
      return changedRowCount(result) > 0;
    },
  };
}

/**
 * One `media_objects` row exactly as D1 returns it.
 *
 * Column names are the raw snake_case ones because no mapper renames them, and
 * `created_at` is the raw epoch-millisecond integer (`timestamp_ms` in the
 * schema) because the Drizzle mode that would turn it into a `Date` belongs to
 * the same layer this driver deliberately bypasses.
 */
interface MediaObjectRow {
  id: string;
  storage_key: string;
  content_type: string;
  byte_size: number;
  bytes: MediaByteSource;
  created_at: number;
  checksum: string | null;
}

/** Map one raw row onto the port's record, normalizing the bytes. */
function toMediaObjectRecord(row: MediaObjectRow): MediaObjectRecord {
  return {
    id: row.id,
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize: row.byte_size,
    bytes: toMediaBytes(row.bytes),
    createdAt: new Date(row.created_at),
    checksum: row.checksum,
  };
}

/**
 * Read the row count off a D1 write result.
 *
 * D1 reports affected rows on `.meta.changes`. `D1PreparedStatementLike` types
 * `run()`'s metadata as `unknown` (Cloudflare worker types are deliberately not
 * a dependency), so the value is resolved defensively and never surfaced raw: a
 * missing count means "unknown", which `delete` reports as "nothing was
 * removed" rather than as a successful delete.
 */
function changedRowCount(result: { meta: unknown }): number {
  if (typeof result.meta !== "object" || result.meta === null) {
    return 0;
  }
  const value = (result.meta as { changes?: unknown }).changes;
  return typeof value === "number" ? value : 0;
}
