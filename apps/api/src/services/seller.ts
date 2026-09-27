import {
  AUTH_ERROR_CODES,
  DEFAULT_PRODUCT_CURRENCY,
  PRODUCT_IMAGE_LIMITS,
  SELLER_PRODUCT_ERROR_CODES,
  SELLER_PRODUCT_PAGE_LIMITS,
  type CreateProductRequest,
  type CreateProductVariantRequest,
  type InventoryDto,
  type ProductDto,
  type ProductImageDto,
  type ProductVariantDto,
  type SellerProductDetailDto,
  type SellerProductImageListData,
  type SellerProductListData,
  type SellerProductSummaryDto,
  type SellerProductVariantDetailDto,
  type SellerOnboardingRequest,
  type SellerProfileDto,
  type SetInventoryRequest,
  type StoreDto,
} from "@zelora/shared";
import { AppError, NotFoundError, ValidationError } from "@zelora/core";
import { isValidId } from "@zelora/db/ids";
import type { UserRecord } from "@zelora/db/users";
import type {
  SellerProfileRecord,
  SellerRepository,
  StoreRecord,
} from "@zelora/db/seller";
import type { CatalogRepository } from "@zelora/db/catalog";
import type {
  AddProductImageInput,
  InventoryRecord,
  ProductDetailRecord,
  ProductImageRecord,
  ProductRecord,
  ProductRepository,
  ProductVariantDetailRecord,
  VariantRecord,
} from "@zelora/db/products";
import { validateProductImageBytes, type ProductImageRejectionReason } from "./media/image-validation";
import { buildProductImageStorageKey } from "./media/storage-key";
import type { MediaStorage } from "./media/storage";
import {
  parseAddProductVariantRequest,
  parseCreateProductRequest,
  parseReorderProductImagesRequest,
  parseSellerOnboardingRequest,
  parseSetInventoryRequest,
} from "./validation";

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
  /**
   * Storage port for seller-uploaded product images. Supplied by
   * `createApp`, which substitutes a fail-closed implementation when the
   * deployment has no media storage configured — so this field is always a
   * usable value and never `undefined`.
   */
  mediaStorage: MediaStorage;
}

export interface ListSellerProductsParams {
  limit?: string;
  cursor?: string;
}

/**
 * One candidate image submitted to {@link SellerService.addProductImages}.
 *
 * Deliberately minimal and deliberately **not** a wire contract: a declared
 * content type, a filename and an original extension are all absent on purpose,
 * because every one of them is client-controlled and none of them may influence
 * what gets stored. The service derives the content type from the bytes and
 * derives the storage key from those bytes plus the owning product.
 */
export interface ProductImageUpload {
  /** The raw image bytes, exactly as received. Never modified in place. */
  bytes: Uint8Array;
  /** Optional accessible description; length-checked, never sniffed. */
  altText?: string | null;
}

/**
 * Cap the alt text of an image at {@link PRODUCT_IMAGE_LIMITS.altTextMaxLength},
 * returning the value to store.
 *
 * Normalized (trimmed, empty becomes `null`) so an all-whitespace description is
 * stored as "no description" rather than as an invisible string a screen reader
 * would read aloud. An over-long value is rejected rather than truncated: silently
 * cutting a seller's text hides the mistake from the only party who can fix it.
 *
 * Called during the up-front validation pass, before any byte is written, and it
 * throws the same `ValidationError` shape as a content rejection so one bad file
 * is reported the same way whatever the mistake was.
 */
function normalizeImageAltText(
  altText: string | null | undefined,
  index: number,
): string | null {
  if (altText === undefined || altText === null) {
    return null;
  }
  const trimmed = altText.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > PRODUCT_IMAGE_LIMITS.altTextMaxLength) {
    throw new ValidationError("The request is invalid.", {
      imagePosition: [
        `Image ${index + 1}: Alt text must be at most ${PRODUCT_IMAGE_LIMITS.altTextMaxLength} characters.`,
      ],
    });
  }
  return trimmed;
}

