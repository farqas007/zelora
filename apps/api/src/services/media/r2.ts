/**
 * Cloudflare R2 implementation of the {@link MediaStorage} port.
 *
 * Edge-safe by construction:
 *
 * - No `@cloudflare/workers-types`. Only the three members actually used are
 *   declared, hand-written, exactly as `D1DatabaseLike` is declared in
 *   `@zelora/db/d1`. A real `R2Bucket` binding satisfies this shape
 *   structurally, so `env.MEDIA` drops straight in.
 * - No `node:` specifiers and no `Buffer`. Bytes travel as `ArrayBuffer`,
 *   which is what both R2 and the standard fetch types accept.
 * - `put`/`delete` are declared with method-shorthand syntax, so TypeScript
 *   checks their parameters bivariantly and a real binding's wider accepted
 *   value union stays assignable without a cast.
 *
 * The public URL is composed from the configured `MEDIA_PUBLIC_BASE_URL` (a
 * `r2.dev` development base, a custom domain, or a proxied media route — the
 * driver does not care which) so a base-URL change never requires touching
 * this file or the rows already stored.
 */

import {
  assertMediaObjectSize,
  joinMediaPublicUrl,
  type MediaObjectInput,
  type MediaStorage,
} from "./storage";

/** The subset of R2's `R2PutOptions` this driver uses. */
export interface R2PutOptionsLike {
  httpMetadata?: {
    contentType?: string;
  };
}

/**
 * The result R2 returns from `put`. Declared minimally and never inspected —
 * `put` succeeding is the only signal this driver needs.
 */
export interface R2PutResultLike {
  key: string;
}

/**
 * Minimal structural view of a Cloudflare R2 bucket binding.
 *
 * Only `put` and `delete` are declared because only those two are called;
 * `get`/`head`/`list` are deliberately absent so the port cannot grow a
 * read-back dependency on the bucket that the local filesystem driver would
 * then have to imitate.
 */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer,
    options?: R2PutOptionsLike,
  ): Promise<R2PutResultLike | null>;
  delete(key: string): Promise<void>;
}

export interface R2MediaStorageOptions {
  /** The `R2Bucket` binding (the Worker's `env.MEDIA`). */
  bucket: R2BucketLike;
  /**
   * Absolute `http(s)` base the bucket's objects are publicly readable from,
   * already validated and trailing-slash-stripped by `loadConfig`.
   */
  publicBaseUrl: string;
}

/**
 * Create the R2-backed media storage.
 *
 * Objects are written with `httpMetadata.contentType` set to the caller-supplied
 * (verified) type, so a later public read is served with the correct
 * `Content-Type` instead of R2's default `application/octet-stream` — which
 * browsers refuse to render in an `<img>` tag.
 */
export function createR2MediaStorage(options: R2MediaStorageOptions): MediaStorage {
  const { bucket, publicBaseUrl } = options;
  return {
    async put(key: string, object: MediaObjectInput) {
      assertMediaObjectSize(key, object);
      await bucket.put(key, object.bytes, {
        httpMetadata: { contentType: object.contentType },
      });
    },

    async delete(key: string) {
      // R2's delete already succeeds for a key that does not exist, so
      // idempotency needs no special handling here.
      await bucket.delete(key);
    },

    publicUrl(key: string) {
      return joinMediaPublicUrl(publicBaseUrl, key);
    },
  };
}
