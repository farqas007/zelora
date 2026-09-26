/**
 * Local filesystem implementation of the {@link MediaStorage} port, for the
 * Node runtime (`src/index.ts`) and tests.
 *
 * **This module must never enter the Cloudflare Worker module graph.** It
 * imports `node:fs/promises` and `node:path`, and the Worker bundle is built
 * with `--platform=neutral` and then scanned by
 * `scripts/check-worker-bundle.mjs`, which fails the build on any `node:`
 * specifier. That check is the enforcement mechanism for this rule: importing
 * this file from `app.ts`, `worker.ts`, `routes/`, `middleware/` or any other
 * shared module turns the Worker build red immediately.
 *
 * Behaviour is kept faithful to R2 so the two drivers are interchangeable
 * behind the port:
 *
 * - `put` overwrites an existing object at the same key (R2's `put` does too),
 *   rather than failing like an exclusive create would.
 * - `delete` treats a missing file as success, matching R2 and satisfying the
 *   port's idempotency contract that upload compensation relies on.
 * - Missing parent directories are created, so a key like
 *   `products/<id>/<uuid>.jpg` works on a cold directory tree.
 *
 * Keys are server-generated, but this driver does not trust its caller: every
 * key is resolved against the root and rejected unless the result stays inside
 * it, so a crafted key containing `..` or an absolute path can never write
 * outside the media root.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  assertMediaObjectSize,
  joinMediaPublicUrl,
  type MediaObjectInput,
  type MediaObjectOutput,
  type MediaStorage,
} from "./storage";

export interface LocalFileMediaStorageOptions {
  /**
   * Directory uploaded media is written into. Relative paths resolve against
   * the process working directory, matching `ZELORA_DB_PATH` and
   * `ZELORA_MEDIA_ROOT`.
   */
  root: string;
  /**
   * Absolute `http(s)` base the stored files are publicly readable from.
   *
   * Absolute rather than root-relative on purpose: a stored
   * `product_images.url` is loaded directly as an `<img src>`, and during local
   * development the web app (Vite, `:5173`) and the API (`:3001`) are different
   * origins — so a `/media/...` path would be requested from Vite and 404.
   */
  publicBaseUrl: string;
}

/**
 * Whether a key is absolute *on some* platform, not just the current host.
 *
 * `path.isAbsolute` answers for the host only: on POSIX a key like
 * `C:\Windows\config\SAM` is an ordinary filename and `resolve` correctly keeps
 * it inside the root, so it is harmless there. Rejecting the form anyway keeps
 * one rule for "this key names a file inside the media root" regardless of where
 * the process runs, so a key accepted on a POSIX laptop is never a drive-letter
 * escape when the same code runs on a Windows host. Covers drive-letter
 * (`C:\`, `C:/`) and UNC (`\\server\share`) forms.
 */
const ABSOLUTE_ON_ANY_PLATFORM = /^[A-Za-z]:[\\/]|^\\\\/;

/**
 * Resolve a storage key to an absolute path inside the media root, or throw.
 *
 * Containment is decided on the *resolved* paths, not by pattern-matching the
 * key, and by inspecting path **segments** rather than a `"../"` prefix.
 * `relative()` emits the host separator, so an escaping key surfaces as
 * `../../x` on POSIX and as `..\..\x` on Windows; a prefix check would cover only
 * whichever host the tests happened to run on. Splitting on both separators and
 * rejecting any `..` segment gives one rule that is correct everywhere.
 *
 * That same rule additionally rejects a Windows-style `..\secret.txt` key on
 * POSIX, where `resolve` would otherwise treat it as a harmless literal
 * filename inside the root. Rejecting it is deliberate: a key accepted as safe
 * on one host must not be an escape on the other, since the key space is
 * server-generated and shared across deployments.
 *
 * The root itself is rejected as well: a key must name a file inside the root,
 * never the root directory. `isAbsolute` is kept as a backstop for the
 * pathological case where `relative()` ever returns an absolute path.
 */
function resolveMediaPath(root: string, key: string): string {
  if (ABSOLUTE_ON_ANY_PLATFORM.test(key)) {
    throw new Error(`Media key "${key}" resolves outside the media root.`);
  }
  const rootPath = resolve(root);
  const target = resolve(rootPath, key);
  const relativePath = relative(rootPath, target);
  const escapes =
    relativePath === "" ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..");
  if (escapes) {
    throw new Error(`Media key "${key}" resolves outside the media root.`);
  }
  return target;
}

/**
 * Whether a `readFile` failure means "nothing is stored under this key".
 *
 * Narrowed to the two codes the filesystem actually uses for absence
 * (`ENOENT`: no such file, and `EISDIR`: the path is a directory), so a
 * permission error or a genuine I/O fault still propagates instead of being
 * reported to the caller as a missing object — which would look like data loss
 * rather than like an outage.
 */
function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "EISDIR";
}

/**
 * Copy the exact bytes of `contents` into an `ArrayBuffer` of their own.
 *
 * A `Buffer` returned by `readFile` can be a window into a larger shared
 * allocation, so handing its backing store to a caller would leak unrelated
 * bytes and pin a pool buffer alive. `slice` on the backing store copies just
 * this view's range, producing a buffer whose `byteLength` is exactly the
 * stored object size.
 */
function toExactArrayBuffer(contents: Buffer): ArrayBuffer {
  return contents.buffer.slice(
    contents.byteOffset,
    contents.byteOffset + contents.byteLength,
  ) as ArrayBuffer;
}

export function createLocalFileMediaStorage(
  options: LocalFileMediaStorageOptions,
): MediaStorage {
  const { root, publicBaseUrl } = options;
  return {
    async put(key: string, object: MediaObjectInput) {
      assertMediaObjectSize(key, object);
      const target = resolveMediaPath(root, key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(object.bytes));
    },

    async get(key: string) {
      const target = resolveMediaPath(root, key);
      let contents: Buffer;
      try {
        contents = await readFile(target);
      } catch (error) {
        // A key with nothing behind it is an ordinary answer to a read, not a
        // fault: the port reports absence as `null` so a caller can tell it
        // apart from a real backend failure, which still propagates.
        if (isMissingFileError(error)) {
          return null;
        }
        throw error;
      }
      return {
        // `readFile` hands back a `Buffer` that may be a window into a shared
        // pool, so the exact byte range is copied into a buffer of its own
        // rather than exposed as-is.
        bytes: toExactArrayBuffer(contents),
        // The filesystem has nowhere to record a content type, so this driver
        // reports `null` instead of guessing from the extension.
        contentType: null,
      } satisfies MediaObjectOutput;
    },

    async delete(key: string) {
      const target = resolveMediaPath(root, key);
      // `force` makes a missing file a success, which is the idempotency the
      // port promises and that upload compensation depends on.
      await rm(target, { force: true });
    },

    publicUrl(key: string) {
      return joinMediaPublicUrl(publicBaseUrl, key);
    },
  };
}

/** Re-exported so tests can assert containment without duplicating the rule. */
export { resolveMediaPath };
