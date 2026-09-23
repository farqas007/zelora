/**
 * Shared authentication and seller-account contracts.
 *
 * This module is the browser-facing vocabulary for everything introduced in
 * Phase 3 (authentication, sessions, seller onboarding). It is intentionally
 * dependency-free: values here are plain constants/types so the package keeps
 * its "shared contracts, no runtime deps" property.
 *
 * The role/status unions mirror the `packages/db` enums on purpose — the
 * database layer must not be imported by the browser, so the API re-exports
 * the same vocabulary from here.
 */
import type { ApiEnvelope } from "./envelope";

export const USER_ROLES = ["customer", "seller", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "suspended", "deleted"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SELLER_PROFILE_STATUSES = ["pending", "active", "suspended", "rejected"] as const;
export type SellerProfileStatus = (typeof SELLER_PROFILE_STATUSES)[number];

export const STORE_STATUSES = ["draft", "active", "inactive", "closed"] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

/**
 * Validation limits applied by the API before any auth/seller mutation happens.
 * Shared so the web app can mirror them (e.g. inline hints) without hardcoding.
 */
export const AUTH_LIMITS = {
  emailMinLength: 3,
  emailMaxLength: 254,
  passwordMinLength: 8,
  passwordMaxLength: 128,
  nameMinLength: 1,
  nameMaxLength: 80,
  slugMinLength: 3,
  slugMaxLength: 60,
  displayNameMinLength: 1,
  displayNameMaxLength: 80,
  storeNameMinLength: 1,
  storeNameMaxLength: 120,
} as const;

/** Simple structural email check; length bounds are enforced separately. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercase slug pattern shared by seller profiles and stores. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/** Onboarding creates a pending seller profile and its first draft store. */
export interface SellerOnboardingRequest {
  slug: string;
  displayName: string;
  storeName: string;
  storeSlug: string;
}

/** Public view of an account returned by auth endpoints. */
export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** Opaque server-side session created on register/login and set as a cookie. */
export interface AuthSessionDto {
  id: string;
  /** ISO 8601 timestamps. */
  createdAt: string;
  expiresAt: string;
  /** Synchronizer token the web app must echo on mutating requests. */
  csrfToken: string;
}

/** Success payload for register and login (a session is always created). */
export interface AuthUserResponse {
  user: UserDto;
  session: AuthSessionDto;
}

export interface SellerProfileDto {
  id: string;
  userId: string;
  slug: string;
  displayName: string;
  status: SellerProfileStatus;
}

export interface StoreDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: StoreStatus;
}

/** Error codes the auth/seller endpoints can produce, as stable string values. */
export const AUTH_ERROR_CODES = {
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  EMAIL_IN_USE: "EMAIL_IN_USE",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  ACCOUNT_DELETED: "ACCOUNT_DELETED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SELLER_PROFILE_EXISTS: "SELLER_PROFILE_EXISTS",
  SELLER_ACTIVATION_BLOCKED: "SELLER_ACTIVATION_BLOCKED",
  SLUG_IN_USE: "SLUG_IN_USE",
  RATE_LIMITED: "RATE_LIMITED",
  CSRF_FAILED: "CSRF_FAILED",
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/**
 * Typed envelopes for the contract shapes in this module, so API/route code
 * and web clients share one source of truth for each endpoint.
 */
export type RegisterEnvelope = ApiEnvelope<AuthUserResponse>;
export type LoginEnvelope = ApiEnvelope<AuthUserResponse>;

/** Profile plus its store, returned by onboarding and admin activation. */
export interface SellerOnboardingData {
  sellerProfile: SellerProfileDto;
  store: StoreDto;
}
export type SellerOnboardingEnvelope = ApiEnvelope<SellerOnboardingData>;
/** Admin confirms a pending seller: profile and store are now active. */
export type SellerActivationEnvelope = ApiEnvelope<SellerOnboardingData>;
export type AuthMeEnvelope = ApiEnvelope<{
  user: UserDto;
}>;

/**
 * Payload for the authenticated CSRF bootstrap endpoint. The session cookie is
 * HttpOnly, so after a page reload the SPA can re-obtain the synchronizer
 * token it needs for mutating requests without ever seeing the raw session
 * token.
 */
export type AuthCsrfEnvelope = ApiEnvelope<{
  csrfToken: string;
}>;

export type LogoutEnvelope = ApiEnvelope<{
  done: true;
}>;

export type LogoutAllEnvelope = ApiEnvelope<{
  done: true;
}>;