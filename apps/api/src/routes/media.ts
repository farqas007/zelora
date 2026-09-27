import { Hono } from "hono";
import { NotFoundError } from "@zelora/core";
import { isProductImageStorageKey } from "../services/media/storage-key";
import { PRODUCT_IMAGE_FILE_EXTENSIONS } from "../services/media/image-validation";
import type { MediaStorage } from "../services/media/storage";

/**
 * Public read path for stored seller-uploaded product media, mounted at
 * `/media`.
 *
 * A stored `product_images.url` is composed by the storage port as
 * `MEDIA_PUBLIC_BASE_URL` + the storage key, so the URL a seller ends up with
 * is `<base>/products/<productId>/<sha256>.<ext>`. This route is what makes
 * that URL resolve: the *deployment* is responsible for pointing
 * `MEDIA_PUBLIC_BASE_URL` at a base that ends in `/media` (for example
 * `https://api.example.com/media`), and this route serves the key beneath it.
 * Nothing here re-derives or rewrites the URL, so the shape stays owned by the
 * one `joinMediaPublicUrl` both storage drivers use.
 *
 * ### Why this is unauthenticated
 *
 * Product images are public marketplace assets. The same bytes are rendered on
 * the public catalog and storefront to customers who have never signed in, so
 * gating this on a session or a seller role would break those pages while
 * protecting nothing: the URL is already in the page source, is derived only
 * from a UUID and a content hash, and grants no access to anything else. The
 * seller-only *operations* on the same media — listing, deleting, promoting —
 * stay behind the seller stack in `routes/seller.ts`; this route is the read
 * half of that split, not a hole in it.
 *
 * ### Why the key is validated, not sanitised
 *
 * The key arrives from the URL, so it is the one piece of untrusted input on
 * this path. {@link isProductImageStorageKey} accepts only the exact shape the
 * platform's own key builder emits, and anything else is a 404 before it
 * reaches a driver. That closes traversal structurally rather than by
 * escaping: there is no normalisation step in which `..%2f` could collapse into
 * something meaningful, and no reason to maintain one. The drivers would
 * defend themselves as well — the filesystem driver resolves and containment-
 * checks every key, and D1 matches a column exactly — but refusing the key here
 * means both get the same answer, and an unrecognised key never becomes a
 * driver error.
 *
 * Edge-compatible: the storage port is injected, and nothing here is
 * backend-specific — no bucket, no filesystem, no Node API.
 */

/**
 * Cache for stored media, one year, immutable.
 *
 * Safe specifically because of the key scheme rather than as a blanket policy: a
 * key embeds the SHA-256 of the bytes and is scoped to one product, so the bytes
 * at a given URL can never change — re-uploading different content produces a
 * different key, and re-uploading the same content produces the same bytes.
 * A key that *were* mutable (a UUID, a timestamp, a user-chosen name) would make
 * this header a way to pin a stale image in every browser for a year, which is
 * why the cacheability claim belongs to the key scheme rather than the route.
 */
const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface MediaRoutesDependencies {
  mediaStorage: MediaStorage;
}

export function createMediaRoutes(dependencies: MediaRoutesDependencies): Hono {
  const { mediaStorage } = dependencies;
  const app = new Hono();

  // The key is one path segment in the key scheme but contains slashes in
  // practice (`products/<id>/<digest>.<ext>`), so it is captured by an explicit
  // greedy pattern rather than a single `:param`. A bare `*` is not usable here:
  // Hono's default router does not surface it through `req.param("*")` once the
  // sub-app is mounted under a prefix, which would silently make every key
  // undefined — and every request a 404.
  app.get("/:key{.+}", async (c) => {
    const storageKey = c.req.param("key");
    if (storageKey === undefined || !isProductImageStorageKey(storageKey)) {
      // The same refusal as "nothing is stored here". A caller learns neither
      // whether the key is well-formed nor whether the product exists, so this
      // endpoint cannot be used to probe for product ids.
      throw new NotFoundError();
    }

    const object = await mediaStorage.get(storageKey);
    if (object === null) {
      throw new NotFoundError();
    }

    return c.body(object.bytes, 200, {
      "Content-Type": resolveContentType(object.contentType, storageKey),
      "Cache-Control": MEDIA_CACHE_CONTROL,
    });
  });

  return app;
}

/**
 * Extension to content type, inverted from the single table the key builder
 * itself uses, so the two can never name the same extension differently.
 */
const EXTENSION_CONTENT_TYPES = new Map<string, string>(
  Object.entries(PRODUCT_IMAGE_FILE_EXTENSIONS).map(([contentType, extension]) => [
    extension,
    contentType,
  ]),
);

/**
 * The content type to serve an object with.
 *
 * The stored type is authoritative and is what every content-addressing driver
 * returns. `null` is only possible for a driver that has nowhere to record one —
 * the Node filesystem driver, which stores bare bytes.
 *
 * In that case the key's own extension is used, and that is a defensible claim
 * rather than a guess: the extension is not client input, it was chosen by the
 * key builder *from the sniffed content type* of these very bytes, and
 * {@link isProductImageStorageKey} has already confirmed the extension is one of
 * the four the platform issues. It is a presentation fallback for drivers that
 * cannot store metadata — it is never an input to a validation decision, and it
 * cannot be reached for a D1-stored object. `application/octet-stream` is
 * therefore unreachable in practice and exists only so a driver that somehow
 * reported neither can never produce a nonsense `Content-Type`.
 */
function resolveContentType(stored: string | null, storageKey: string): string {
  if (stored !== null && stored !== "") {
    return stored;
  }
  const extension = storageKey.slice(storageKey.lastIndexOf(".") + 1);
  return EXTENSION_CONTENT_TYPES.get(extension) ?? "application/octet-stream";
}
