import { describe, expect, it } from "vitest";
import type { ProductImageContentType } from "@zelora/shared";
import { PRODUCT_IMAGE_LIMITS } from "@zelora/shared";
import { buildProductImageStorageKey, isProductImageStorageKey } from "./storage-key";

/**
 * Unit tests for the product-scoped, content-addressed storage key.
 *
 * The key is the platform's public addressing scheme (it becomes a URL), so the
 * properties asserted here are security properties: it is derived only from
 * server-side inputs, it is stable for identical bytes, and it is scoped so two
 * products can never address each other's object.
 */

const PRODUCT_ID = "01955f00-0000-7000-8000-000000000001";
const OTHER_PRODUCT_ID = "01955f00-0000-7000-8000-000000000002";

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function pngBytes(seed = 0): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    ...ascii("IHDR"),
    0x00, 0x00, 0x00, 0x10, seed & 0xff,
  ]);
}

function jpegBytes(seed = 0): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), seed & 0xff, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00,
    0x01, 0x00, 0x00, 0x00,
  ]);
}

function webpBytes(): Uint8Array {
  return Uint8Array.from([
    ...ascii("RIFF"), 0x1a, 0x00, 0x00, 0x00, ...ascii("WEBP"), ...ascii("VP8 "), 0x0c, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

function avifBytes(): Uint8Array {
  return Uint8Array.from([
    0x00, 0x00, 0x00, 0x20,
    ...ascii("ftyp"),
    ...ascii("avif"),
    0x00, 0x00, 0x00, 0x00,
    ...ascii("avif"),
    ...ascii("mif1"),
    0x00, 0x00, 0x00, 0x00,
  ]);
}

const KEYS = {
  "image/jpeg": { bytes: jpegBytes(), extension: "jpg" },
  "image/png": { bytes: pngBytes(), extension: "png" },
  "image/webp": { bytes: webpBytes(), extension: "webp" },
  "image/avif": { bytes: avifBytes(), extension: "avif" },
} as const satisfies Record<ProductImageContentType, { bytes: Uint8Array; extension: string }>;

describe("buildProductImageStorageKey", () => {
  it("addresses the object as products/<productId>/<sha256>.<ext>", async () => {
    const key = await buildProductImageStorageKey(PRODUCT_ID, "image/png", pngBytes());

    expect(key).toMatch(
      new RegExp(
        `^products/${PRODUCT_ID}/[0-9a-f]{64}\\.png$`,
      ),
    );
  });

  it("uses a full 64-character lowercase hex SHA-256 digest", async () => {
    const key = await buildProductImageStorageKey(PRODUCT_ID, "image/png", pngBytes());
    const digest = key.split("/")[2]?.split(".")[0] ?? "";

    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("picks the extension from the sniffed content type, not from the bytes' filename", async () => {
    // The same bytes keyed as two different types must produce two different
    // extensions: the type is the caller's *verified* claim, and the extension is
    // that claim made visible. The builder trusts it because the service only
    // ever passes a sniffed value.
    const jpegKey = await buildProductImageStorageKey(PRODUCT_ID, "image/jpeg", jpegBytes());
    const pngKey = await buildProductImageStorageKey(PRODUCT_ID, "image/png", pngBytes());
    const webpKey = await buildProductImageStorageKey(PRODUCT_ID, "image/webp", webpBytes());
    const avifKey = await buildProductImageStorageKey(PRODUCT_ID, "image/avif", avifBytes());

    expect(jpegKey.endsWith(".jpg")).toBe(true);
    expect(pngKey.endsWith(".png")).toBe(true);
    expect(webpKey.endsWith(".webp")).toBe(true);
    expect(avifKey.endsWith(".avif")).toBe(true);
  });

  it("covers every supported content type", async () => {
    for (const [contentType, fixture] of Object.entries(KEYS)) {
      const key = await buildProductImageStorageKey(
        PRODUCT_ID,
        contentType as ProductImageContentType,
        fixture.bytes,
      );

      expect(key).toBe(`products/${PRODUCT_ID}/${(await digestOf(fixture.bytes))}.${fixture.extension}`);
    }
  });

  it("scopes the key by product, so identical bytes in two products never collide", async () => {
    // The decision this key scheme exists for: a globally content-addressed key
    // would give both products one key, and because `put` replaces, the second
    // upload would evict the first product's stored object.
    const bytes = pngBytes();
    const first = await buildProductImageStorageKey(PRODUCT_ID, "image/png", bytes);
    const second = await buildProductImageStorageKey(OTHER_PRODUCT_ID, "image/png", bytes);

    expect(first).not.toBe(second);
    // Same digest, different prefix: the bytes are addressed identically, the
    // product is not.
    expect(first.split("/")[2]).toBe(second.split("/")[2]);
    expect(first.split("/")[1]).toBe(PRODUCT_ID);
    expect(second.split("/")[1]).toBe(OTHER_PRODUCT_ID);
  });

  it("is deterministic for the same bytes and product, so a re-upload is idempotent", async () => {
    const bytes = pngBytes();

    expect(await buildProductImageStorageKey(PRODUCT_ID, "image/png", bytes)).toBe(
      await buildProductImageStorageKey(PRODUCT_ID, "image/png", bytes),
    );
  });

  it("gives different bytes of the same product different keys", async () => {
    const first = await buildProductImageStorageKey(PRODUCT_ID, "image/png", pngBytes(1));
    const second = await buildProductImageStorageKey(PRODUCT_ID, "image/png", pngBytes(2));

    expect(first).not.toBe(second);
  });

  it("digests a subarray by its own window, not the whole parent buffer", async () => {
    // A caller that hands over a slice of a larger read buffer means the slice;
    // digesting the parent would key the object by bytes that are not being
    // stored under it.
    const png = pngBytes();
    const parent = new Uint8Array(64);
    parent.set(png, 16);
    const slice = parent.subarray(16, 16 + png.byteLength);

    const key = await buildProductImageStorageKey(PRODUCT_ID, "image/png", slice);

    expect(key).toBe(`products/${PRODUCT_ID}/${await digestOf(png)}.png`);
  });

  it("matches the SHA-256 of the exact bytes, so the key is a verifiable claim", async () => {
    const bytes = jpegBytes(7);

    const key = await buildProductImageStorageKey(PRODUCT_ID, "image/jpeg", bytes);

    expect(key).toBe(`products/${PRODUCT_ID}/${await digestOf(bytes)}.jpg`);
  });

  it("hashes a payload at the enforced size limit without difficulty", async () => {
    const large = new Uint8Array(PRODUCT_IMAGE_LIMITS.maxBytesPerFile);
    large.set(pngBytes());

    const key = await buildProductImageStorageKey(PRODUCT_ID, "image/png", large);

    expect(key).toBe(`products/${PRODUCT_ID}/${await digestOf(large)}.png`);
  });

  it("is exactly three path segments, with the digest as the only variable part", async () => {
    // `productId` is trusted as server-generated (the service validates it as a
    // UUID before ever calling this), so the key's shape is asserted against a
    // well-formed id: `products` / the product / the addressed object.
    const key = await buildProductImageStorageKey(PRODUCT_ID, "image/png", pngBytes());

    expect(key.split("/")).toHaveLength(3);
    expect(key.split("/")[0]).toBe("products");
    expect(key.split("/")[1]).toBe(PRODUCT_ID);
  });

  it("contains no client-supplied text, so nothing guessable is published", async () => {
    const key = await buildProductImageStorageKey(PRODUCT_ID, "image/png", pngBytes());

    expect(key).not.toContain(" ");
    expect(key).not.toContain("..");
    expect(key.split("/")).toHaveLength(3);
  });
});

/** Hex SHA-256 of `bytes`, computed independently of the module under test. */
async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

describe("isProductImageStorageKey", () => {
  /** A key the builder itself produced, for the four issued extensions. */
  async function builtKey(contentType: ProductImageContentType): Promise<string> {
    return buildProductImageStorageKey(PRODUCT_ID, contentType, KEYS[contentType].bytes);
  }

  it("accepts every key the builder can emit, for every supported type", async () => {
    for (const contentType of Object.keys(KEYS) as ProductImageContentType[]) {
      const key = await builtKey(contentType);

      // The round trip is the whole point: the predicate is the exact inverse of
      // the builder, so anything the platform can store, the public read path can
      // address.
      expect(isProductImageStorageKey(key), key).toBe(true);
    }
  });

  it("accepts a key whose digest is any lowercase hex of the right length", async () => {
    for (const digest of ["0".repeat(64), "f".repeat(64), "0123456789abcdef".repeat(4)]) {
      expect(isProductImageStorageKey(`products/${PRODUCT_ID}/${digest}.webp`)).toBe(true);
    }
  });

  it("refuses anything that is not exactly products/<uuidv7>/<64 hex>.<issued ext>", () => {
    const digest = "a".repeat(64);
    const refused = [
      // Segment count.
      "",
      "products",
      `products/${PRODUCT_ID}`,
      `products/${PRODUCT_ID}/${digest}.png/extra`,
      `${digest}.png`,
      // Prefix other than the media namespace, so a key from another part of the
      // store cannot be addressed through this route.
      `admin/${PRODUCT_ID}/${digest}.png`,
      `uploads/${PRODUCT_ID}/${digest}.png`,
      `Products/${PRODUCT_ID}/${digest}.png`,
      // Product id: a valid-looking UUID that is not v7, and a non-id at all.
      `products/01955f00-0000-4000-8000-000000000001/${digest}.png`,
      `products/01955f00-0000-7000-c000-000000000001/${digest}.png`,
      `products/01955f00-0000-7000-8000-00000000000/${digest}.png`,
      `products/01955f00-0000-7000-8000-00000000000Z/${digest}.png`,
      `products/01955F00-0000-7000-8000-000000000001/${digest}.png`,
      `products/not-a-uuid/${digest}.png`,
      `products//${digest}.png`,
      `products/../${digest}.png`,
      // Digest: wrong length, not hex, and uppercase.
      `products/${PRODUCT_ID}/.png`,
      `products/${PRODUCT_ID}/.png.png`,
      `products/${PRODUCT_ID}/${digest}.`,
      `products/${PRODUCT_ID}/${digest.slice(0, 63)}.png`,
      `products/${PRODUCT_ID}/${digest}a.png`,
      `products/${PRODUCT_ID}${"a".repeat(64)}.png`,
      `products/${PRODUCT_ID}/${"A".repeat(64)}.png`,
      `products/${PRODUCT_ID}/${"g".repeat(64)}.png`,
      `products/${PRODUCT_ID}/${"-".repeat(64)}.png`,
      // Extension: not one the platform issues, and a client-chosen one that
      // would let arbitrary bytes be served as an image.
      `products/${PRODUCT_ID}/${digest}.svg`,
      `products/${PRODUCT_ID}/${digest}.gif`,
      `products/${PRODUCT_ID}/${digest}.exe`,
      `products/${PRODUCT_ID}/${digest}.png.png`,
      `products/${PRODUCT_ID}/${digest}.PNG`,
      `products/${PRODUCT_ID}/${digest}`,
      // Traversal and encodings of it: refused structurally, never rewritten.
      `products/${PRODUCT_ID}/../../etc/passwd.png`,
      `products/../../etc/${digest}.png`,
      `products/${PRODUCT_ID}..%2f..%2fetc/${digest}.png`,
      "products\\" + PRODUCT_ID + "\\" + digest + ".png",
      `products/${PRODUCT_ID}/${digest}.png `,
    ];

    for (const value of refused) {
      expect(isProductImageStorageKey(value), `expected ${JSON.stringify(value)} to be refused`).toBe(false);
    }
  });
});
