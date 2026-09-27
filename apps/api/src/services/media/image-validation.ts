import { PRODUCT_IMAGE_LIMITS, type ProductImageContentType } from "@zelora/shared";

/**
 * Content sniffing for seller-uploaded product images.
 *
 * The rule this module exists to enforce is simple: **the bytes decide what the
 * file is.** A `Content-Type` header, a filename and a `File.type` value are all
 * client-controlled, so accepting them would let a seller store arbitrary bytes
 * under an image URL — the browser would then be asked to render them as an
 * image, which is exactly the request-smuggling/cross-site-content-injection
 * shape media endpoints are attacked with. The sniffed result is therefore the
 * only type that ever reaches storage.
 *
 * What "sniffing" means here, precisely:
 *
 * - **Signature only, never decoding.** Each format is recognised by the magic
 *   bytes at a fixed offset, plus the minimum structural evidence that a real
 *   encoder of that format always emits. Nothing here inflates, decodes or
 *   re-encodes an image, so a decompression bomb costs the attacker nothing and
 *   costs this module no CPU beyond the first few dozen bytes.
 * - **Signature plus minimum length, so truncation is rejected.** A prefix of a
 *   real header is not an image: an 8-byte "PNG" with no `IHDR` chunk type and a
 *   bare `RIFF` prefix are both rejected, because the structural check is part
 *   of the signature rather than an afterthought.
 * - **A closed set of four formats.** JPEG, PNG, WebP and AVIF. Everything else
 *   — including every other ISO-BMFF container that shares AVIF's `ftyp` box —
 *   is rejected, so "the bytes are some kind of file we do not understand"
 *   never becomes "the bytes are an image".
 *
 * Edge-compatible by construction: no `node:` import, no `Buffer`, no DOM
 * `File`/`Blob` dependency. It runs unchanged in the Cloudflare Worker bundle,
 * which is enforced by `scripts/check-worker-bundle.mjs`.
 */

/** Why a candidate image was rejected. Internal: the service maps these to error codes. */
export type ProductImageRejectionReason = "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_FORMAT";

/**
 * A validated image: its verified content type and the number of bytes that
 * were actually inspected and will be stored.
 *
 * `byteSize` is `bytes.byteLength` by construction rather than a value the
 * caller supplied, so a recorded size can never disagree with the bytes — the
 * same property `media_objects_byte_size_matches_bytes` enforces in SQL.
 */
export interface ValidatedProductImage {
  contentType: ProductImageContentType;
  byteSize: number;
}

export type ProductImageValidationResult =
  | { ok: true; image: ValidatedProductImage }
  | { ok: false; reason: ProductImageRejectionReason };

/**
 * File extension per verified content type, used to build a storage key.
 *
 * Driven by the *sniffed* type, never by the uploaded filename, so a stored
 * object's extension is a claim the bytes already back. `.jpg` rather than
 * `.jpeg` because it is the shorter, near-universally supported form for
 * `image/jpeg`, and it is the one a `Content-Disposition: filename` fallback
 * would produce anyway.
 */
export const PRODUCT_IMAGE_FILE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
} as const satisfies Record<ProductImageContentType, string>;

/** Byte prefix every PNG starts with: the 8-byte signature, then `IHDR`. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** JPEG: SOI marker `FF D8` followed by the start of any subsequent marker `FF`. */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

/** ASCII `"RIFF"` (WebP container) and `"WEBP"` (its form type), as byte values. */
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const;

/** ASCII `"IHDR"`, the mandatory first chunk of every PNG. */
const PNG_IHDR_SIGNATURE = [0x49, 0x48, 0x44, 0x52] as const;

/** ASCII `"ftyp"`, the box type every ISO base media file (AVIF, HEIC, MP4…) opens with. */
const FTYP_SIGNATURE = [0x66, 0x74, 0x79, 0x70] as const;

/**
 * Brand values that identify AVIF. The major brand (offset 8) is checked first;
 * `avis` is AVIF's image-sequence variant. `mif1`/`msf1` are *not* included:
 * they are generic "image" brands shared with HEIF stills, so a file branded
 * `mif1` is only accepted when `avif`/`avis` also appears in its compatible-brand
 * list, which is the only evidence that it really is AVIF.
 */
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * Upper bound on the compatible-brand scan, in bytes.
 *
 * The brand list is bounded by the `ftyp` box's own declared size, and a real
 * AVIF's list is a handful of four-byte brands. 64 bytes is far more than any
 * encoder needs and far less than an attacker could use to turn this into a
 * linear scan of a 1.5 MiB buffer.
 */
const AVIF_BRAND_SCAN_LIMIT = 64;

/**
 * Smallest byte length from which each format can be identified at all:
 * 3 (`FF D8 FF`), 16 (8-byte PNG signature + length + `"IHDR"`), 12
 * (`"RIFF"` + length + `"WEBP"`) and 16 (`size` + `"ftyp"` + major brand).
 * Anything shorter cannot carry a valid header of that format.
 */
