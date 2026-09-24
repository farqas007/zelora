import {
  ADMIN_ERROR_CODES,
  PENDING_SELLERS_PAGE_LIMITS,
  type PendingSellerDto,
  type SellerProfileDto,
  type UserDto,
} from "@zelora/shared";
import {
  AppError,
  NotFoundError,
  ValidationError,
  constantTimeEqual,
  type AppConfig,
  type PasswordHasher,
} from "@zelora/core";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { UserRecord, UserRepository } from "@zelora/db/users";
import type {
  PendingSellerRecord,
  SellerProfileRecord,
  SellerRepository,
} from "@zelora/db/seller";
import { parseRegisterRequest } from "./validation";
import type { OnboardingResultData, SellerService } from "./seller";

/**
 * Admin-facing operations: initial-admin bootstrap, the pending-seller review
 * queue, and seller activation/rejection.
 *
 * Roles are enforced at the route boundary (`requireAdmin`), not here — the
 * service trusts that an authenticated admin reached it. The one exception is
 * {@link bootstrapAdmin}, which is unauthenticated by design and carries its
 * own authorization: a server-side secret compared in constant time.
 *
 * Every state transition an admin causes is appended to the audit log:
 * `admin.bootstrap` for the first account, `seller.activate` and
 * `seller.reject` for approval/rejection. Rows are immutable and written
 * through the injected port, so they work identically on local SQLite and
 * Cloudflare D1.
 */

/** The payload shape returned on success, matching `AdminBootstrapEnvelope`. */
export interface BootstrapResultData {
  user: UserDto;
  created: boolean;
}

export interface ListPendingSellersParams {
  limit?: string;
  cursor?: string;
}

export interface ListPendingSellersResultData {
  items: PendingSellerDto[];
  nextCursor: string | null;
}

export interface AdminServiceDependencies {
  config: AppConfig;
  userRepository: UserRepository;
  sellerRepository: SellerRepository;
  sellerService: SellerService;
  auditLogRepository: AuditLogRepository;
  passwordHasher: PasswordHasher;
}

export class AdminService {
  private readonly config: AppConfig;
  private readonly userRepository: UserRepository;
  private readonly sellerRepository: SellerRepository;
  private readonly sellerService: SellerService;
  private readonly auditLogRepository: AuditLogRepository;
  private readonly passwordHasher: PasswordHasher;

  constructor(dependencies: AdminServiceDependencies) {
    this.config = dependencies.config;
    this.userRepository = dependencies.userRepository;
    this.sellerRepository = dependencies.sellerRepository;
    this.sellerService = dependencies.sellerService;
    this.auditLogRepository = dependencies.auditLogRepository;
    this.passwordHasher = dependencies.passwordHasher;
  }

  /**
   * Create the very first administrator from an env-provided secret.
   *
   * The endpoint behaves like a normal missing resource (404) when
   * `ADMIN_BOOTSTRAP_SECRET` is not configured, and like a rejected request
   * (403) when the provided secret does not match. Idempotent per email:
   * bootstrapping an existing admin returns it as-is (200, no audit); an
   * existing non-admin account always conflicts (409) and is never promoted.
   * Only an actual creation writes an `admin.bootstrap` audit row.
   *
   * The "exactly one administrator" invariant is enforced by the database,
   * not just this pre-check: {@link UserRepository.createAdmin} fails the
   * insert (driver-neutral `ADMIN_ALREADY_EXISTS`) the moment a second admin
   * row is attempted, so two concurrent bootstraps with different emails can
   * never both succeed. A lost race is re-resolved into the same clean
   * results as the sequential paths.
   */
  async bootstrapAdmin(
    providedSecret: string | undefined,
    request: unknown,
  ): Promise<BootstrapResultData> {
    if (this.config.adminBootstrapSecret === null) {
      throw new NotFoundError("The requested resource was not found.");
    }
    if (
      providedSecret === undefined ||
      !(await this.secretMatches(this.config.adminBootstrapSecret, providedSecret))
    ) {
      throw new AppError(
        ADMIN_ERROR_CODES.ADMIN_BOOTSTRAP_UNAUTHORIZED,
        "The bootstrap request was rejected.",
        403,
      );
    }

    const parsed = parseRegisterRequest(request);
    const existing = await this.userRepository.findByEmail(parsed.email);
    if (existing !== null) {
      if (existing.role === "admin") {
        return { user: toUserDto(existing), created: false };
      }
      throw new AppError(
        ADMIN_ERROR_CODES.ADMIN_BOOTSTRAP_CONFLICT,
        "An account with this email already exists and cannot be promoted to admin.",
        409,
      );
    }

    const passwordHash = await this.passwordHasher.hash(parsed.password);
    const result = await this.userRepository.createAdmin({
      email: parsed.email,
      name: parsed.name,
      passwordHash,
      role: "admin",
    });

    if (result.ok) {
      await this.auditLogRepository.create({
        actorUserId: null,
        action: "admin.bootstrap",
        targetUserId: result.user.id,
        details: JSON.stringify({ email: result.user.email }),
      });

      return { user: toUserDto(result.user), created: true };
    }

    // The pre-check and the insert raced with a concurrent bootstrap: either
    // the same email was just created as an admin (idempotent by email), or a
    // *different* email's bootstrap won the single-administrator slot. Both
    // are re-resolved to the same clean results as the sequential paths.
    return this.resolveBootstrapRace(parsed.email);
  }

