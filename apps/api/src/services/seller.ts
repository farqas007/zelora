import {
  AUTH_ERROR_CODES,
  SELLER_PRODUCT_ERROR_CODES,
  type CreateProductRequest,
  type ProductDto,
  type SellerOnboardingRequest,
  type SellerProfileDto,
  type StoreDto,
} from "@zelora/shared";
import { AppError, NotFoundError } from "@zelora/core";
import type { UserRecord } from "@zelora/db/users";
import type {
  SellerProfileRecord,
  SellerRepository,
  StoreRecord,
} from "@zelora/db/seller";
import type { CatalogRepository } from "@zelora/db/catalog";
import type { ProductRepository, ProductRecord } from "@zelora/db/products";
import { parseCreateProductRequest, parseSellerOnboardingRequest } from "./validation";

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

/**
 * {@link OnboardingResultData} plus a transition signal, so the admin service
 * can distinguish a real `pending → active` activation from an idempotent
 * re-activation of an already-active profile (and only audit the former).
 */
export interface SellerActivationData extends OnboardingResultData {
  transitioned: boolean;
}

export interface SellerServiceDependencies {
  sellerRepository: SellerRepository;
  productRepository: ProductRepository;
  catalogRepository: CatalogRepository;
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

function mapProductToDto(product: ProductRecord): ProductDto {
  return {
    id: product.id,
    storeId: product.storeId,
    slug: product.slug,
    name: product.name,
    description: product.description,
    categoryId: product.categoryId,
    status: product.status,
    createdAt: product.createdAt.toISOString(),
  };
}

export class SellerService {
  private readonly sellerRepository: SellerRepository;
  private readonly productRepository: ProductRepository;
  private readonly catalogRepository: CatalogRepository;

  constructor(dependencies: SellerServiceDependencies) {
    this.sellerRepository = dependencies.sellerRepository;
    this.productRepository = dependencies.productRepository;
    this.catalogRepository = dependencies.catalogRepository;
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

  /**
   * Validate and execute the seller product-creation flow for an approved
   * seller. "Approved" is enforced here, never by the route alone: the user's
   * role must be `seller`, their seller profile must exist and be `active`,
   * and their store must exist and be `active`. Anything else — a customer
   * role, a suspended/deleted account, a pending/rejected profile, absent or
   * non-active store — is `403 SELLER_NOT_APPROVED`.
   *
   * Ownership is resolved server-side: the store comes from the authenticated
   * user's seller profile, never from the request body, so a client cannot
   * inject a `storeId`/`userId` to create listings in another store. The
   * created product always starts `draft` (the database default); no status is
   * accepted from the client.
   */
  async createProduct(user: UserRecord, request: unknown): Promise<ProductDto> {
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
    if (user.role !== "seller") {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.SELLER_NOT_APPROVED,
        "Only approved sellers can create products.",
        403,
      );
    }

    const profile = await this.sellerRepository.findByUserId(user.id);
    if (profile === null || profile.status !== "active") {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.SELLER_NOT_APPROVED,
        "Your seller account is not approved yet.",
        403,
      );
    }

    const store = await this.sellerRepository.findStoreBySellerProfileId(profile.id);
    if (store === null || store.status !== "active") {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.SELLER_NOT_APPROVED,
        "Your store is not active yet.",
        403,
      );
    }

    const parsed: CreateProductRequest = parseCreateProductRequest(request);

    if (parsed.categoryId !== undefined) {
      const categories = await this.catalogRepository.listActiveCategories();
      const category = categories.find((candidate) => candidate.id === parsed.categoryId);
      if (category === undefined) {
        throw new AppError(
          SELLER_PRODUCT_ERROR_CODES.CATEGORY_NOT_FOUND,
          "The selected category does not exist or is not active.",
          404,
        );
      }
    }

    // The repository's `(store_id, slug)` UNIQUE constraint is the real
    // backstop; this pre-check only gives the common case a fast, explicit
    // 409 before a driver-level conflict.
    const precheck = await this.productRepository.findByStoreAndSlug(store.id, parsed.slug);
    if (precheck !== null) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_SLUG_IN_USE,
        "A product with this slug already exists in your store.",
        409,
      );
    }

    const result = await this.productRepository.createProduct({
      storeId: store.id,
      categoryId: parsed.categoryId ?? null,
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description ?? null,
    });

    // A conflict that appears between the pre-check and the insert (a race)
    // is still reported cleanly via the driver-neutral result.
    if (!result.ok) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_SLUG_IN_USE,
        "A product with this slug already exists in your store.",
        409,
      );
    }

    return mapProductToDto(result.product);
  }

  /**
   * Approve a seller account. The profile must exist and must not be
   * suspended or rejected; activation flips the profile and its stores to
   * `active` and promotes the owning user to the `seller` role atomically.
   * Activating an already-active profile is a no-op success (idempotent) and
   * reports `transitioned: false` so callers never mistreat it as a real
   * state change. This is an admin-level action; caller authorization lives
   * in the route.
   */
  async activateSeller(userId: string): Promise<SellerActivationData> {
    const profile = await this.sellerRepository.findByUserId(userId);
    if (profile === null) {
      throw new NotFoundError("No seller profile exists for this user.");
    }
    if (profile.status === "suspended" || profile.status === "rejected") {
      throw new AppError(
        AUTH_ERROR_CODES.SELLER_ACTIVATION_BLOCKED,
        "This seller profile cannot be activated.",
        409,
      );
    }

    // Idempotency is decided up front: an already-active profile was never
    // transitioned by this call, even though the atomic repository activation
    // below is a harmless no-op for it.
    const transitioned = profile.status !== "active";

    const activated = await this.sellerRepository.activateSeller(userId);
    if (activated === null) {
      throw new NotFoundError("No seller profile exists for this user.");
    }

    return {
      sellerProfile: mapSellerProfileToDto(activated.sellerProfile),
      store: mapStoreToDto(activated.store),
      transitioned,
    };
  }
}