import type { ProductImageContentType } from "@zelora/shared";
import { isValidId } from "@zelora/db/ids";
import { PRODUCT_IMAGE_FILE_EXTENSIONS } from "./image-validation";

/**
 * The server-side key scheme for seller-uploaded product media.
 *
 * Shape: `products/<productId>/<sha256>.<ext>`
 *
 * Three properties, each load-bearing:
 *
 * 1. **Product-scoped.** The hash alone would be enough to identify the bytes,
 *    but a globally content-addressed key makes two identical uploads — from two
 *    different products — collide on one stored object. Because `put` has
 *    replace semantics (the D1 driver deletes the previous row before inserting,
 *    which cascades to that object's `product_media` rows), the second upload
 *    would evict the first product's bytes. Scoping the key by `productId`
 *    makes that impossible by construction: two products can never address each
 *    other's object, whatever the bytes are.
 * 2. **Content-addressed within that scope.** The same bytes uploaded twice to
 *    the *same* product produce the same key, so a repeated upload is
 *    idempotent at the storage layer instead of accumulating near-duplicate
 *    objects. The digest is over the exact bytes, computed after validation, so
 *    a stored key is a verifiable statement about its contents.
 * 3. **Opaque.** Nothing client-supplied reaches the key: no filename, no
 *    original extension, no alt text, no user id. Only a server-generated
 *    product id, a hash and an extension derived from the *sniffed* type. That
 *    matters because the key appears in a public URL (the key is the storage
 *    port's addressing scheme), so anything user-controlled in it would be
 *    published, guessable or injectable into a path.
 *
 * Web Crypto only — no Node `crypto` import and no `Buffer` — so this runs in
 * the Cloudflare Worker unchanged.
 *
 * Because the key *is* the addressing scheme of a public URL, this module also
 * owns the reverse check {@link isProductImageStorageKey}, which the public
 * media read path uses to decide whether a key from a URL is one the platform
 * could have issued.
 */

/** Directory prefix for product media, so a deployment can recognise its own objects. */
const PRODUCT_MEDIA_PREFIX = "products";

/**
 * Length of the hex SHA-256 digest used in a key.
 *
 * Fixed rather than configurable: a shorter digest would make collisions a real
 * possibility (two different images mapping to one key means one silently
 * overwrites the other), and a longer one buys nothing for a key that is never
 * brute-forced.
 */
const SHA256_HEX_LENGTH = 64;

/**
 * Build the opaque storage key for one verified image of one product.
 *
 * @param productId the owning product's id, always server-resolved
 * @param contentType the **sniffed** content type; it alone selects the
 *   extension, so the key can never claim a format the bytes were not
 *   verified as
 * @param bytes the image's bytes, already validated against the per-image size
 *   limit — the digest is computed over exactly these bytes
 */
export async function buildProductImageStorageKey(
  productId: string,
  contentType: ProductImageContentType,
  bytes: Uint8Array,
): Promise<string> {
  const digest = await sha256Hex(bytes);
  // A truncated digest would silently reintroduce the collision risk the key
  // scheme exists to contain, and the failure would only surface much later as
  // one image overwriting another. Assert it here, where it is cheap, instead.
  if (digest.length !== SHA256_HEX_LENGTH) {
    throw new Error(`Expected a ${SHA256_HEX_LENGTH}-character SHA-256 digest, received ${digest.length}.`);
  }
  const extension = PRODUCT_IMAGE_FILE_EXTENSIONS[contentType];
  return `${PRODUCT_MEDIA_PREFIX}/${productId}/${digest}.${extension}`;
}

/**
 * Hex SHA-256 of `bytes`, computed by Web Crypto.
 *
 * The digest is taken over the view's own window (a subarray of a larger buffer
 * digests only its own bytes, which is what the caller means) and the input is
 * never modified. `crypto.subtle` is a global in both runtimes this service
 * targets, so there is no runtime-specific branch here.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** Every extension {@link buildProductImageStorageKey} can emit. */
const STORAGE_KEY_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.values(PRODUCT_IMAGE_FILE_EXTENSIONS),
);

/**
 * Whether `value` is a storage key this platform could have produced.
 *
 * The **exact inverse** of {@link buildProductImageStorageKey}'s shape, written
 * next to it so the two cannot drift: `products/<uuid>/<64 lowercase hex>.<ext>`
 * with `ext` drawn from the same extension table the builder uses and the
 * product id checked by the same `isValidId` the rest of the seller surface uses.
 *
 * It exists for the public read path, where the key arrives from a URL rather
 * than from this module. Because the accepted shape is a closed, fully literal
 * structure — three segments, no empty segment, no `.` or `..` segment, no
 * percent sign, no backslash, no leading slash — a traversal attempt cannot be
 * *rewritten* into something safe; it simply fails to match and is refused
 * before it ever reaches a storage driver. Rejecting rather than sanitising is
 * the point: a key is server-generated, so anything unrecognised is either a
 * mistake or an attack, and neither is worth guessing about.
 */
export function isProductImageStorageKey(value: string): boolean {
  const segments = value.split("/");
  if (segments.length !== 3) {
    return false;
  }
  const [prefix, productId, filename] = segments as [string, string, string];
  if (prefix !== PRODUCT_MEDIA_PREFIX || !isValidId(productId)) {
    return false;
  }

  // `lastIndexOf` rather than splitting on every dot, so the digest half is
  // checked for being *only* hex — a filename with an extra dot inside it
  // cannot pass as `digest.ext`.
  const separator = filename.lastIndexOf(".");
  if (separator <= 0) {
    return false;
  }
  const digest = filename.slice(0, separator);
  if (digest.length !== SHA256_HEX_LENGTH || !/^[0-9a-f]+$/.test(digest)) {
    return false;
  }
  return STORAGE_KEY_EXTENSIONS.has(filename.slice(separator + 1));
}
