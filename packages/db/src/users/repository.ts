import type { UserRole, UserStatus } from "@zelora/shared";

/**
 * Async-first user repository port.
 *
 * Structural contract shared by the local better-sqlite3 implementation and
 * the future Cloudflare D1 implementation. Every method is async so the same
 * interface drives both drivers (better-sqlite3 is synchronous; D1 is
 * promise-based). This module is deliberately dependency-light: it never
 * imports a database client, so edge/API runtimes can import the contract
 * without pulling in the Node-only SQLite stack.
 *
 * The `users` row carries credential material: only the encoded password hash
 * is ever written (`passwordHash`), never a plaintext password. Crude
 * credential handling belongs to the future auth service, not to this
 * contract. Email values are matched exactly as supplied; normalization
 * (trim + lowercase) is the caller's responsibility.
 */

/** A persisted user row, mirroring the `users` table. */
export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  name: string;
  passwordHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Everything required to create a user. The role is server-assigned: it
 * defaults to `customer` and must never be taken from client input elsewhere.
 */
export interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
  role?: UserRole;
}

/**
 * Driver-neutral reason a bootstrap insert could not create the initial
 * administrator. The `users` UNIQUE constraints remain the race-condition
 * backstop; the repository implementations map those SQLite constraint
 * failures onto these values so callers never inspect driver errors.
 */
export type CreateAdminConflictReason = "ADMIN_ALREADY_EXISTS" | "EMAIL_IN_USE";

/**
 * Outcome of {@link UserRepository.createAdmin}: the created row, or a
 * driver-neutral conflict reason when the "exactly one administrator"
 * invariant (or the email UNIQUE constraint) rejected the insert.
 */
export type CreateAdminResult =
  | { ok: true; user: UserRecord }
  | { ok: false; reason: CreateAdminConflictReason };

export interface UserRepository {
  /** Persist a new user. Returns the created row. */
  create(input: CreateUserInput): Promise<UserRecord>;
  /**
   * Atomically create the first administrator. Enforces the "exactly one
   * administrator" invariant: the partial unique index on `role` (present on
   * both SQLite and Cloudflare D1) rejects a second admin row, and the email
   * UNIQUE constraint rejects a duplicate email. Both are surfaced as
   * driver-neutral conflict reasons rather than raw constraint errors.
   */
  createAdmin(input: CreateUserInput): Promise<CreateAdminResult>;
  /** Resolve a user by their exact email, or `null` when unknown. */
  findByEmail(email: string): Promise<UserRecord | null>;
  /** Resolve a user by their id, or `null` when unknown. */
  findById(id: string): Promise<UserRecord | null>;
}