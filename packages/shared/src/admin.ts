/**
 * Shared administrative contracts: the initial-admin bootstrap, the pending
 * seller review API and seller rejection.
 *
 * This module is the browser-facing vocabulary for the Phase 4 admin surface.
 * It stays dependency-free (plain types/constants) so the package keeps its
 * "shared contracts, no runtime deps" property. The status unions mirror the
 * `packages/db` enums on purpose, exactly like `./auth`.
 *
 * Security model: there is NO unauthenticated "make me admin" path. The only
 * way to create the first administrator is the bootstrap endpoint, which is
 * gated by a server-side secret (`ADMIN_BOOTSTRAP_SECRET`) that is never part
 * of a request signed by a normal user. Everything else here is admin-only and
 * is authorized server-side against the authenticated user's role.
 */

import type { ApiEnvelope } from "./envelope";
import type {
  SellerProfileDto,
  SellerProfileStatus,
  StoreStatus,
  UserDto,
  UserStatus,
} from "./auth";

/**
 * Error codes the admin endpoints can produce, as stable string values. The
 * activation path reuses `SELLER_ACTIVATION_BLOCKED` from `AUTH_ERROR_CODES`.
 */
export const ADMIN_ERROR_CODES = {
  ADMIN_BOOTSTRAP_UNAUTHORIZED: "ADMIN_BOOTSTRAP_UNAUTHORIZED",
  ADMIN_BOOTSTRAP_CONFLICT: "ADMIN_BOOTSTRAP_CONFLICT",
  SELLER_REJECTION_BLOCKED: "SELLER_REJECTION_BLOCKED",
} as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[keyof typeof ADMIN_ERROR_CODES];

/** Minimum length for `ADMIN_BOOTSTRAP_SECRET`; shorter values are refused at config load. */
export const ADMIN_BOOTSTRAP_SECRET_MIN_LENGTH = 32;

/** Page-size bounds for the admin pending-seller listing. */
export const PENDING_SELLERS_PAGE_LIMITS = {
  min: 1,
  max: 50,
  default: 20,
} as const;

/**
 * Body of the initial-admin bootstrap request. The shape matches the register
 * contract (email/password/name); only the resulting role (`admin`) and the
 * gating mechanism differ.
 */
export interface AdminBootstrapRequest {
  email: string;
  password: string;
  name: string;
}

/** Public view of a seller profile as returned to an authenticated admin. */
export interface AdminSellerProfileDto {
  id: string;
  userId: string;
  slug: string;
  displayName: string;
  status: SellerProfileStatus;
  /** ISO 8601 timestamp (application submitted). */
  createdAt: string;
}

/** Initial store snapshot for a pending application, admin view. */
export interface AdminSellerStoreDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: StoreStatus;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/**
 * Owner of a pending application, admin view. Deliberately excludes role (a
 * pending application's owner is always a customer until activation) and
 * never includes credential material.
 */
export interface PendingSellerUserDto {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** One pending seller application: profile + owner + first store. */
export interface PendingSellerDto {
  sellerProfile: AdminSellerProfileDto;
  user: PendingSellerUserDto;
  store: AdminSellerStoreDto;
}

export interface AdminPendingSellersListData {
  items: PendingSellerDto[];
  /** Opaque keyset cursor for the next page, or `null` when this is the last page. */
  nextCursor: string | null;
}

/** Bootstrap succeeded: the created (or already-existing) administrator. */
export type AdminBootstrapEnvelope = ApiEnvelope<{ user: UserDto }>;
export type AdminPendingSellersEnvelope = ApiEnvelope<AdminPendingSellersListData>;
/** Rejection succeeded: the seller profile now `rejected`. */
export type SellerRejectionEnvelope = ApiEnvelope<SellerProfileDto>;