/**
 * Human-readable reason per sniffing rejection, addressed to the seller rather
 * than to a developer. Deliberately says nothing about *how* the file was
 * inspected beyond the outcome: a sniffed rejection is not a validation of the
 * client's metadata, so echoing a claimed type back would only confuse.
 */
const IMAGE_REJECTION_MESSAGES = {
  EMPTY: "The file is empty.",
  TOO_LARGE: `Each image must be at most ${PRODUCT_IMAGE_LIMITS.maxBytesPerFile} bytes.`,
  UNSUPPORTED_FORMAT: "Only JPEG, PNG, WebP and AVIF images are accepted.",
} as const satisfies Record<ProductImageRejectionReason, string>;

/**
 * Build the 422 for a rejected image, naming the file's 1-based position in the
 * submitted batch (`imagePosition`) and its own field (`image`).
 *
 * A `ValidationError` (422 with per-field messages) rather than a typed
 * `AppError`, matching every other malformed-input path in this service.
 */
function imageUploadError(reason: ProductImageRejectionReason, index: number): ValidationError {
  return new ValidationError("The request is invalid.", {
    imagePosition: [`Image ${index + 1}: ${IMAGE_REJECTION_MESSAGES[reason]}`],
  });
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

function mapSellerProductSummaryToDto(product: ProductRecord): SellerProductSummaryDto {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    categoryId: product.categoryId,
    status: product.status,
    createdAt: product.createdAt.toISOString(),
  };
}

function mapSellerProductDetailToDto(product: ProductDetailRecord): SellerProductDetailDto {
  return {
    ...mapSellerProductSummaryToDto(product),
    description: product.description,
    variants: product.variants.map(mapSellerProductVariantDetailToDto),
    images: product.images.map(mapProductImageToDto),
  };
}

/**
 * Project a `product_images` record into the shared owner DTO. The `0`/`1`
 * primary flag is already widened to a boolean by both repository drivers
 * (the database keeps the integer so the one-primary-per-product partial index
 * is enforced in SQL), so this is a straight field-for-field copy.
 */
function mapProductImageToDto(image: ProductImageRecord): ProductImageDto {
  return {
    id: image.id,
    productId: image.productId,
    url: image.url,
    altText: image.altText,
    sortOrder: image.sortOrder,
    isPrimary: image.isPrimary,
    createdAt: image.createdAt.toISOString(),
  };
}

function mapSellerProductVariantDetailToDto(
  variant: ProductVariantDetailRecord,
): SellerProductVariantDetailDto {
  return {
    ...mapVariantToDto(variant),
    inventory: variant.inventory === null ? null : mapInventoryToDto(variant.inventory),
  };
}

function mapVariantToDto(variant: VariantRecord): ProductVariantDto {
  return {
    id: variant.id,
    productId: variant.productId,
    sku: variant.sku,
    name: variant.name,
    priceAmountCents: variant.priceAmountCents,
    compareAtAmountCents: variant.compareAtAmountCents,
    currency: variant.currency,
    status: variant.status,
    createdAt: variant.createdAt.toISOString(),
    updatedAt: variant.updatedAt.toISOString(),
  };
}

function mapInventoryToDto(inventory: InventoryRecord): InventoryDto {
  return {
    variantId: inventory.variantId,
    quantity: inventory.quantity,
    updatedAt: inventory.updatedAt.toISOString(),
  };
}

function parseSellerProductListLimit(rawLimit: string | undefined): number {
  if (rawLimit === undefined || rawLimit === "") {
    return SELLER_PRODUCT_PAGE_LIMITS.default;
  }
  if (!/^\d+$/.test(rawLimit)) {
    throw new ValidationError("The request is invalid.", {
      limit: ["Limit must be a positive integer."],
    });
  }
  const limit = Number(rawLimit);
  if (
    limit < SELLER_PRODUCT_PAGE_LIMITS.min ||
    limit > SELLER_PRODUCT_PAGE_LIMITS.max
  ) {
    throw new ValidationError("The request is invalid.", {
      limit: [
        `Limit must be between ${SELLER_PRODUCT_PAGE_LIMITS.min} and ${SELLER_PRODUCT_PAGE_LIMITS.max}.`,
      ],
    });
  }
  return limit;
}

