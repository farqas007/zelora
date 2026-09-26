import { sql } from "drizzle-orm";
import { blob, check, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { createdAtColumn, idColumn } from "./_common";
import { products } from "./catalog";

/**
 * Product media stored inside the database itself:
 *
 *   media_objects ── product_media ── products
 *
 * `media_objects` is the byte-level record of one stored object: the key the
 * storage driver uses, the verified content type, the exact length and the
 * bytes themselves. It is the database-backed counterpart of the R2 bucket
 * (and of the local filesystem directory) and exists so a deployment without an
 * R2 binding has a real, durable home for uploaded media — and so a deployment
 * *with* one still has a record of what it wrote, which is what makes an object
 * findable for a later read, replace or delete.
 *
 * `product_media` is the many-to-many join from a product to the objects
 * attached to it. It is deliberately separate from `product_images`: that table
 * is the *presentation* record (a URL, ordering, primary flag) every catalog
 * reader consumes, while this one records only that a product owns a stored
 * object. Keeping the bytes out of `product_images` is what lets the public
 * catalog keep reading a single URL column whether the object behind it lives
 * in R2, on local disk, or in D1.
 */

export const mediaObjects = sqliteTable("media_objects", {
  id: idColumn(),
  /**
   * The key the storage driver addresses the object by — the same string the
   * driver hands to `put`/`delete` and that the storage port turns into a
   * public URL. Server-generated and opaque, so it is UNIQUE: two rows
   * may never claim the same object, and `findByStorageKey` is exact rather
   * than a scan. Deduplicating an object is expressed as two `product_media`
   * rows pointing at one `media_objects` row, not as two object rows.
   */
  storageKey: text("storage_key").notNull(),
  /**
   * The verified content type of the stored bytes (sniffed from the bytes at
   * upload time, never a client-declared one). Stored on the row so a public
   * read can be served with the right `Content-Type` without trusting a
   * filename extension or re-sniffing, and so a later read that renders from
   * the database has metadata even when the storage driver keeps none.
   */
  contentType: text("content_type").notNull(),
  /** Length of `bytes` in bytes. Enforced against the stored bytes by a CHECK. */
  byteSize: integer("byte_size").notNull(),
  /**
   * The object's bytes, stored inline as a BLOB.
   *
   * This column uses Drizzle's Node-`Buffer` blob mapper, which is correct for
   * the local SQLite driver and **must not be used from the Cloudflare Worker**:
   * that mapper calls `Buffer.isBuffer` unconditionally, so it would throw in a
   * runtime without `nodejs_compat`. The D1 driver therefore reads and writes
   * this column through raw prepared statements
   * (`src/media/d1-repository.ts`) and normalizes `ArrayBuffer`/`Uint8Array`
   * itself. The DDL is a plain `blob` and holds identical bytes on both drivers.
   */
  bytes: blob("bytes").notNull(),
  createdAt: createdAtColumn(),
  /**
   * Content hash of `bytes` (a hex digest), or `null` when it was not computed.
   *
   * Nullable because it is not yet part of any write path: it exists so a
   * later duplicate-detection or integrity-repair pass can read a value that
   * does not have to be backfilled, and `null` stays the honest answer for
   * every object stored before it was computed.
   */
  checksum: text("checksum"),
}, (table) => [
  unique("media_objects_storage_key_unique").on(table.storageKey),
  /**
   * `byte_size` is redundant with `length(bytes)` on purpose: it is the value a
   * caller can assert against before writing, and the value a read path can use
   * without touching the payload. Making the database reject any disagreement
   * turns that redundancy into a guarantee instead of a convention, so no
   * driver can ever persist a row whose recorded size is a lie.
   */
  check("media_objects_byte_size_matches_bytes", sql`${table.byteSize} = length(${table.bytes})`),
]);

export const productMedia = sqliteTable("product_media", {
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  mediaObjectId: text("media_object_id").notNull().references(() => mediaObjects.id, { onDelete: "cascade" }),
  createdAt: createdAtColumn(),
}, (table) => [
  /**
   * Composite primary key, so attaching the same object to the same product
   * twice is impossible while the same object may legitimately belong to
   * several products (one upload, two listings) — which is exactly the
   * many-to-many shape the join table exists to express.
   */
  primaryKey({ columns: [table.productId, table.mediaObjectId] }),
  /**
   * `product_id` is already covered by the leftmost prefix of the composite
   * primary key, so it needs no separate index. `media_object_id` is *not*
   * covered by that key, and it is the direction that matters for lifecycle:
   * "which products reference this object?" is what a delete or a
   * replace-in-place has to answer, and it is also what the CASCADE on
   * `media_objects.id` uses when an object is removed.
   */
  index("product_media_media_object_id_idx").on(table.mediaObjectId),
]);
