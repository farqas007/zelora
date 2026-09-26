import { beforeEach, describe, expect, it } from "vitest";
import type { CreateMediaObjectInput, MediaObjectRecord, MediaObjectRepository } from "@zelora/db/media";
import { createD1MediaStorage } from "./d1";
import { assertMediaObjectSize, type MediaObjectInput } from "./storage";

/**
 * An in-memory `MediaObjectRepository`, so these tests describe the *driver's*
 * behaviour — how it maps a storage key onto rows — rather than re-testing SQL
 * that `packages/db` already covers against real SQLite and D1.
 */
class FakeMediaObjectRepository implements MediaObjectRepository {
  readonly rows: MediaObjectRecord[] = [];
  readonly calls: string[] = [];
  private sequence = 0;

  async create(input: CreateMediaObjectInput): Promise<MediaObjectRecord> {
    this.calls.push(`create:${input.storageKey}`);
    if (this.rows.some((row) => row.storageKey === input.storageKey)) {
      // Matches the real drivers, where the unique index rejects the write.
      throw new Error("UNIQUE constraint failed: media_objects.storage_key");
    }
    const bytes = new Uint8Array(input.bytes as ArrayBuffer);
    this.sequence += 1;
    const record: MediaObjectRecord = {
      id: `id-${this.sequence}`,
      storageKey: input.storageKey,
      contentType: input.contentType,
      byteSize: bytes.byteLength,
      bytes,
      createdAt: new Date(1_700_000_000_000 + this.sequence),
      checksum: input.checksum ?? null,
    };
    this.rows.push(record);
    return record;
  }

  async findById(id: string): Promise<MediaObjectRecord | null> {
    this.calls.push(`findById:${id}`);
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async findByStorageKey(storageKey: string): Promise<MediaObjectRecord | null> {
    this.calls.push(`findByStorageKey:${storageKey}`);
    return this.rows.find((row) => row.storageKey === storageKey) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    this.calls.push(`delete:${id}`);
    const index = this.rows.findIndex((row) => row.id === id);
    if (index === -1) {
      return false;
    }
    this.rows.splice(index, 1);
    return true;
  }
}

function bytesOf(length: number, fill = 0x61): ArrayBuffer {
  return new Uint8Array(length).fill(fill).buffer;
}

const JPEG: MediaObjectInput = { bytes: bytesOf(4, 0xff), contentType: "image/jpeg", size: 4 };

describe("createD1MediaStorage", () => {
  let repository: FakeMediaObjectRepository;
  let storage: ReturnType<typeof createD1MediaStorage>;

  beforeEach(() => {
    repository = new FakeMediaObjectRepository();
    storage = createD1MediaStorage({
      repository,
      publicBaseUrl: "https://media.test",
    });
  });

  it("stores the bytes, the verified content type and the key", async () => {
    await storage.put("products/a.jpg", JPEG);

    expect(repository.rows).toHaveLength(1);
    const [row] = repository.rows;
    expect(row!.storageKey).toBe("products/a.jpg");
    expect(row!.contentType).toBe("image/jpeg");
    expect(row!.byteSize).toBe(4);
    // The byte size is derived from the bytes by the repository, never taken
    // from the caller's `size` field, so it cannot disagree with what is stored.
    expect([...row!.bytes]).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it("rejects a size mismatch before writing a row", async () => {
    await expect(
      storage.put("products/a.jpg", { bytes: bytesOf(3), contentType: "image/jpeg", size: 4 }),
    ).rejects.toThrow(/declares size 4 but carries 3 bytes/);
    expect(repository.rows).toHaveLength(0);
  });

  it("replaces an object already stored at the same key, like R2 and the filesystem", async () => {
    await storage.put("products/a.jpg", JPEG);
    const first = repository.rows[0]!.id;

    await storage.put("products/a.jpg", { bytes: bytesOf(2, 0x62), contentType: "image/jpeg", size: 2 });

    expect(repository.rows).toHaveLength(1);
    // A new row, not a mutated one: objects are immutable, so the previous row
    // (and any product_media rows cascading from it) is gone.
    expect(repository.rows[0]!.id).not.toBe(first);
    expect([...repository.rows[0]!.bytes]).toEqual([0x62, 0x62]);
  });

  it("reads an object back with its bytes and content type", async () => {
    await storage.put("products/a.jpg", JPEG);

    const found = await storage.get("products/a.jpg");

    expect(found).toEqual({ bytes: JPEG.bytes, contentType: "image/jpeg" });
  });

  it("returns a buffer holding exactly the stored bytes", async () => {
    // 70_000 bytes is very likely served out of Node's shared Buffer pool, so
    // a naive `.buffer` hand-off would expose a far larger allocation.
    await storage.put("big.png", { bytes: bytesOf(70_000, 0x41), contentType: "image/png", size: 70_000 });

    const found = await storage.get("big.png");

    expect(found!.bytes.byteLength).toBe(70_000);
    expect(new Uint8Array(found!.bytes)[70_000 - 1]).toBe(0x41);
  });

  it("reports a missing key as null rather than throwing", async () => {
    expect(await storage.get("products/gone.jpg")).toBeNull();
  });

  it("deletes through the resolved row, not the storage key", async () => {
    await storage.put("products/a.jpg", JPEG);
    const id = repository.rows[0]!.id;

    await storage.delete("products/a.jpg");

    expect(repository.calls).toContain(`delete:${id}`);
    expect(repository.rows).toHaveLength(0);
  });

  it("treats deleting a missing key as success, so compensation is safe", async () => {
    await expect(storage.delete("never/existed.jpg")).resolves.toBeUndefined();
    // Nothing to delete, so no row delete is attempted at all.
    expect(repository.calls).toEqual(["findByStorageKey:never/existed.jpg"]);
  });

  it("builds the public URL from the configured base", () => {
    const withSlash = createD1MediaStorage({ repository, publicBaseUrl: "https://media.test/" });

    expect(withSlash.publicUrl("products/a.jpg")).toBe("https://media.test/products/a.jpg");
  });

  it("shares the size assertion with every other driver", () => {
    // The invariant is enforced by the port, so a driver cannot be swapped in
    // without inheriting it.
    expect(() =>
      assertMediaObjectSize("k", { bytes: bytesOf(2), contentType: "image/png", size: 3 }),
    ).toThrow(/declares size 3 but carries 2 bytes/);
  });
});