export class SellerService {
  private readonly sellerRepository: SellerRepository;
  private readonly productRepository: ProductRepository;
  private readonly catalogRepository: CatalogRepository;
  /**
   * Media storage port, held here because product images belong to the seller
   * domain. Public and `readonly` so it reads as the injected dependency it is,
   * rather than as private state awaiting a reader.
   *
   * Used by {@link SellerService.addProductImages} to store validated bytes
   * under an opaque content-addressed key. The HTTP upload route and any upload
   * UI are later phases; nothing else here touches media, and a deployment with
   * no storage configured keeps a fail-closed port, so an accidental call fails
   * loudly instead of dropping bytes.
   */
  readonly mediaStorage: MediaStorage;

  constructor(dependencies: SellerServiceDependencies) {
    this.sellerRepository = dependencies.sellerRepository;
    this.productRepository = dependencies.productRepository;
    this.catalogRepository = dependencies.catalogRepository;
    this.mediaStorage = dependencies.mediaStorage;
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

  async listProducts(
    user: UserRecord,
    params: ListSellerProductsParams | undefined,
  ): Promise<SellerProductListData> {
    const store = await this.resolveApprovedStore(user);
    const limit = parseSellerProductListLimit(params?.limit);
    const page = await this.productRepository.listByStore(store.id, {
      limit,
      cursor: params?.cursor || null,
    });
    return {
      items: page.items.map(mapSellerProductSummaryToDto),
      nextCursor: page.nextCursor,
    };
  }

  async getProduct(user: UserRecord, productId: string): Promise<SellerProductDetailDto> {
    const store = await this.resolveApprovedStore(user);
    if (!isValidId(productId)) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }
    const product = await this.productRepository.findByStoreAndId(store.id, productId);
    if (product === null) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }
    return mapSellerProductDetailToDto(product);
  }

  /**
   * Read every image belonging to one of the caller's own products.
   *
   * Ownership is resolved server-side exactly as it is for
   * {@link getProduct}: the store comes from the authenticated user and the
   * product id from the URL path, so a client cannot read another seller's
   * media. A malformed id, an unknown product and a product owned by a
   * different store all raise the *same* 404 `PRODUCT_NOT_FOUND`, so this
   * endpoint never reveals whether a foreign product id exists.
   *
   * A real product with no images is a success with an empty list, not a 404:
   * "no media yet" is a normal state for a fresh listing, and collapsing it
   * into a not-found would make the response indistinguishable from the
   * ownership failure the method is careful to hide.
   *
   * The repository returns the rows already ordered primary-first, then
   * `sortOrder`, then `id`; the service only maps them and never re-sorts, so
   * the ordering is decided in exactly one place per driver.
   */
  async listProductImages(user: UserRecord, productId: string): Promise<SellerProductImageListData> {
    const store = await this.resolveApprovedStore(user);
    if (!isValidId(productId)) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    // Existence is settled by the same ownership-scoped product lookup the
    // detail read uses, so "unknown or unowned" is one indistinguishable 404
    // before the image list is ever consulted.
    const product = await this.productRepository.findByStoreAndId(store.id, productId);
    if (product === null) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    const images = await this.productRepository.listImagesByProduct(productId, store.id);
    return { productId, images: images.map(mapProductImageToDto) };
  }

  /**
   * Validate and append images to one of the caller's own products.
   *
   * This is the service foundation for seller image uploads: ownership, the
   * per-product count cap, per-file byte/format validation, the content-addressed
   * storage key and the `product_images` insert all live here, so the HTTP route
   * in `routes/seller.ts` is only a transport over this method.
   *
   * The order of operations is the security property, not an implementation
   * detail:
   *
   * 1. **Ownership first.** The store comes from the session and the product id
   *    from the caller; a malformed id, an unknown product and a product owned by
   *    another store all raise the same 404, so nothing is read or written for a
   *    product the caller does not own.
   * 2. **Count cap before any write.** A request that would push the product past
   *    {@link PRODUCT_IMAGE_LIMITS.maxPerProduct} is refused with a 409 before a
   *    single byte reaches storage, so a rejected request leaves no orphaned
   *    objects behind.
   * 3. **Every file validated before any file written.** All uploads are sniffed
   *    and size-checked up front; only when all of them pass is the first byte
   *    stored. A batch is therefore all-or-nothing at the validation stage, which
   *    is the difference between "your fourth file is not an image" and four
   *    stored objects the seller never wanted.
   * 4. **The bytes decide the type.** The stored content type is the sniffed one
   *    and the storage key's extension is derived from it, so no client-declared
   *    MIME type or filename influences what is persisted or served.
   *
   * Returned DTOs never carry the internal `storage_key`: `product_images.url` is
   * the single public read path, and the key stays a server-side handle.
   *
   * ### Why the write phase compensates
   *
   * Everything above the writes is fail-safe: a rejected request stores nothing
   * at all. The write phase is different, because storing bytes and recording a
   * row for them are two separate acts with no shared transaction — the D1
   * driver has no interactive transaction, and the media table is a different
   * concern from `product_images` by design. A batch of eight therefore has a
   * window in which some objects exist and no row points at them: a later
   * `put` can fail, or the row insert can lose a race against a deleted
   * product.
   *
   * Rather than leave that window open, every failure inside it triggers
   * {@link SellerService.compensateStoredMedia}, which deletes the keys *this
   * request* wrote. It is best-effort by construction: a key that cannot be
   * removed is not fatal, because the alternative — replacing the caller's real
   * error with a storage fault — would be strictly worse for both the seller and
   * whoever reads the logs. A process that dies mid-request can still leave an
   * object behind; that is the media-byte GC a later phase owns, exactly as
   * {@link SellerService.deleteProductImage} deliberately leaves its bytes in
   * place.
   */
  async addProductImages(
    user: UserRecord,
    productId: string,
    uploads: ProductImageUpload[],
  ): Promise<ProductImageDto[]> {
    const store = await this.resolveApprovedStore(user);
    if (!isValidId(productId)) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    // Existence is settled by the same ownership-scoped product lookup the read
    // and delete paths use, so "unknown or unowned" is one indistinguishable 404
    // before any media is touched.
    const product = await this.productRepository.findByStoreAndId(store.id, productId);
    if (product === null) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    if (uploads.length > PRODUCT_IMAGE_LIMITS.maxFilesPerRequest) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.IMAGE_LIMIT_REACHED,
        `A request may carry at most ${PRODUCT_IMAGE_LIMITS.maxFilesPerRequest} images.`,
        409,
      );
    }

    // A checked no-op, not an unvalidated one: an empty batch still resolves
    // ownership above, so a foreign product is rejected exactly as it is for a
    // real batch.
    if (uploads.length === 0) {
      return [];
    }

    const existingCount = await this.productRepository.countImagesByProduct(productId, store.id);
    if (existingCount + uploads.length > PRODUCT_IMAGE_LIMITS.maxPerProduct) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.IMAGE_LIMIT_REACHED,
        `A product may hold at most ${PRODUCT_IMAGE_LIMITS.maxPerProduct} images.`,
        409,
      );
    }

    // Validate everything first — bytes *and* alt text — so a batch never leaves
    // partially written objects behind. Each rejection is reported with the
    // 1-based position of the offending file in the submitted batch. Alt text is
    // checked in this same pass on purpose: a request rejected only after its
    // bytes were stored would leave an object no row will ever point at.
    const validated = uploads.map((upload, index) => {
      const result = validateProductImageBytes(upload.bytes);
      if (!result.ok) {
        throw imageUploadError(result.reason, index);
      }
      const altText = normalizeImageAltText(upload.altText, index);
      return { ...result.image, altText };
    });

    // Append semantics: new images continue after the highest existing
    // `sortOrder` rather than renumbering what is already stored, so a partial
    // failure can never reshuffle a listing's display order.
    const nextSortOrder =
      product.images.reduce((highest, image) => Math.max(highest, image.sortOrder), -1) + 1;

    // Keys written by *this* request, in write order. Appended only after a
    // successful `put`, so compensation can never target a key that was never
    // stored (deleting one is harmless by the port's contract, but tracking the
    // real set is what makes the intent checkable).
    const storageKeys: string[] = [];
    try {
      for (const [index, upload] of uploads.entries()) {
        const image = validated[index];
        if (image === undefined) {
          throw new Error("validated image missing for a validated upload");
        }
        const storageKey = await buildProductImageStorageKey(productId, image.contentType, upload.bytes);
        await this.mediaStorage.put(storageKey, {
          // A copy the storage driver owns: some drivers bind the buffer
          // asynchronously, and the caller's array must not be mutable underneath
          // the write or the digest it was keyed by.
          bytes: upload.bytes.slice().buffer as ArrayBuffer,
          contentType: image.contentType,
          size: image.byteSize,
        });
        storageKeys.push(storageKey);
      }

      const stored: AddProductImageInput[] = validated.map((image, index) => ({
        // The public URL is derived from the opaque key, and remains the only
        // column a reader ever needs.
        url: this.mediaStorage.publicUrl(storageKeys[index] as string),
        storageKey: storageKeys[index] as string,
        altText: image.altText,
        sortOrder: nextSortOrder + index,
      }));

      const result = await this.productRepository.addProductImages({
        productId,
        storeId: store.id,
        images: stored,
      });
      if (!result.ok) {
        // The only reason the repository can still refuse is a race (the product
        // was deleted or moved between the check above and the insert). The objects
        // are already stored; report the ownership failure rather than pretending
        // the upload succeeded, and let the compensation below reclaim them.
        throw new AppError(
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          "This product is not available.",
          404,
        );
      }
      return result.images.map(mapProductImageToDto);
    } catch (error) {
      await this.compensateStoredMedia(storageKeys);
      throw error;
    }
  }

  /**
   * Best-effort removal of the objects one failed upload request had already
   * written.
   *
   * Every failure is swallowed, for two reasons that are the same reason: the
   * caller is about to be told what went wrong with their *request*, and a
   * secondary storage fault says nothing useful that the original error does
   * not. Swallowing also keeps a compensation fault from aborting the loop and
   * stranding the keys after it — every key written by the request is attempted,
   * in reverse write order, independently of whether its predecessor succeeded.
   *
   * Ordering is reverse because the most recently written key is the most
   * likely to be the one nothing references yet, and leaving the rest in place
   * would be equally wrong; the order is therefore chosen only because the
   * newest-first sequence is the one a future reader can most easily reason
   * about against the write loop.
   *
   * Orphan bytes that survive this — a crash mid-request, a permanently
   * unreachable backend — are not recoverable here by construction. They belong
   * to the media-byte GC of a later phase, which is also why
   * {@link SellerService.deleteProductImage} never removes bytes itself.
   */
  private async compensateStoredMedia(storageKeys: readonly string[]): Promise<void> {
    for (const storageKey of [...storageKeys].reverse()) {
      try {
        await this.mediaStorage.delete(storageKey);
      } catch {
        // Intentionally ignored; see the method comment.
      }
    }
  }

  /**
   * Delete one of the caller's own product images and return what was removed.
   *
   * Ownership is resolved server-side exactly as everywhere else in this
   * service, and the image is always scoped to the owned product, so an image id
   * belonging to another listing (or another seller) is a plain
   * 404 `IMAGE_NOT_FOUND` rather than a successful delete.
   *
   * Only the `product_images` row is removed. The stored bytes behind its
   * `storage_key` are deliberately left in place: byte reclamation is a separate
   * concern with its own failure modes, and a delete that had already destroyed
   * the bytes could not be undone after the row was gone. A storage driver that
   * is not configured therefore cannot turn a successful row delete into a 500.
   */
  async deleteProductImage(
    user: UserRecord,
    productId: string,
    imageId: string,
  ): Promise<ProductImageDto> {
    const store = await this.resolveApprovedStore(user);
    if (!isValidId(productId) || !isValidId(imageId)) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    const result = await this.productRepository.deleteProductImage({
      productId,
      imageId,
      storeId: store.id,
    });
    if (!result.ok) {
      if (result.reason === "PRODUCT_NOT_FOUND") {
        throw new AppError(
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          "This product is not available.",
          404,
        );
      }
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.IMAGE_NOT_FOUND,
        "This image does not belong to this product.",
        404,
      );
    }
    return mapProductImageToDto(result.image);
  }

  /**
   * Promote one of the caller's own product images to be the primary image.
   *
   * The repository guarantees the one-primary-per-product invariant and reports
   * an unknown or unowned image as `IMAGE_NOT_FOUND`; promoting the image that
   * is already primary is an idempotent success rather than an error, so a
   * retried request is safe. Only the product's own primary flag changes, so the
   * promoted image simply leads the deterministic read order afterwards.
   */
  async setPrimaryProductImage(
    user: UserRecord,
    productId: string,
    imageId: string,
  ): Promise<ProductImageDto> {
    const store = await this.resolveApprovedStore(user);
    if (!isValidId(productId) || !isValidId(imageId)) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    const result = await this.productRepository.setPrimaryProductImage({
      productId,
      imageId,
      storeId: store.id,
    });
    if (!result.ok) {
      if (result.reason === "PRODUCT_NOT_FOUND") {
        throw new AppError(
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          "This product is not available.",
          404,
        );
      }
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.IMAGE_NOT_FOUND,
        "This image does not belong to this product.",
        404,
      );
    }
    return mapProductImageToDto(result.image);
  }

  /**
   * Replace the display order of one of the caller's own product images.
   *
   * Ownership is resolved server-side exactly as everywhere else in this
   * service: the store comes from the authenticated user and the product id from
   * the URL path, so a client cannot reorder another seller's gallery. A
   * malformed product id, an unknown product and a product owned by another
   * store all raise the same 404 `PRODUCT_NOT_FOUND`, before any image id is
   * looked at — so a foreign product cannot even be used as an oracle for
   * whether a given image id exists.
   *
   * The request must be a **complete, duplicate-free permutation** of the
   * product's current image ids. That is decided in two halves, deliberately:
   * the request *shape* is validated here ({@link parseReorderProductImagesRequest}
   * — required array, string entries, well-formed ids, no repeats, bounded
   * length), while whether the ids are actually this product's images is decided
   * by the repository, which is the only layer that can see the product. Both
   * halves run before anything is written, so an invalid reorder mutates nothing
   * at all and the seller can simply re-send the current list.
   *
   * Only `sortOrder` changes. Primary state is never touched: a reorder can
   * neither promote, demote nor clear the primary image, and the primary keeps
   * leading the canonical read order afterwards no matter where it sat in the
   * submitted list.
   */
  async reorderProductImages(
    user: UserRecord,
    productId: string,
    request: unknown,
  ): Promise<SellerProductImageListData> {
    const store = await this.resolveApprovedStore(user);
    if (!isValidId(productId)) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    const parsed = parseReorderProductImagesRequest(request);

    const result = await this.productRepository.reorderProductImages({
      productId,
      storeId: store.id,
      imageIds: parsed.imageIds,
    });
    if (!result.ok) {
      if (result.reason === "PRODUCT_NOT_FOUND") {
        throw new AppError(
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          "This product is not available.",
          404,
        );
      }
      // One reason for every kind of mismatch (a duplicate, a missing id, a
      // foreign id, an unknown id) so the answer does not disclose which id was
      // wrong. A `ValidationError` rather than a typed `AppError`, matching
      // every other malformed-input path in this service.
      throw new ValidationError("The request is invalid.", {
        imageIds: ["Image ids must be the product's complete current set, in the desired order."],
      });
    }
    return { productId, images: result.images.map(mapProductImageToDto) };
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
    const store = await this.resolveApprovedStore(user);

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
   * Add a variant to one of the caller's own products. Ownership is resolved
   * server-side: the product id comes from the URL path and the store comes
   * from the authenticated user (never from the body), so a client cannot
   * attach variants to another seller's product. Unknown/unowned products are
   * indistinguishable (404, no existence leak). The variant is inserted
   * `active`, but the product stays invisible until it is published.
   */
  async createVariant(
    user: UserRecord,
    productId: string,
    request: unknown,
  ): Promise<ProductVariantDto> {
    const store = await this.resolveApprovedStore(user);
    if (!isValidId(productId)) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    const parsed: CreateProductVariantRequest = parseAddProductVariantRequest(request);

    const result = await this.productRepository.createVariant({
      productId,
      storeId: store.id,
      sku: parsed.sku ?? null,
      name: parsed.name,
      priceAmountCents: parsed.priceAmountCents,
      compareAtAmountCents: parsed.compareAtAmountCents ?? null,
      currency: parsed.currency ?? DEFAULT_PRODUCT_CURRENCY,
    });

    if (!result.ok) {
      if (result.reason === "PRODUCT_NOT_FOUND") {
        throw new AppError(
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          "This product is not available.",
          404,
        );
      }
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.SKU_IN_USE,
        "A variant with this SKU already exists.",
        409,
      );
    }

    return mapVariantToDto(result.variant);
  }

  /**
   * Upsert the inventory of one of the caller's own variants. Ownership is
   * resolved server-side from the authenticated session; the product and
   * variant ids come from the URL path. Unknown paths are 404.
   */
  async setInventory(
    user: UserRecord,
    productId: string,
    variantId: string,
    request: unknown,
  ): Promise<InventoryDto> {
    const store = await this.resolveApprovedStore(user);
    if (!isValidId(productId) || !isValidId(variantId)) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    const parsed: SetInventoryRequest = parseSetInventoryRequest(request);

    const result = await this.productRepository.setInventory({
      productId,
      variantId,
      storeId: store.id,
      quantity: parsed.quantity,
    });

    if (!result.ok) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    return mapInventoryToDto(result.inventory);
  }

  /**
   * Publish one of the caller's own products. The product only becomes
   * `active` (and therefore visible on the public catalog/storefront) when it
   * has at least one sellable variant: status `active`, price at least 1 cent
   * and inventory quantity at least 1. Publishing an already-`active` product
   * is idempotent; archived products cannot be published.
   */
  async publishProduct(user: UserRecord, productId: string): Promise<ProductDto> {
    const store = await this.resolveApprovedStore(user);
    if (!isValidId(productId)) {
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        "This product is not available.",
        404,
      );
    }

    const result = await this.productRepository.publishProduct(productId, store.id);

    if (!result.ok) {
      if (result.reason === "PRODUCT_NOT_FOUND") {
        throw new AppError(
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          "This product is not available.",
          404,
        );
      }
      if (result.reason === "PRODUCT_ARCHIVED") {
        throw new AppError(
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_ARCHIVED,
          "This product is archived and cannot be published.",
          409,
        );
      }
      throw new AppError(
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_PUBLISHABLE,
        "Add at least one active variant with a positive price and available inventory before publishing.",
        409,
      );
    }

    return mapProductToDto(result.product);
  }

  /**
   * Resolve the authenticated user's approved seller store, or throw 403. This
   * is the single ownership gate shared by every seller product mutation: the
   * user's role must be `seller`, their seller profile must exist and be
   * `active`, and their store must exist and be `active`. The store is always
   * derived from the session identity, never from the request body.
   */
  private async resolveApprovedStore(user: UserRecord): Promise<StoreRecord> {
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

    return store;
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