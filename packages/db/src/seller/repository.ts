import type { SellerProfileStatus, StoreStatus } from "@zelora/shared";

/**
 * Async-first seller-account repository port.
 *
 * Structural contract shared by the local better-sqlite3 implementation and
 * the future Cloudflare D1 implementation. Every method is async so the same
 * interface drives both drivers (better-sqlite3 is synchronous; D1 is
 * promise-based). This module is deliberately dependency-free: it never
 * imports a database client, so edge/API runtimes can import the contract
 * without pulling in the Node-only SQLite stack.
 *
 * Identity is caller-supplied per call and never accepted from client input.
 * The `userId` in {@link CreateOnboardingInput} is always the authenticated
 * session's user. Statuses are never requested inputs: the seller profile is
 * created as `pending` and the initial store as `draft` by the database
 * defaults.
 *
 * Onboarding is atomic: {@link SellerRepository.createOnboarding} creates the
 * seller profile and its first store in a single transaction, and surfaces
 * uniqueness conflicts as a driver-neutral discriminated result so callers
 * never inspect raw SQLite/D1 errors.
 */

/** A persisted seller profile row, mirroring the `seller_profiles` table. */
export interface SellerProfileRecord {
  id: string;
  userId: string;
  slug: string;
  displayName: string;
  status: SellerProfileStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** A persisted store row, mirroring the `stores` table. */
export interface StoreRecord {
  id: string;
  sellerProfileId: string;
  name: string;
  slug: string;
  description: string | null;
  status: StoreStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Everything required to create a seller profile plus its first store. The
 * profile starts `pending` and the store starts `draft` via database defaults;
 * neither role, user status nor any ownership field is accepted here.
 */
export interface CreateOnboardingInput {
  userId: string;
  profileSlug: string;
  displayName: string;
  storeName: string;
  storeSlug: string;
}

/**
 * Driver-neutral conflict reasons, mapped from the underlying UNIQUE
 * constraints (which remain the race-condition backstop).
 */
export type OnboardingConflictReason =
  | "SELLER_PROFILE_EXISTS"
  | "PROFILE_SLUG_IN_USE"
  | "STORE_SLUG_IN_USE";

export type CreateOnboardingResult =
  | { ok: true; sellerProfile: SellerProfileRecord; store: StoreRecord }
  | { ok: false; reason: OnboardingConflictReason };

/** State after a seller profile is activated (status `active`). */
export interface SellerActivationResult {
  sellerProfile: SellerProfileRecord;
  store: StoreRecord;
}

export interface SellerRepository {
  /** Resolve a seller profile by its owning user id, or `null`. */
  findByUserId(userId: string): Promise<SellerProfileRecord | null>;
  /** Resolve a seller profile by its unique slug, or `null`. */
  findByProfileSlug(slug: string): Promise<SellerProfileRecord | null>;
  /** Resolve a store by its unique slug, or `null`. */
  findStoreBySlug(slug: string): Promise<StoreRecord | null>;
  /**
   * Atomically create the seller profile and its initial store. When a UNIQUE
   * constraint is hit the whole operation rolls back and a conflict reason is
   * returned; no orphan profile is ever left behind.
   */
  createOnboarding(input: CreateOnboardingInput): Promise<CreateOnboardingResult>;
  /**
   * Activate a seller profile: its status and every store under it flip to
   * `active`, and the owning user is promoted to the `seller` role. The whole
   * transition is atomic. Idempotent for an already-active profile (all three
   * writes become no-ops). Returns `null` when the user has no profile.
   */
  activateSeller(userId: string): Promise<SellerActivationResult | null>;
}