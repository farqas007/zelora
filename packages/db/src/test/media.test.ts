import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../d1";
import { toMediaArrayBuffer, toMediaBytes } from "../media/bytes";
import { createD1MediaObjectRepository } from "../media/d1-repository";
import { createLocalMediaObjectRepository } from "../media/local-repository";
import { createTestDatabase, expectConstraintError } from "./helpers";
import { createChain } from "./fixtures";

/**
 * Local (better-sqlite3) coverage of the media storage foundation: the committed
 * migration's shape, and the media-object repository's put/get/delete contract.
 *
 * The schema assertions read `PRAGMA` output rather than the Drizzle objects on
 * purpose — the migration SQL is what local SQLite and D1 actually run, so the
 * test proves the *database* enforces the composite key, both cascades and the
 * unique storage key, not merely that the TypeScript schema describes them.
 */
const BINARY_BYTES = Uint8Array.from([
  0x00, 0x01, 0x7f, 0x80, 0x89, 0x0a, 0x0d, 0xff, 0xfe, 0xc3, 0xa9, 0x00,
]);

interface ColumnInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface ColumnShape {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/**
 * Column shapes in declaration order.
 *
 * `PRAGMA table_info` also reports `cid` and `dflt_value`, and echoes the type
 * exactly as the migration spells it, so the projection keeps only the four
 * facts under test and lowercases the type keyword.
 */
function tableColumns(sqlite: Database.Database, table: string): ColumnShape[] {
  const rows = sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as ColumnInfoRow[];
  return rows.map((row) => ({
    name: row.name,
    type: row.type.toLowerCase(),
    notnull: row.notnull,
    pk: row.pk,
  }));
}

function indexNames(sqlite: Database.Database, table: string): string[] {
  const rows = sqlite.prepare(`PRAGMA index_list(${table})`).all() as unknown as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function foreignKeys(sqlite: Database.Database, table: string): Array<{
  table: string;
  from: string;
  to: string;
  on_delete: string;
}> {
  return sqlite
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all() as unknown as Array<{ table: string; from: string; to: string; on_delete: string }>;
}

describe("media schema: media_objects", () => {
  it("has the migrated columns, types and nullability", () => {
    const { sqlite } = createTestDatabase();

    expect(tableColumns(sqlite, "media_objects")).toEqual([
      { name: "id", type: "text", notnull: 1, pk: 1 },
      { name: "storage_key", type: "text", notnull: 1, pk: 0 },
      { name: "content_type", type: "text", notnull: 1, pk: 0 },
      { name: "byte_size", type: "integer", notnull: 1, pk: 0 },
      { name: "bytes", type: "blob", notnull: 1, pk: 0 },
      { name: "created_at", type: "integer", notnull: 1, pk: 0 },
      { name: "checksum", type: "text", notnull: 0, pk: 0 },
    ]);
  });

  it("makes the storage key unique", () => {
    const { sqlite, db } = createTestDatabase();
    expect(indexNames(sqlite, "media_objects")).toContain("media_objects_storage_key_unique");

    db.insert(schema.mediaObjects)
      .values({
        storageKey: "products/abc/shared.jpg",
        contentType: "image/jpeg",
        byteSize: 1,
        bytes: Uint8Array.from([1]),
      })
      .run();

    expectConstraintError(
      () =>
        db
          .insert(schema.mediaObjects)
          .values({
            storageKey: "products/abc/shared.jpg",
            contentType: "image/jpeg",
            byteSize: 1,
            bytes: Uint8Array.from([1]),
          })
          .run(),
      /UNIQUE constraint failed: media_objects\.storage_key/,
    );
  });

  it("rejects a recorded byte size that disagrees with the stored bytes", () => {
    const { db } = createTestDatabase();
    expectConstraintError(
      () =>
        db
          .insert(schema.mediaObjects)
          .values({
            storageKey: "products/abc/lying-size.jpg",
            contentType: "image/jpeg",
            byteSize: 99,
            bytes: Uint8Array.from([1, 2, 3]),
          })
          .run(),
      /CHECK constraint failed: media_objects_byte_size_matches_bytes/,
    );
  });
});

describe("media schema: product_media", () => {
  it("has a composite (product_id, media_object_id) primary key", () => {
    const { sqlite } = createTestDatabase();

    expect(tableColumns(sqlite, "product_media")).toEqual([
      { name: "product_id", type: "text", notnull: 1, pk: 1 },
      { name: "media_object_id", type: "text", notnull: 1, pk: 2 },
      { name: "created_at", type: "integer", notnull: 1, pk: 0 },
    ]);
  });

  it("indexes media_object_id, the direction a delete has to answer", () => {
    const { sqlite } = createTestDatabase();
    expect(indexNames(sqlite, "product_media")).toContain("product_media_media_object_id_idx");
  });

  it("cascades both foreign keys on delete", () => {
    const { sqlite } = createTestDatabase();
    const keys = foreignKeys(sqlite, "product_media");

    // `PRAGMA foreign_key_list` reports keys in reverse declaration order, so
    // the assertions match on content rather than position.
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "products", from: "product_id", to: "id", on_delete: "CASCADE" }),
        expect.objectContaining({
          table: "media_objects",
          from: "media_object_id",
          to: "id",
          on_delete: "CASCADE",
        }),
      ]),
    );
  });

  it("rejects a duplicate (product, object) pair but allows one object on two products", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const otherProductId = db
      .insert(schema.products)
      .values({ storeId: chain.storeBId, name: "Second Product", slug: "second-product" })
      .returning({ id: schema.products.id })
      .get().id;
    const object = db
      .insert(schema.mediaObjects)
      .values({
        storageKey: "products/shared/photo.jpg",
        contentType: "image/jpeg",
        byteSize: 2,
        bytes: Uint8Array.from([0xff, 0xd8]),
      })
      .returning({ id: schema.mediaObjects.id })
      .get();

    db.insert(schema.productMedia)
      .values([
        { productId: chain.cameraProductId, mediaObjectId: object.id },
        { productId: otherProductId, mediaObjectId: object.id },
      ])
      .run();

    expect(db.select().from(schema.productMedia).all()).toHaveLength(2);
    expectConstraintError(
      () =>
        db
          .insert(schema.productMedia)
          .values({ productId: chain.cameraProductId, mediaObjectId: object.id })
          .run(),
      /UNIQUE constraint failed: product_media\.product_id, product_media\.media_object_id/,
    );
  });

  it("rejects a join row for an unknown product or an unknown object", () => {
    const { db } = createTestDatabase();
    const chain = createChain(db);
    const object = db
      .insert(schema.mediaObjects)
      .values({
        storageKey: "products/abc/real.jpg",
        contentType: "image/jpeg",
        byteSize: 1,
        bytes: Uint8Array.from([7]),
      })
      .returning({ id: schema.mediaObjects.id })
      .get();

    expectConstraintError(
      () =>
        db
          .insert(schema.productMedia)
          .values({ productId: "00000000-0000-7000-8000-000000000001", mediaObjectId: object.id })
          .run(),
      /FOREIGN KEY constraint failed/,
    );
    expectConstraintError(
      () =>
        db
          .insert(schema.productMedia)
          .values({
            productId: chain.cameraProductId,
            mediaObjectId: "00000000-0000-7000-8000-000000000002",
          })
          .run(),
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("local media object repository", () => {
  it("stores, finds and deletes an object with byte-identical bytes", async () => {
    const { db } = createTestDatabase();
    const repository = createLocalMediaObjectRepository(db);

    const created = await repository.create({
      storageKey: "products/abc/0123.png",
      contentType: "image/png",
      bytes: BINARY_BYTES,
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.storageKey).toBe("products/abc/0123.png");
    expect(created.contentType).toBe("image/png");
    expect(created.byteSize).toBe(BINARY_BYTES.byteLength);
    expect(created.checksum).toBeNull();
    expect([...created.bytes]).toEqual([...BINARY_BYTES]);
    expect(created.createdAt).toBeInstanceOf(Date);

    const byId = await repository.findById(created.id);
    expect(byId).not.toBeNull();
    expect([...byId!.bytes]).toEqual([...BINARY_BYTES]);
    expect(byId!.contentType).toBe("image/png");
    expect(byId!.byteSize).toBe(BINARY_BYTES.byteLength);

    const byKey = await repository.findByStorageKey("products/abc/0123.png");
    expect(byKey?.id).toBe(created.id);
    expect([...byKey!.bytes]).toEqual([...BINARY_BYTES]);

    expect(await repository.delete(created.id)).toBe(true);
    expect(await repository.findById(created.id)).toBeNull();
  });

  it("keeps a stored checksum and an explicitly null one", async () => {
    const { db } = createTestDatabase();
    const repository = createLocalMediaObjectRepository(db);

    const withChecksum = await repository.create({
      storageKey: "products/abc/hashed.jpg",
      contentType: "image/jpeg",
      bytes: Uint8Array.from([1, 2, 3]),
      checksum: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    });
    expect(withChecksum.checksum).toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
    expect((await repository.findById(withChecksum.id))?.checksum).toBe(
      "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    );

    const withoutChecksum = await repository.create({
      storageKey: "products/abc/unchecksummed.jpg",
      contentType: "image/jpeg",
      bytes: Uint8Array.from([4, 5, 6]),
      checksum: null,
    });
    expect(withoutChecksum.checksum).toBeNull();
  });

  it("returns the repository's not-found result for a missing object", async () => {
    const { db } = createTestDatabase();
    const repository = createLocalMediaObjectRepository(db);

    expect(await repository.findById("00000000-0000-7000-8000-000000000001")).toBeNull();
    expect(await repository.findByStorageKey("products/never/written.jpg")).toBeNull();
    // Deleting something that does not exist is a no-op, not a silent success,
    // so a retried compensation cannot claim it removed an object.
    expect(await repository.delete("00000000-0000-7000-8000-000000000001")).toBe(false);
  });

  it("refuses a second object claiming the same storage key", async () => {
    const { db } = createTestDatabase();
    const repository = createLocalMediaObjectRepository(db);
    await repository.create({
      storageKey: "products/abc/once.jpg",
      contentType: "image/jpeg",
      bytes: Uint8Array.from([1]),
    });

    await expect(
      repository.create({
        storageKey: "products/abc/once.jpg",
        contentType: "image/jpeg",
        bytes: Uint8Array.from([2]),
      }),
    ).rejects.toThrow(/UNIQUE constraint failed: media_objects\.storage_key/);
  });

  it("accepts ArrayBuffer and typed-array inputs identically", async () => {
    const { db } = createTestDatabase();
    const repository = createLocalMediaObjectRepository(db);

    const fromArrayBuffer = await repository.create({
      storageKey: "products/abc/from-buffer.jpg",
      contentType: "image/jpeg",
      bytes: BINARY_BYTES.buffer,
    });
    const fromView = await repository.create({
      storageKey: "products/abc/from-view.jpg",
      contentType: "image/jpeg",
      bytes: BINARY_BYTES,
    });

    expect([...fromArrayBuffer.bytes]).toEqual([...fromView.bytes]);
    expect(fromArrayBuffer.byteSize).toBe(fromView.byteSize);
  });

  it("is not affected by a later mutation of the caller's buffer", async () => {
    const { db } = createTestDatabase();
    const repository = createLocalMediaObjectRepository(db);
    const source = Uint8Array.from([1, 2, 3, 4]);

    const created = await repository.create({
      storageKey: "products/abc/mutated.jpg",
      contentType: "image/jpeg",
      bytes: source,
    });
    source.fill(9);

    expect([...(await repository.findById(created.id))!.bytes]).toEqual([1, 2, 3, 4]);
  });

  it("unlinks product_media when a product is deleted but keeps the object", async () => {
    const { db } = createTestDatabase();
    const repository = createLocalMediaObjectRepository(db);
    const chain = createChain(db);
    const object = await repository.create({
      storageKey: "products/chain/photo.jpg",
      contentType: "image/jpeg",
      bytes: Uint8Array.from([0xff, 0xd8, 0xff]),
    });
    db.insert(schema.productMedia)
      .values({ productId: chain.cameraProductId, mediaObjectId: object.id })
      .run();

    db.delete(schema.products).where(eq(schema.products.id, chain.cameraProductId)).run();

    expect(db.select().from(schema.productMedia).all()).toHaveLength(0);
    // An object may back several listings, so unlinking one product must not
    // destroy bytes another product still points at.
    expect(await repository.findById(object.id)).not.toBeNull();
  });
});

/**
 * The D1 driver is exercised here against a hand-written fake binding rather
 * than only against Miniflare, because the properties that matter most are about
 * *how* it talks to D1, and a fake can observe them directly:
 *
 * - it issues hand-written parameterised SQL, so no Drizzle mapper (whose
 *   `Buffer.isBuffer` call would throw in a Worker without `nodejs_compat`) ever
 *   touches a BLOB;
 * - it binds bytes as an `ArrayBuffer`, the shape a real D1 binding returns;
 * - it normalizes the plain number array a BLOB becomes across a workerd RPC
 *   boundary;
 * - it reads the row count off `meta.changes` to report deletions.
 *
 * Miniflare-backed integration tests still cover the real behaviour; this suite
 * is what keeps the driver's shape from silently regressing.
 */
interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function createFakeD1(
  response: {
    first?: unknown;
    run?: { meta: unknown };
  } = {},
): { database: D1DatabaseLike; statements: RecordedStatement[] } {
  const statements: RecordedStatement[] = [];
  const database: D1DatabaseLike = {
    prepare(sql: string) {
      const record: RecordedStatement = { sql, values: [] };
      statements.push(record);
      const statement: D1PreparedStatementLike = {
        bind(...values: unknown[]) {
          record.values.push(...values);
          return statement;
        },
        async first<T>() {
          return (response.first ?? null) as T | null;
        },
        async run() {
          return response.run ?? { meta: { changes: 0 } };
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
    async exec() {
      return undefined;
    },
  };
  return { database, statements };
}

describe("D1 media object repository: raw statements", () => {
  it("inserts with hand-written parameterised SQL and an ArrayBuffer BLOB", async () => {
    const { database, statements } = createFakeD1();
    const repository = createD1MediaObjectRepository(database);

    const created = await repository.create({
      storageKey: "products/abc/photo.jpg",
      contentType: "image/jpeg",
      bytes: BINARY_BYTES,
      checksum: null,
    });

    expect(statements).toHaveLength(1);
    const insert = statements[0]!;
    expect(insert.sql).toContain("INSERT INTO media_objects");
    // Parameterised, not interpolated: a hostile storage key is bound.
    expect(insert.sql).not.toContain("products/abc/photo.jpg");
    expect(insert.values).toEqual([
      created.id,
      "products/abc/photo.jpg",
      "image/jpeg",
      BINARY_BYTES.byteLength,
      expect.any(ArrayBuffer),
      created.createdAt.getTime(),
      null,
    ]);
    // The BLOB is bound as an ArrayBuffer, never as a Node Buffer.
    expect(Buffer.isBuffer(insert.values[4])).toBe(false);
    expect([...new Uint8Array(insert.values[4] as ArrayBuffer)]).toEqual([...BINARY_BYTES]);
  });

  it("reads a BLOB that arrived as a plain number array", async () => {
    // This is what workerd's RPC layer hands back for a BLOB column; Drizzle's
    // own mapper would not survive it either.
    const { database, statements } = createFakeD1({
      first: {
        id: "01a0de8b-48b4-72de-846b-744e28d8e412",
        storage_key: "products/abc/photo.jpg",
        content_type: "image/jpeg",
        byte_size: BINARY_BYTES.byteLength,
        bytes: [...BINARY_BYTES],
        created_at: 1_700_000_000_000,
        checksum: "deadbeef",
      },
    });
    const repository = createD1MediaObjectRepository(database);

    const found = await repository.findByStorageKey("products/abc/photo.jpg");

    expect(statements[0]!.sql).toContain("FROM media_objects WHERE storage_key = ?");
    expect(statements[0]!.values).toEqual(["products/abc/photo.jpg"]);
    expect(found).toEqual({
      id: "01a0de8b-48b4-72de-846b-744e28d8e412",
      storageKey: "products/abc/photo.jpg",
      contentType: "image/jpeg",
      byteSize: BINARY_BYTES.byteLength,
      bytes: BINARY_BYTES,
      createdAt: new Date(1_700_000_000_000),
      checksum: "deadbeef",
    });
    expect(Object.getPrototypeOf(found!.bytes)).toBe(Uint8Array.prototype);
  });

  it("reads a BLOB that arrived as an ArrayBuffer", async () => {
    const { database } = createFakeD1({
      first: {
        id: "id",
        storage_key: "products/abc/photo.jpg",
        content_type: "image/jpeg",
        byte_size: 2,
        bytes: BINARY_BYTES.buffer,
        created_at: 1_700_000_000_000,
        checksum: null,
      },
    });

    const found = await createD1MediaObjectRepository(database).findById("id");

    expect([...found!.bytes]).toEqual([...BINARY_BYTES]);
  });

  it("reports a delete from meta.changes and treats an unknown count as no deletion", async () => {
    const removed = createFakeD1({ run: { meta: { changes: 1 } } });
    expect(await createD1MediaObjectRepository(removed.database).delete("id")).toBe(true);
    expect(removed.statements[0]!.sql).toBe("DELETE FROM media_objects WHERE id = ?");
    expect(removed.statements[0]!.values).toEqual(["id"]);

    const missing = createFakeD1({ run: { meta: { changes: 0 } } });
    expect(await createD1MediaObjectRepository(missing.database).delete("id")).toBe(false);

    // An unreadable count must not be reported as a successful delete.
    const unknown = createFakeD1({ run: { meta: undefined } });
    expect(await createD1MediaObjectRepository(unknown.database).delete("id")).toBe(false);
  });

  it("returns null for a row D1 does not have", async () => {
    const { database } = createFakeD1({ first: null });
    const repository = createD1MediaObjectRepository(database);

    expect(await repository.findById("missing")).toBeNull();
    expect(await repository.findByStorageKey("missing")).toBeNull();
  });
});

describe("toMediaBytes", () => {
  it("normalizes every driver shape to the same bytes", () => {
    const expected = [0x00, 0x7f, 0x80, 0xff];
    const source = Uint8Array.from(expected);

    expect([...toMediaBytes(source)]).toEqual(expected);
    expect([...toMediaBytes(source.buffer)]).toEqual(expected);
    expect([...toMediaBytes(Buffer.from(source))]).toEqual(expected);
    // The array form is how a D1 BLOB arrives through a workerd RPC boundary.
    expect([...toMediaBytes([...source])]).toEqual(expected);
  });

  it("copies only the view's own window out of a larger buffer", () => {
    const backing = Uint8Array.from([0, 1, 2, 3, 4, 5]);
    const view = backing.subarray(2, 4);

    const bytes = toMediaBytes(view);

    expect([...bytes]).toEqual([2, 3]);
    expect(bytes.byteLength).toBe(2);
  });

  it("never aliases the caller's memory", () => {
    const source = Uint8Array.from([1, 2, 3]);

    const fromArrayBuffer = toMediaBytes(source.buffer);
    const fromView = toMediaBytes(source);
    source.fill(9);

    expect([...fromArrayBuffer]).toEqual([1, 2, 3]);
    expect([...fromView]).toEqual([1, 2, 3]);
  });

  it("fails loudly on a shape it does not recognise", () => {
    // A silent empty-object fallback would write a row that disagrees with the
    // bytes the caller believed it stored.
    expect(() => toMediaBytes(null)).toThrow(TypeError);
    expect(() => toMediaBytes("not bytes")).toThrow(/must be an ArrayBuffer/);
    expect(() => toMediaBytes(42)).toThrow(/must be an ArrayBuffer/);
  });

  it("exposes an ArrayBuffer view that shares no memory with the source", () => {
    const source = Uint8Array.from([4, 5, 6]);
    const buffer = toMediaArrayBuffer(source);

    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(buffer)]).toEqual([4, 5, 6]);
    expect(buffer.byteLength).toBe(3);
  });
});