const MIN_FORMAT_BYTES = 16;

/** Read `count` bytes at `offset`, or `null` when the buffer is too short. */
function readAscii(bytes: Uint8Array, offset: number, count: number): string | null {
  if (offset < 0 || offset + count > bytes.byteLength) {
    return null;
  }
  let text = "";
  for (let index = offset; index < offset + count; index += 1) {
    text += String.fromCharCode(bytes[index] as number);
  }
  return text;
}

/** Whether the buffer starts with `signature`. */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) {
    return false;
  }
  return signature.every((value, index) => bytes[index] === value);
}

function isPng(bytes: Uint8Array): boolean {
  // The 8-byte signature alone is also how a bare signature-only blob starts,
  // so `IHDR` at offset 12 is required too: every PNG encoder writes it first.
  return startsWith(bytes, PNG_SIGNATURE) && readAscii(bytes, 12, 4) === asciiOf(PNG_IHDR_SIGNATURE);
}

function isJpeg(bytes: Uint8Array): boolean {
  return startsWith(bytes, JPEG_SIGNATURE);
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    readAscii(bytes, 0, 4) === asciiOf(RIFF_SIGNATURE) &&
    readAscii(bytes, 8, 4) === asciiOf(WEBP_SIGNATURE)
  );
}

/**
 * Whether the buffer is an ISO-BMFF file whose brands identify it as AVIF.
 *
 * A bare `ftyp` check would be useless as a filter: HEIC, HEIF and every MP4
 * variant open with the same box, so the brand list is the part that actually
 * discriminates. The declared box size bounds the scan, and the scan window is
 * additionally capped so a hostile 32-bit box size cannot make this expensive.
 */
function isAvif(bytes: Uint8Array): boolean {
  if (readAscii(bytes, 4, 4) !== asciiOf(FTYP_SIGNATURE)) {
    return false;
  }
  const boxSize = readUint32(bytes, 0);
  // `boxSize === 1` is the 64-bit extended form, whose real size lives past the
  // header; treating it as "scan the capped window" is the conservative choice.
  const brandsEnd = Math.min(
    Math.max(boxSize, 12),
    bytes.byteLength,
    12 + AVIF_BRAND_SCAN_LIMIT,
  );
  for (let offset = 8; offset + 4 <= brandsEnd; offset += 4) {
    if (AVIF_BRANDS.has(readAscii(bytes, offset, 4) ?? "")) {
      return true;
    }
  }
  return false;
}

/** Decode a big-endian unsigned 32-bit integer, or `0` when out of range. */
function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.byteLength) {
    return 0;
  }
  return (
    ((bytes[offset] as number) * 0x1000000 +
      ((bytes[offset + 1] as number) << 16) +
      ((bytes[offset + 2] as number) << 8) +
      (bytes[offset + 3] as number)) >>>
    0
  );
}

/** Render a byte signature as ASCII for comparison with `readAscii`. */
function asciiOf(signature: readonly number[]): string {
  return signature.map((value) => String.fromCharCode(value)).join("");
}

/**
 * Identify a product image by its bytes, or return `null`.
 *
 * Pure and side-effect free: the buffer is only read, never modified, copied or
 * retained. Length is checked per format rather than once, so a buffer that is
 * merely too short reports `UNSUPPORTED_FORMAT` (it is not a supported image)
 * rather than pretending to know which format it was trying to be.
 */
export function sniffProductImageFormat(bytes: Uint8Array): ProductImageContentType | null {
  if (bytes.byteLength < MIN_FORMAT_BYTES) {
    return null;
  }
  if (isJpeg(bytes)) {
    return "image/jpeg";
  }
  if (isPng(bytes)) {
    return "image/png";
  }
  if (isWebp(bytes)) {
    return "image/webp";
  }
  if (isAvif(bytes)) {
    return "image/avif";
  }
  return null;
}

/**
 * Validate one candidate product image: size first, then format.
 *
 * Order is load-bearing. An empty file is its own rejection because there is
 * nothing to sniff; the size check runs before sniffing so an oversized buffer is
 * rejected after a single `byteLength` comparison instead of after a scan; and
 * the format check is last because it is the only one that has to look at
 * content.
 *
 * `bytes.byteLength` is compared against `PRODUCT_IMAGE_LIMITS.maxBytesPerFile`
 * (1.5 MiB) with `>`, so a file of exactly 1,572,864 bytes is **accepted** and
 * one byte more is rejected.
 */
export function validateProductImageBytes(bytes: Uint8Array): ProductImageValidationResult {
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "EMPTY" };
  }
  if (bytes.byteLength > PRODUCT_IMAGE_LIMITS.maxBytesPerFile) {
    return { ok: false, reason: "TOO_LARGE" };
  }
  const contentType = sniffProductImageFormat(bytes);
  if (contentType === null) {
    return { ok: false, reason: "UNSUPPORTED_FORMAT" };
  }
  return { ok: true, image: { contentType, byteSize: bytes.byteLength } };
}
