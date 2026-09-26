import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMediaObjectSize,
  createUnavailableMediaStorage,
  joinMediaPublicUrl,
  type MediaObjectInput,
} from "./storage";
import { createR2MediaStorage, type R2BucketLike, type R2PutOptionsLike } from "./r2";
import { createLocalFileMediaStorage, resolveMediaPath } from "./local-fs";

/** Allocate a real `ArrayBuffer` so `byteLength` is genuinely observable. */
function bytesOf(length: number, fill = 0x61): ArrayBuffer {
  return new Uint8Array(length).fill(fill).buffer;
}

const JPEG: MediaObjectInput = {
  bytes: bytesOf(4),
  contentType: "image/jpeg",
  size: 4,
};

describe("joinMediaPublicUrl", () => {
  it("joins with exactly one separator", () => {
    expect(joinMediaPublicUrl("https://media.test", "products/a.jpg")).toBe(
      "https://media.test/products/a.jpg",
    );
  });

  it("collapses trailing slashes on the base and leading slashes on the key", () => {
    expect(joinMediaPublicUrl("https://media.test///", "///products/a.jpg")).toBe(
      "https://media.test/products/a.jpg",
    );
  });
});

describe("assertMediaObjectSize", () => {
  it("accepts a size that matches the buffer", () => {
    expect(() => assertMediaObjectSize("k", { bytes: bytesOf(9), contentType: "image/png", size: 9 })).not.toThrow();
  });

  it("rejects a size that disagrees with the buffer", () => {
    // A mismatch means the caller's row would permanently disagree with the
    // stored object, so it must fail before anything is written.
    expect(() =>
      assertMediaObjectSize("k", { bytes: bytesOf(9), contentType: "image/png", size: 10 }),
    ).toThrow(/declares size 10 but carries 9 bytes/);
  });
});

describe("createUnavailableMediaStorage", () => {
  const storage = createUnavailableMediaStorage("MEDIA_PUBLIC_BASE_URL is not set");

  it("fails closed on put", async () => {
    await expect(storage.put("k", JPEG)).rejects.toThrow(/not configured/);
  });

  it("fails closed on delete", async () => {
    await expect(storage.delete("k")).rejects.toThrow(/not configured/);
  });

  it("fails closed on publicUrl rather than returning a dead URL", () => {
    expect(() => storage.publicUrl("k")).toThrow(/not configured/);
  });
});

describe("createR2MediaStorage", () => {
  interface R2Call {
    key: string;
    bytes: ArrayBuffer;
    options: R2PutOptionsLike | undefined;
  }

  let puts: R2Call[];
  let deletes: string[];
  let bucket: R2BucketLike;

  beforeEach(() => {
    puts = [];
    deletes = [];
    bucket = {
      async put(key, bytes, options) {
        puts.push({ key, bytes, options });
        return { key };
      },
      async delete(key) {
        deletes.push(key);
      },
    };
  });

  it("forwards the verified content type as storage HTTP metadata", async () => {
    const storage = createR2MediaStorage({ bucket, publicBaseUrl: "https://media.test" });

    await storage.put("products/a.jpg", JPEG);

    // Without this, R2 serves application/octet-stream and browsers refuse to
    // render the object in an <img> tag.
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe("products/a.jpg");
    expect(puts[0]?.options).toEqual({ httpMetadata: { contentType: "image/jpeg" } });
    expect(puts[0]?.bytes).toBe(JPEG.bytes);
  });

  it("rejects a size mismatch before touching the bucket", async () => {
    const storage = createR2MediaStorage({ bucket, publicBaseUrl: "https://media.test" });

    await expect(
      storage.put("products/a.jpg", { bytes: bytesOf(3), contentType: "image/jpeg", size: 4 }),
    ).rejects.toThrow(/declares size 4 but carries 3 bytes/);
    expect(puts).toEqual([]);
  });

  it("builds the public URL from the configured base", () => {
    const storage = createR2MediaStorage({ bucket, publicBaseUrl: "https://media.test/" });

    expect(storage.publicUrl("products/a.jpg")).toBe("https://media.test/products/a.jpg");
  });

  it("delegates delete and relies on R2 for absent-key idempotency", async () => {
    const storage = createR2MediaStorage({ bucket, publicBaseUrl: "https://media.test" });

    await storage.delete("products/gone.jpg");

    expect(deletes).toEqual(["products/gone.jpg"]);
  });
});

