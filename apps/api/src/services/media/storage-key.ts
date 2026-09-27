import type { ProductImageContentType } from "@zelora/shared";
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
