/**
 * Async-first authenticated-session repository port.
 *
 * Structural contract shared by the local better-sqlite3 implementation and
 * the future Cloudflare D1 implementation. Every method is async so the same
 * interface drives both drivers (better-sqlite3 is synchronous; D1 is
 * promise-based). This module is deliberately dependency-free: it never
 * imports a database client, so edge/API runtimes can import the contract
 * without pulling in the Node-only SQLite stack.
 *
 * Security boundary: the repository only ever stores, indexes and returns
 * token *hashes*. The raw session token exists solely in the auth service and
 * in the client cookie and never appears in this contract.
 */

/** A persisted auth session row, mirroring the `auth_sessions` table. */
export interface AuthSessionRecord {
  id: string;
  userId: string;
  /** SHA-256 hash of the raw session token (base64url, unpadded). */
  tokenHash: string;
  /** CSRF synchronizer token issued with this session. */
  csrfToken: string;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Everything required to create a session. Never includes the raw token. */
export interface CreateAuthSessionInput {
  userId: string;
  /** SHA-256 hash of the raw session token (base64url, unpadded). */
  tokenHash: string;
  /** CSRF synchronizer token issued with this session. */
  csrfToken: string;
  /** Instant after which the session is considered expired. */
  expiresAt: Date;
}

export interface AuthSessionRepository {
  /** Persist a new session. Returns the created row. */
  create(input: CreateAuthSessionInput): Promise<AuthSessionRecord>;
  /** Resolve a session by its token hash, or `null` when unknown. */
  findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  /** Delete one session by id. Returns whether a row was deleted. */
  deleteById(id: string): Promise<boolean>;
  /** Delete every session belonging to a user. Returns the number removed. */
  deleteAllForUser(userId: string): Promise<number>;
  /** Record a session's most recent use. Returns whether a row was updated. */
  updateLastUsedAt(id: string, lastUsedAt: Date): Promise<boolean>;
  /** Delete sessions that have already expired. Returns the number removed. */
  purgeExpired(now?: Date): Promise<number>;
}