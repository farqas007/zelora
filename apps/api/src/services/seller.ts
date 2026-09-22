import {
  AUTH_ERROR_CODES,
  type SellerOnboardingRequest,
  type SellerProfileDto,
  type StoreDto,
} from "@zelora/shared";
import { AppError } from "@zelora/core";
import type { UserRecord } from "@zelora/db/users";
import type {
  SellerProfileRecord,
  SellerRepository,
  StoreRecord,
} from "@zelora/db/seller";
import { parseSellerOnboardingRequest } from "./validation";

/**
 * Seller account onboarding for an authenticated session.
 *
 * The service is deliberately separate from {@link AuthService}: it owns every
 * decision about turning an authenticated customer into a pending seller
 * profile plus its first draft store. It never mutates `users` — in
 * particular it never changes `users.role` — because the profile starts
 * `pending` and must not grant seller privileges before a later admin-approval
 * step promotes the account.
 *
 * Identity always comes from the authenticated session (the resolved
 * {@link UserRecord}); nothing from the request body is trusted. Only the
 * four onboarding fields are validated and consumed, and any unsupported
 * client-supplied `userId`/`role`/`status` fields are ignored.
 *
 * Edge-compatible: database contracts are imported as types only and all
 * repository I/O goes through the injected async port.
 */

/** The payload shape returned on success, matching `SellerOnboardingEnvelope`. */
export interface OnboardingResultData {
  sellerProfile: SellerProfileDto;
  store: StoreDto;
}

export interface SellerServiceDependencies {
  sellerRepository: SellerRepository;
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

function mapStoreToDto(store: StoreRecord): StoreDto {
  return {
    id: store.id,
    name: store.name,
    slug: store.slug,
    description: store.description,
    status: store.status,
  };
}

export class SellerService {
  private readonly sellerRepository: SellerRepository;

  constructor(dependencies: SellerServiceDependencies) {
    this.sellerRepository = dependencies.sellerRepository;
  }

  /**
   * Validate and execute the onboarding flow for the authenticated user.
   * The user id is taken from the resolved session identity (`user`), never
   * from the request body. Returns DTOs compatible with
   * `SellerOnboardingEnvelope`; on conflicts throws the standard 409
   * `AppError`s.
   */
  async onboard(user: UserRecord, request: unknown): Promise<OnboardingResultData> {
    if (user.status === "suspended") {
      throw new AppError(
        AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
        "This account has been suspended.",
        403,
      );
    }
    if (user.status === "deleted") {
      throw new AppError(
        AUTH_ERROR_CODES.ACCOUNT_DELETED,
        "This account has been deleted.",
        403,
      );
    }

    const parsed: SellerOnboardingRequest = parseSellerOnboardingRequest(request);

    const existingProfile = await this.sellerRepository.findByUserId(user.id);
    if (existingProfile !== null) {
      throw new AppError(
        AUTH_ERROR_CODES.SELLER_PROFILE_EXISTS,
        "You already have a seller profile.",
        409,
      );
    }

    const profileSlugInUse = await this.sellerRepository.findByProfileSlug(parsed.slug);
    if (profileSlugInUse !== null) {
      throw new AppError(
        AUTH_ERROR_CODES.SLUG_IN_USE,
        "A seller profile with this slug already exists.",
        409,
      );
    }

    const storeSlugInUse = await this.sellerRepository.findStoreBySlug(parsed.storeSlug);
    if (storeSlugInUse !== null) {
      throw new AppError(
        AUTH_ERROR_CODES.SLUG_IN_USE,
        "A store with this slug already exists.",
        409,
      );
    }

    const result = await this.sellerRepository.createOnboarding({
      userId: user.id,
      profileSlug: parsed.slug,
      displayName: parsed.displayName,
      storeName: parsed.storeName,
      storeSlug: parsed.storeSlug,
    });

    // A conflict that appears between the pre-checks and the transactional
    // insert (a race) is still reported cleanly via the driver-neutral result.
    if (!result.ok) {
      if (result.reason === "SELLER_PROFILE_EXISTS") {
        throw new AppError(
          AUTH_ERROR_CODES.SELLER_PROFILE_EXISTS,
          "You already have a seller profile.",
          409,
        );
      }
      throw new AppError(
        AUTH_ERROR_CODES.SLUG_IN_USE,
        "A profile or store with this slug already exists.",
        409,
      );
    }

    return {
      sellerProfile: mapSellerProfileToDto(result.sellerProfile),
      store: mapStoreToDto(result.store),
    };
  }
}