  private async resolveBootstrapRace(email: string): Promise<BootstrapResultData> {
    const raced = await this.userRepository.findByEmail(email);
    if (raced !== null && raced.role === "admin") {
      return { user: toUserDto(raced), created: false };
    }
    throw new AppError(
      ADMIN_ERROR_CODES.ADMIN_BOOTSTRAP_CONFLICT,
      raced !== null
        ? "An account with this email already exists and cannot be promoted to admin."
        : "An administrator already exists; only one is permitted.",
      409,
    );
  }

  /**
   * Keyset-paginated review queue of pending seller applications, oldest
   * submission first. `limit` must be an integer within
   * {@link PENDING_SELLERS_PAGE_LIMITS} (blank falls back to the default);
   * `cursor` is passed through opaque — a malformed cursor yields an empty
   * last page. Admin-only; caller authorization lives in the route.
   */
  async listPendingSellers(
    params: ListPendingSellersParams | undefined,
  ): Promise<ListPendingSellersResultData> {
    const limit = parsePendingLimit(params);
    const page = await this.sellerRepository.listPendingProfiles({
      limit,
      cursor: params?.cursor ?? null,
    });
    return {
      items: page.items.map(mapPendingSellerToDto),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Approve a seller account and record the decision. Delegates the state
   * transition to {@link SellerService.activateSeller} (which owns the
   * idempotency and blocked-status rules) and appends an audit row — but only
   * when that call actually performed a transition. Re-activating an
   * already-active seller is a no-op and must not mint a second
   * `seller.activate` audit row. Admin-only; caller authorization lives in
   * the route.
   */
  async activateSeller(
    actor: UserRecord,
    userId: string,
  ): Promise<OnboardingResultData> {
    const data = await this.sellerService.activateSeller(userId);
    if (data.transitioned) {
      await this.auditLogRepository.create({
        actorUserId: actor.id,
        action: "seller.activate",
        targetUserId: userId,
        details: JSON.stringify({
          sellerProfileId: data.sellerProfile.id,
          storeId: data.store.id,
        }),
      });
    }
    return data;
  }

  /**
   * Reject a pending seller application and record the decision. The profile
   * must be `pending`; `active` and `suspended` profiles are conflict-blocked,
   * and an already-`rejected` profile is an idempotent success (no duplicate
   * audit row). Rejection flips only the profile status — the store stays
   * `draft` and the owner's role stays a customer. A race with a concurrent
   * activation can never be overwritten: the repository's conditional update
   * is the backstop, and any interleaved state change is re-resolved to a
   * clean 404/409/success.
   */
  async rejectSeller(actor: UserRecord, userId: string): Promise<SellerProfileDto> {
    const current = await this.sellerRepository.findByUserId(userId);
    if (current === null) {
      throw new NotFoundError("No seller profile exists for this user.");
    }

    const { profile, transitioned } = await this.resolveRejection(current);
    if (transitioned) {
      await this.auditLogRepository.create({
        actorUserId: actor.id,
        action: "seller.reject",
        targetUserId: userId,
        details: JSON.stringify({ sellerProfileId: profile.id }),
      });
    }
    return mapSellerProfileToDto(profile);
  }

  private async resolveRejection(
    profile: SellerProfileRecord,
  ): Promise<{ profile: SellerProfileRecord; transitioned: boolean }> {
    if (profile.status === "active" || profile.status === "suspended") {
      throw new AppError(
        ADMIN_ERROR_CODES.SELLER_REJECTION_BLOCKED,
        "This seller profile cannot be rejected.",
        409,
      );
    }
    if (profile.status === "rejected") {
      return { profile, transitioned: false };
    }

    const rejected = await this.sellerRepository.rejectSeller(profile.userId);
    if (rejected !== null) {
      return { profile: rejected, transitioned: true };
    }

    // The pending row changed between the read and the conditional update (a
    // concurrent activation or rejection). Re-resolve to a clean result.
    const raced = await this.sellerRepository.findByUserId(profile.userId);
    if (raced === null) {
      throw new NotFoundError("No seller profile exists for this user.");
    }
    if (raced.status === "active" || raced.status === "suspended") {
      throw new AppError(
        ADMIN_ERROR_CODES.SELLER_REJECTION_BLOCKED,
        "This seller profile cannot be rejected.",
        409,
      );
    }
    return { profile: raced, transitioned: false };
  }

  /**
   * Constant-time comparison of the provided bootstrap secret against the
   * configured one. Both sides are SHA-256-hashed first so the comparison
   * never leaks even input-length differences (Web Crypto is available on
   * Node and Cloudflare Workers alike).
   */
  private async secretMatches(expected: string, provided: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const [providedDigest, expectedDigest] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(provided)),
      crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    return constantTimeEqual(
      new Uint8Array(providedDigest),
      new Uint8Array(expectedDigest),
    );
  }
}

/** Project a user row to the public admin DTO (never leaks credential material). */
function toUserDto(user: UserRecord): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

function mapSellerProfileToDto(profile: SellerProfileRecord): SellerProfileDto {
  return {
    id: profile.id,
    userId: profile.userId,
    slug: profile.slug,
    displayName: profile.displayName,
    status: profile.status,
  };
}

function mapPendingSellerToDto(record: PendingSellerRecord): PendingSellerDto {
  return {
    sellerProfile: {
      id: record.sellerProfile.id,
      userId: record.sellerProfile.userId,
      slug: record.sellerProfile.slug,
      displayName: record.sellerProfile.displayName,
      status: record.sellerProfile.status,
      createdAt: record.sellerProfile.createdAt.toISOString(),
    },
    user: {
      id: record.user.id,
      email: record.user.email,
      name: record.user.name,
      status: record.user.status,
      createdAt: record.user.createdAt.toISOString(),
    },
    store: {
      id: record.store.id,
      name: record.store.name,
      slug: record.store.slug,
      description: record.store.description,
      status: record.store.status,
      createdAt: record.store.createdAt.toISOString(),
    },
  };
}

/**
 * Parse and normalize the pending-seller page size. Blank falls back to the
 * default; anything that is not an integer within the shared bounds raises a
 * 422 {@link ValidationError}.
 */
function parsePendingLimit(params: ListPendingSellersParams | undefined): number {
  const raw = params?.limit;
  if (raw === undefined || raw === "") {
    return PENDING_SELLERS_PAGE_LIMITS.default;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError("The request is invalid.", {
      limit: ["Limit must be a positive integer."],
    });
  }
  const parsed = Number(raw);
  if (
    parsed < PENDING_SELLERS_PAGE_LIMITS.min ||
    parsed > PENDING_SELLERS_PAGE_LIMITS.max
  ) {
    throw new ValidationError("The request is invalid.", {
      limit: [
        `Limit must be between ${PENDING_SELLERS_PAGE_LIMITS.min} and ${PENDING_SELLERS_PAGE_LIMITS.max}.`,
      ],
    });
  }
  return parsed;
}