describe("createLocalFileMediaStorage", () => {
  let root: string;
  let storage: ReturnType<typeof createLocalFileMediaStorage>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zelora-media-"));
    storage = createLocalFileMediaStorage({ root, publicBaseUrl: "https://media.test" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the exact bytes to a nested key, creating parent directories", async () => {
    const object: MediaObjectInput = { bytes: bytesOf(5, 0x7a), contentType: "image/png", size: 5 };

    await storage.put("products/abc/0123.png", object);

    expect(await readFile(join(root, "products/abc/0123.png"))).toEqual(
      Buffer.from(object.bytes),
    );
  });

  it("overwrites an existing object at the same key, matching R2 put semantics", async () => {
    await writeFile(join(root, "a.jpg"), "stale");
    const object: MediaObjectInput = { bytes: bytesOf(3, 0x62), contentType: "image/jpeg", size: 3 };

    await storage.put("a.jpg", object);

    expect(await readFile(join(root, "a.jpg"))).toEqual(Buffer.from(object.bytes));
  });

  it("rejects a size mismatch before writing anything", async () => {
    await expect(
      storage.put("a.jpg", { bytes: bytesOf(3), contentType: "image/jpeg", size: 4 }),
    ).rejects.toThrow(/declares size 4 but carries 3 bytes/);
    expect(await readFile(join(root, "a.jpg")).catch(() => "absent")).toBe("absent");
  });

  it("removes an existing object", async () => {
    await storage.put("a.jpg", JPEG);

    await storage.delete("a.jpg");

    expect(await readFile(join(root, "a.jpg")).catch(() => "absent")).toBe("absent");
  });

  it("treats deleting a missing object as success, so compensation is safe", async () => {
    await expect(storage.delete("never/existed.jpg")).resolves.toBeUndefined();
  });

  it("builds the public URL from the configured base", () => {
    expect(storage.publicUrl("products/a.jpg")).toBe("https://media.test/products/a.jpg");
  });
});

describe("resolveMediaPath", () => {
  const root = "/srv/media";

  it("resolves a plain nested key inside the root", () => {
    expect(resolveMediaPath(root, "products/a.jpg")).toBe("/srv/media/products/a.jpg");
  });

  it("resolves a deeply nested key inside the root", () => {
    expect(resolveMediaPath(root, "products/abc/0123/def.jpg")).toBe(
      "/srv/media/products/abc/0123/def.jpg",
    );
  });

  it("allows a bare filename in the root", () => {
    expect(resolveMediaPath(root, "a.jpg")).toBe("/srv/media/a.jpg");
  });

  // POSIX-style escapes: the original protection, kept intact.
  it.each([
    ["parent traversal", "../secrets.env"],
    ["nested parent traversal", "products/../../secrets.env"],
    ["absolute path", "/etc/passwd"],
    ["the root itself", ""],
  ])("rejects %s", (_name, key) => {
    // Keys are server-generated, but a driver that trusts its caller would let
    // a single crafted key write outside the media root.
    expect(() => resolveMediaPath(root, key)).toThrow(/outside the media root/);
  });

  // Windows-style escapes. `relative()` emits the host separator, so a
  // `"../"` prefix check would miss these on a Windows host; the segment rule
  // must reject them on every host, including POSIX, where `resolve` would
  // otherwise treat the backslash as an ordinary filename character.
  it.each([
    ["windows parent traversal", "..\\secret.txt"],
    ["windows nested parent traversal", "products\\..\\..\\secret.txt"],
    ["windows trailing traversal", "products\\.."],
    ["windows absolute path", "C:\\Windows\\system32\\config\\SAM"],
    ["windows UNC path", "\\\\server\\share\\file.jpg"],
  ])("rejects %s", (_name, key) => {
    expect(() => resolveMediaPath(root, key)).toThrow(/outside the media root/);
  });

  it("still allows backslashes that do not form a traversal", () => {
    // The rule rejects `..` segments, not backslashes outright, so an unusual
    // but harmless key is not rejected for the wrong reason.
    const resolved = resolveMediaPath(root, "products\\a.jpg");
    expect(resolved.startsWith(root)).toBe(true);
  });
});
