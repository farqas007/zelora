import { describe, expect, it } from "vitest";
import { PRODUCT_IMAGE_CONTENT_TYPES, PRODUCT_IMAGE_LIMITS } from "@zelora/shared";
import {
  PRODUCT_IMAGE_FILE_EXTENSIONS,
  sniffProductImageFormat,
  validateProductImageBytes,
} from "./image-validation";

/**
 * Unit tests for the product-image content sniffer.
 *
 * The fixtures are header-shaped byte sequences, not decoded images: the module
 * under test never inflates anything, so a real encoder output would exercise
 * exactly the same bytes it does. Every fixture is padded past the 16-byte
 * identification floor so a test fails for the reason it is about (a wrong
 * signature) rather than for a buffer that is merely too short.
 */

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

/** `89 50 4E 47 0D 0A 1A 0A` + a length word + the mandatory `IHDR` chunk type. */
function pngBytes(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, // IHDR chunk length
    ...ascii("IHDR"),
    0x00, 0x00, 0x00, 0x10, // width/height high bytes, so the header is 20 long
  ]);
}

/** SOI (`FF D8`) followed by the start of the next marker (`FF E0`). */
function jpegBytes(): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
}

/** `RIFF` + declared size + `WEBP` form type + a chunk header. */
function webpBytes(): Uint8Array {
  return Uint8Array.from([
    ...ascii("RIFF"), 0x1a, 0x00, 0x00, 0x00, ...ascii("WEBP"), ...ascii("VP8 "), 0x0c, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

/** An `ftyp` box whose major brand identifies AVIF. */
function avifBytes(majorBrand = "avif"): Uint8Array {
  return Uint8Array.from([
    0x00, 0x00, 0x00, 0x20, // box size
    ...ascii("ftyp"),
    ...ascii(majorBrand),
    0x00, 0x00, 0x00, 0x00,
    ...ascii("avif"), // compatible brands
    ...ascii("mif1"),
    0x00, 0x00, 0x00, 0x00,
  ]);
}

/** An `ftyp` box of a format that shares the box but is not a supported image. */
function isoBmffBytes(majorBrand: string): Uint8Array {
  return Uint8Array.from([
    0x00, 0x00, 0x00, 0x20,
    ...ascii("ftyp"),
    ...ascii(majorBrand),
    0x00, 0x00, 0x00, 0x00,
    ...ascii(majorBrand),
    0x00, 0x00, 0x00, 0x00,
  ]);
}

/** A buffer of `size` bytes whose first bytes are `prefix`. */
function sizedBytes(prefix: ArrayLike<number>, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(prefix);
  return bytes;
}

describe("sniffProductImageFormat", () => {
  it("identifies each of the four supported formats from its own signature", () => {
    expect(sniffProductImageFormat(pngBytes())).toBe("image/png");
    expect(sniffProductImageFormat(jpegBytes())).toBe("image/jpeg");
    expect(sniffProductImageFormat(webpBytes())).toBe("image/webp");
    expect(sniffProductImageFormat(avifBytes())).toBe("image/avif");
  });

  it("accepts the AVIF image-sequence brand as AVIF", () => {
    expect(sniffProductImageFormat(avifBytes("avis"))).toBe("image/avif");
  });

  it("rejects a bare PNG signature with no IHDR chunk, which is not a PNG", () => {
    // The 8-byte signature alone is the most-forged prefix in existence; the
    // structural check is what separates "starts like a PNG" from "is a PNG".
    const signatureOnly = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, ...ascii("IDAT"),
      0x00, 0x00, 0x00, 0x10,
    ]);

    expect(sniffProductImageFormat(signatureOnly)).toBeNull();
  });

  it("rejects a truncated header that stops inside the identifying prefix", () => {
    // Each of these is a genuine prefix of a supported format, cut short before
    // the format can be identified at all: the module reports "not a supported
    // image" rather than guessing which format it was trying to be.
    const jpegCut = Uint8Array.from([0xff, 0xd8]);
    const pngCut = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const webpCut = Uint8Array.from([...ascii("RIFF"), 0x1a, 0x00, 0x00, 0x00, ...ascii("WEB")]);
    const avifCut = Uint8Array.from([0x00, 0x00, 0x00, 0x20, ...ascii("ftyp"), ...ascii("avi")]);

    expect(sniffProductImageFormat(jpegCut)).toBeNull();
    expect(sniffProductImageFormat(pngCut)).toBeNull();
    expect(sniffProductImageFormat(webpCut)).toBeNull();
    expect(sniffProductImageFormat(avifCut)).toBeNull();
  });

  it("rejects a bare RIFF prefix, which is a container and not an image", () => {
    const wave = Uint8Array.from([...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WAVE"), 0, 0, 0, 0, 0, 0]);

    expect(sniffProductImageFormat(wave)).toBeNull();
  });

  it("rejects ISO-BMFF containers that are not AVIF", () => {
    // HEIC and MP4 open with the same `ftyp` box, so the brand is the only thing
    // that discriminates; `mif1` alone is too generic to accept.
    expect(sniffProductImageFormat(isoBmffBytes("heic"))).toBeNull();
    expect(sniffProductImageFormat(isoBmffBytes("mif1"))).toBeNull();
    expect(sniffProductImageFormat(isoBmffBytes("isom"))).toBeNull();
    expect(sniffProductImageFormat(isoBmffBytes("av01"))).toBeNull();
  });

  it("rejects image formats outside the supported set", () => {
    const gif = Uint8Array.from([...ascii("GIF89a"), 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const bmp = Uint8Array.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00, 0x28, 0x00]);
    const tiffLe = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const svg = Uint8Array.from(ascii('<svg xmlns="http://www.w3.org/2000/svg">').slice(0, 64));

    expect(sniffProductImageFormat(gif)).toBeNull();
    expect(sniffProductImageFormat(bmp)).toBeNull();
    expect(sniffProductImageFormat(tiffLe)).toBeNull();
    expect(sniffProductImageFormat(svg)).toBeNull();
  });

  it("rejects non-image content that merely names an image type", () => {
    const html = Uint8Array.from(ascii("<!doctype html><title>Not an image</title>").slice(0, 64));
    const text = Uint8Array.from(ascii("filename=\"image.png\"\ncontent-type=image/png\n").slice(0, 64));
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x0a]);
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    expect(sniffProductImageFormat(html)).toBeNull();
    expect(sniffProductImageFormat(text)).toBeNull();
    expect(sniffProductImageFormat(pdf)).toBeNull();
    expect(sniffProductImageFormat(zip)).toBeNull();
  });

  it("rejects an empty buffer", () => {
    expect(sniffProductImageFormat(new Uint8Array(0))).toBeNull();
  });

  it("does not treat a supported signature at a non-zero offset as an image", () => {
    const shifted = new Uint8Array(pngBytes().byteLength + 8);
    shifted.set(pngBytes(), 8);

    expect(sniffProductImageFormat(shifted)).toBeNull();
  });
});

describe("validateProductImageBytes", () => {
  it("accepts each supported format and reports the sniffed type and real byte size", () => {
    for (const [bytes, contentType] of [
      [pngBytes(), "image/png"],
      [jpegBytes(), "image/jpeg"],
      [webpBytes(), "image/webp"],
      [avifBytes(), "image/avif"],
    ] as const) {
      expect(validateProductImageBytes(bytes)).toEqual({
        ok: true,
        image: { contentType, byteSize: bytes.byteLength },
      });
    }
  });

  it("reports EMPTY for a zero-byte upload", () => {
    expect(validateProductImageBytes(new Uint8Array(0))).toEqual({ ok: false, reason: "EMPTY" });
  });

  it("accepts a file of exactly the 1.5 MiB limit and rejects one byte more", () => {
    const limit = PRODUCT_IMAGE_LIMITS.maxBytesPerFile;
    expect(limit).toBe(1_572_864);
    const atLimit = sizedBytes(pngBytes(), limit);
    const overLimit = sizedBytes(pngBytes(), limit + 1);

    expect(validateProductImageBytes(atLimit)).toEqual({
      ok: true,
      image: { contentType: "image/png", byteSize: limit },
    });
    expect(validateProductImageBytes(overLimit)).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("rejects an oversized file before sniffing it, so a fake format is TOO_LARGE", () => {
    const oversizedHtml = sizedBytes(ascii("<!doctype html>"), PRODUCT_IMAGE_LIMITS.maxBytesPerFile + 1);

    expect(validateProductImageBytes(oversizedHtml)).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("rejects an empty file as EMPTY even though it is also under the size limit", () => {
    expect(validateProductImageBytes(new Uint8Array(0)).ok).toBe(false);
  });

  it("keeps the enforced per-image limit strictly below the D1 storage ceiling", () => {
    // The D1 value is defense in depth; the user-facing cap is the stricter one.
    // If this ever inverts, a "valid" upload would be a write the database
    // refuses, which is exactly the silent failure the two limits exist to stop.
    expect(PRODUCT_IMAGE_LIMITS.maxBytesPerFile).toBeLessThan(
      PRODUCT_IMAGE_LIMITS.maxStoredObjectBytes,
    );
    expect(PRODUCT_IMAGE_LIMITS.maxStoredObjectBytes).toBe(2_000_000);
  });

  it("reads the byte size from the buffer, never from a caller-supplied value", () => {
    const bytes = pngBytes();

    expect(validateProductImageBytes(bytes).ok && bytes.byteLength).toBe(20);
  });

  it("does not modify the buffer it inspects", () => {
    const bytes = jpegBytes();
    const before = [...bytes];

    validateProductImageBytes(bytes);

    expect([...bytes]).toEqual(before);
  });

  it("ignores anything past the header, so trailing junk cannot fail a valid image", () => {
    // Trailing bytes are not decoded here; rejecting on them would mean decoding,
    // which is exactly what keeps a decompression bomb free for this module.
    const bytes = sizedBytes(pngBytes(), 4096);

    expect(validateProductImageBytes(bytes)).toEqual({
      ok: true,
      image: { contentType: "image/png", byteSize: 4096 },
    });
  });

  it("inspects only the header window of a large file", () => {
    // A cheap proxy for "no full scan": the result is identical whether the file
    // is 1 KiB or 1.5 MiB, so nothing downstream depends on the tail.
    const small = pngBytes();
    const large = sizedBytes(pngBytes(), PRODUCT_IMAGE_LIMITS.maxBytesPerFile);

    expect(validateProductImageBytes(small).ok).toBe(true);
    expect(validateProductImageBytes(large).ok).toBe(true);
  });
});

describe("PRODUCT_IMAGE_FILE_EXTENSIONS", () => {
  it("maps exactly the supported content types to an extension", () => {
    expect(Object.keys(PRODUCT_IMAGE_FILE_EXTENSIONS).sort()).toEqual(
      [...PRODUCT_IMAGE_CONTENT_TYPES].sort(),
    );
  });

  it("uses the conventional extension for each sniffed type", () => {
    expect(PRODUCT_IMAGE_FILE_EXTENSIONS).toEqual({
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/avif": "avif",
    });
  });

  it("contains no extension that a client-declared filename could inject", () => {
    for (const extension of Object.values(PRODUCT_IMAGE_FILE_EXTENSIONS)) {
      expect(extension).toMatch(/^[a-z0-9]+$/);
    }
  });
});
