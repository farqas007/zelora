import { base64UrlToBytes } from "./base64";
import {
  derivePasswordDigest,
  encodePasswordHash,
  PASSWORD_HASH_MAX_ITERATIONS,
  PASSWORD_HASH_MIN_ITERATIONS,
} from "./password";

/**
 * Deterministic, re-usable dummy password hash for the future auth service's
 * "user not found" path.
 *
 * The encoded value is a syntactically valid PBKDF2 hash of a fixed internal
 * password (it is never a real user's password), embedded with the requested
 * iteration count so `verify()` performs the same derivation work for
 * nonexistent users as for real ones.
 *
 * The production-default iteration count (210,000) is precomputed so it never
 * needs to be derived at runtime; any other count is derived once per process
 * and cached.
 */

/** Fixed internal password that produces the dummy digest. Never a user password. */
const DUMMY_PASSWORD = "zelora-internal-dummy-password@2026";

/** Fixed 16-byte salt, base64url-encoded without padding. */
const DUMMY_SALT_B64 = "RksjSgXKIejPEU7bGHuwIg";
const DUMMY_SALT = base64UrlToBytes(DUMMY_SALT_B64)!;

/**
 * PBKDF2-HMAC-SHA256 digest of `DUMMY_PASSWORD` with `DUMMY_SALT` at 210,000
 * iterations — the production default — precomputed at authoring time.
 */
const DUMMY_DIGEST_210000_B64 = "fqIaBLvllp59WuUNaLe-kFVjjjvaeIN9BIKtcTlnClY";

const PRECOMPUTED = new Map<number, string>([
  [
    210_000,
    encodePasswordHash(
      210_000,
      DUMMY_SALT,
      base64UrlToBytes(DUMMY_DIGEST_210000_B64)!,
    ),
  ],
]);

const COMPUTED = new Map<number, Promise<string>>();

/** Resolve a valid dummy password hash for the given iteration count. */
export function getDummyPasswordHash(iterations: number): Promise<string> {
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < PASSWORD_HASH_MIN_ITERATIONS ||
    iterations > PASSWORD_HASH_MAX_ITERATIONS
  ) {
    throw new RangeError(
      `iterations must be an integer between ${PASSWORD_HASH_MIN_ITERATIONS} and ${PASSWORD_HASH_MAX_ITERATIONS}`,
    );
  }

  const precomputed = PRECOMPUTED.get(iterations);
  if (precomputed !== undefined) {
    return Promise.resolve(precomputed);
  }

  const pending = COMPUTED.get(iterations);
  if (pending === undefined) {
    const derived = derivePasswordDigest(DUMMY_PASSWORD, iterations, DUMMY_SALT).then(
      (digest) => encodePasswordHash(iterations, DUMMY_SALT, digest),
    );
    COMPUTED.set(iterations, derived);
    return derived;
  }
  return pending;
}