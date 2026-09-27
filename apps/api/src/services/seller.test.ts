import { beforeEach, describe, expect, it } from "vitest";
import { AppError, ValidationError } from "@zelora/core";
import type { UserRecord } from "@zelora/db/users";
import type {
  CreateOnboardingInput,
  OnboardingConflictReason,
  SellerProfileRecord,
  SellerRepository,
  StoreRecord,
} from "@zelora/db/seller";
import type { CatalogCategoryRecord, CatalogRepository } from "@zelora/db/catalog";
import {
  AUTH_ERROR_CODES,
  DEFAULT_PRODUCT_CURRENCY,
  PRODUCT_IMAGE_LIMITS,
  SELLER_PRODUCT_ERROR_CODES,
  SELLER_PRODUCT_PAGE_LIMITS,
} from "@zelora/shared";
import type {
  AddProductImagesInput,
  AddProductImagesResult,
  CreateVariantInput,
  CreateVariantResult,
  InventoryRecord,
  CreateProductInput,
  CreateProductResult,
  DeleteProductImageInput,
  DeleteProductImageResult,
  ProductDetailRecord,
  ProductImageRecord,
  ProductListPage,
  ProductListQuery,
  ProductRecord,
  ProductRepository,
  ProductVariantDetailRecord,
  PublishProductResult,
  SetInventoryInput,
  SetInventoryResult,
  SetPrimaryProductImageInput,
  SetPrimaryProductImageResult,
  VariantRecord,
} from "@zelora/db/products";
import type { MediaObjectInput, MediaObjectOutput, MediaStorage } from "./media/storage";
import { SellerService } from "./seller";

/**
 * Service-level tests for seller onboarding. The repository is faked so every
 * security decision (identity, eligibility, normalization, conflicts, DTO
 * projection) can be asserted without a database.
 */

class FakeSellerRepository implements SellerRepository {
  private profiles: Map<string, SellerProfileRecord> = new Map();
  private stores: Map<string, StoreRecord> = new Map();
  private nextId = 1;

  lastCreateInput: CreateOnboardingInput | null = null;
  forceConflict: OnboardingConflictReason | null = null;

  async findByUserId(userId: string): Promise<SellerProfileRecord | null> {
    return Array.from(this.profiles.values()).find((profile) => profile.userId === userId) ?? null;
  }

  async findByProfileSlug(slug: string): Promise<SellerProfileRecord | null> {
    return Array.from(this.profiles.values()).find((profile) => profile.slug === slug) ?? null;
  }

  async findStoreBySlug(slug: string): Promise<StoreRecord | null> {
    return Array.from(this.stores.values()).find((store) => store.slug === slug) ?? null;
  }

  async findStoreBySellerProfileId(sellerProfileId: string): Promise<StoreRecord | null> {
    return Array.from(this.stores.values()).find((store) => store.sellerProfileId === sellerProfileId) ?? null;
  }

  async createOnboarding(input: CreateOnboardingInput): Promise<
    | { ok: true; sellerProfile: SellerProfileRecord; store: StoreRecord }
    | { ok: false; reason: OnboardingConflictReason }
  > {
    this.lastCreateInput = input;
    if (this.forceConflict !== null) {
      return { ok: false, reason: this.forceConflict };
    }
    if (Array.from(this.profiles.values()).some((profile) => profile.userId === input.userId)) {
      return { ok: false, reason: "SELLER_PROFILE_EXISTS" };
    }
    if (Array.from(this.profiles.values()).some((profile) => profile.slug === input.profileSlug)) {
      return { ok: false, reason: "PROFILE_SLUG_IN_USE" };
    }
    if (Array.from(this.stores.values()).some((store) => store.slug === input.storeSlug)) {
      return { ok: false, reason: "STORE_SLUG_IN_USE" };
    }

    const profileId = `sp-${this.nextId}`;
    const storeId = `st-${this.nextId}`;
    this.nextId += 1;
    const now = new Date();
    const sellerProfile: SellerProfileRecord = {
      id: profileId,
      userId: input.userId,
      slug: input.profileSlug,
      displayName: input.displayName,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const store: StoreRecord = {
      id: storeId,
      sellerProfileId: profileId,
      name: input.storeName,
      slug: input.storeSlug,
      description: null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.profiles.set(profileId, sellerProfile);
    this.stores.set(storeId, store);
    return { ok: true, sellerProfile, store };
  }

  seedProfile(profile: SellerProfileRecord): void {
    this.profiles.set(profile.id, profile);
  }

  seedStore(store: StoreRecord): void {
    this.stores.set(store.id, store);
  }

  async activateSeller(userId: string): Promise<{
    sellerProfile: SellerProfileRecord;
    store: StoreRecord;
  } | null> {
    const profile = Array.from(this.profiles.values()).find((candidate) => candidate.userId === userId);
    if (profile === undefined) {
      return null;
    }
    const activatedProfile: SellerProfileRecord = { ...profile, status: "active" };
    const store = Array.from(this.stores.values()).find((candidate) => candidate.sellerProfileId === profile.id);
    if (store === undefined) {
      throw new Error("seller profile has no store to activate");
    }
    this.profiles.set(profile.id, activatedProfile);
    return { sellerProfile: activatedProfile, store: { ...store, status: "active" } };
  }

  async listPendingProfiles(): Promise<{ items: never[]; nextCursor: null }> {
    throw new Error("pending list is not exercised by seller service tests");
  }

  async rejectSeller(userId: string): Promise<SellerProfileRecord | null> {
    const profile = Array.from(this.profiles.values()).find(
      (candidate) => candidate.userId === userId && candidate.status === "pending",
    );
    if (profile === undefined) {
      return null;
    }
    this.profiles.set(profile.id, { ...profile, status: "rejected" });
    return this.profiles.get(profile.id) ?? null;
  }

  clear(): void {
    this.profiles.clear();
    this.stores.clear();
    this.nextId = 1;
    this.lastCreateInput = null;
    this.forceConflict = null;
  }
}

/**
 * Minimal product-repository fake exercising the seller create logic. Products
 * live in a map keyed by id; slug uniqueness is enforced per store exactly like
 * the real repository's `(store_id, slug)` constraint. Variants are inserted
 * `active` and follow the real publish invariant (at least one active variant
 * with a positive price and inventory).
 */
class FakeProductRepository implements ProductRepository {
  private products: Map<string, ProductRecord> = new Map();
  private variants: Map<string, VariantRecord> = new Map();
  private inventory: Map<string, InventoryRecord> = new Map();
  private images: Map<string, ProductImageRecord> = new Map();
  private nextId = 1;

  forceCreateConflict: boolean = false;
  forceSkuConflict: boolean = false;
  /** Make `addProductImages` refuse, standing in for the product vanishing mid-upload. */
  forceAddImagesConflict: boolean = false;

  createVariantCalls: CreateVariantInput[] = [];
  setInventoryCalls: SetInventoryInput[] = [];
  listCalls: Array<{ storeId: string; query: ProductListQuery }> = [];
  listImagesCalls: Array<{ productId: string; storeId: string }> = [];
  /** Every `addProductImages` input, so stored rows (keys, order, alt text) are assertable. */
  addImagesCalls: AddProductImagesInput[] = [];
  /** Every `deleteProductImage` / `setPrimaryProductImage` input, for the same reason. */
  deleteImageCalls: DeleteProductImageInput[] = [];
  setPrimaryImageCalls: SetPrimaryProductImageInput[] = [];

  async listByStore(storeId: string, query: ProductListQuery): Promise<ProductListPage> {
    this.listCalls.push({ storeId, query });
    const owned = Array.from(this.products.values())
      .filter((product) => product.storeId === storeId)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
      );
    const items = owned.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        owned.length > query.limit && last !== undefined ? `next:${last.id}` : null,
    };
  }

  async findByStoreAndId(storeId: string, productId: string): Promise<ProductDetailRecord | null> {
    const product = this.products.get(productId);
    if (product === undefined || product.storeId !== storeId) {
      return null;
    }
    const variants: ProductVariantDetailRecord[] = Array.from(this.variants.values())
      .filter((variant) => variant.productId === productId)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((variant) => ({
        ...variant,
        inventory: this.inventory.get(variant.id) ?? null,
      }));
    return { ...product, variants, images: this.collectImages(productId, storeId) };
  }

  async listImagesByProduct(productId: string, storeId: string): Promise<ProductImageRecord[]> {
    this.listImagesCalls.push({ productId, storeId });
    return this.collectImages(productId, storeId);
  }

  /**
   * Mirrors the real drivers: ownership resolves through `products.storeId` and
   * the order is primary first, then `sortOrder` ascending, then `id` ascending.
   * A product owned by another store yields nothing at all.
   */
  private collectImages(productId: string, storeId: string): ProductImageRecord[] {
    const product = this.products.get(productId);
    if (product === undefined || product.storeId !== storeId) {
      return [];
    }
    return Array.from(this.images.values())
      .filter((image) => image.productId === productId)
      .sort(
        (left, right) =>
          Number(right.isPrimary) - Number(left.isPrimary) ||
          left.sortOrder - right.sortOrder ||
          left.id.localeCompare(right.id),
      );
  }

  async findByStoreAndSlug(storeId: string, slug: string): Promise<ProductRecord | null> {
    return (
      Array.from(this.products.values()).find(
        (product) => product.storeId === storeId && product.slug === slug,
      ) ?? null
    );
  }

  async createProduct(input: CreateProductInput): Promise<CreateProductResult> {
    if (this.forceCreateConflict) {
      return { ok: false, reason: "PRODUCT_SLUG_IN_USE" };
    }
    const existing = await this.findByStoreAndSlug(input.storeId, input.slug);
    if (existing !== null) {
      return { ok: false, reason: "PRODUCT_SLUG_IN_USE" };
    }
    const now = new Date();
    const product: ProductRecord = {
      id: fakeId(this.nextId),
      storeId: input.storeId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      categoryId: input.categoryId,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.nextId += 1;
    this.products.set(product.id, product);
    return { ok: true, product };
  }

  async createVariant(input: CreateVariantInput): Promise<CreateVariantResult> {
    this.createVariantCalls.push(input);
    if (this.forceSkuConflict) {
      return { ok: false, reason: "SKU_IN_USE" };
    }
    const product = this.products.get(input.productId);
    if (product === undefined || product.storeId !== input.storeId) {
      return { ok: false, reason: "PRODUCT_NOT_FOUND" };
    }
    if (input.sku !== null) {
      const skuInUse = Array.from(this.variants.values()).some(
        (variant) => variant.sku !== null && variant.sku === input.sku,
      );
      if (skuInUse) {
        return { ok: false, reason: "SKU_IN_USE" };
      }
    }
    const now = new Date();
    const variant: VariantRecord = {
      id: fakeId(this.nextId),
      productId: input.productId,
      sku: input.sku,
      name: input.name,
      priceAmountCents: input.priceAmountCents,
      compareAtAmountCents: input.compareAtAmountCents,
      currency: input.currency,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.nextId += 1;
    this.variants.set(variant.id, variant);
    return { ok: true, variant };
  }

  async setInventory(input: SetInventoryInput): Promise<SetInventoryResult> {
    this.setInventoryCalls.push(input);
    const product = this.products.get(input.productId);
    const variant = this.variants.get(input.variantId);
    if (
      product === undefined ||
      variant === undefined ||
      variant.productId !== input.productId ||
      product.storeId !== input.storeId
    ) {
      return { ok: false, reason: "VARIANT_NOT_FOUND" };
    }
    const inventory: InventoryRecord = {
      variantId: input.variantId,
      quantity: input.quantity,
      updatedAt: new Date(),
    };
    this.inventory.set(input.variantId, inventory);
    return { ok: true, inventory };
  }

  async publishProduct(productId: string, storeId: string): Promise<PublishProductResult> {
    const product = this.products.get(productId);
    if (product === undefined || product.storeId !== storeId) {
      return { ok: false, reason: "PRODUCT_NOT_FOUND" };
    }
    if (product.status === "archived") {
      return { ok: false, reason: "PRODUCT_ARCHIVED" };
    }
    const sellable = Array.from(this.variants.values()).some(
      (variant) =>
        variant.productId === productId &&
        variant.status === "active" &&
        variant.priceAmountCents >= 1 &&
        (this.inventory.get(variant.id)?.quantity ?? 0) >= 1,
    );
    if (!sellable) {
      return { ok: false, reason: "NOT_PUBLISHABLE" };
    }
    const updated: ProductRecord = { ...product, status: "active", updatedAt: new Date() };
    this.products.set(productId, updated);
    return { ok: true, product: updated };
  }

  /**
   * Mirrors both real drivers: ownership is resolved before anything is
   * written, and every inserted row is forced non-primary so the
   * one-primary-per-product invariant can never be violated from this path.
   */
  async addProductImages(input: AddProductImagesInput): Promise<AddProductImagesResult> {
    this.addImagesCalls.push(input);
    if (this.forceAddImagesConflict) {
      return { ok: false, reason: "PRODUCT_NOT_FOUND" };
    }
    const product = this.products.get(input.productId);
    if (product === undefined || product.storeId !== input.storeId) {
      return { ok: false, reason: "PRODUCT_NOT_FOUND" };
    }
    const createdAt = new Date();
    const images = input.images.map((image) => {
      const record: ProductImageRecord = {
        id: fakeId(this.nextId),
        productId: input.productId,
        url: image.url,
        storageKey: image.storageKey,
        altText: image.altText,
        sortOrder: image.sortOrder,
        isPrimary: false,
        createdAt,
      };
      this.nextId += 1;
      this.images.set(record.id, record);
      return record;
    });
    return { ok: true, images };
  }

  /**
   * Ownership-scoped count, matching both real drivers: an unowned product counts
   * zero rather than throwing, which is what lets the service distinguish "full"
   * from "not yours" from the count alone.
   */
  async countImagesByProduct(productId: string, storeId: string): Promise<number> {
    const product = this.products.get(productId);
    if (product === undefined || product.storeId !== storeId) {
      return 0;
    }
    return [...this.images.values()].filter((image) => image.productId === productId).length;
  }

  /** Deletes the row only; stored bytes are the storage layer's business. */
  async deleteProductImage(input: DeleteProductImageInput): Promise<DeleteProductImageResult> {
    this.deleteImageCalls.push(input);
    const product = this.products.get(input.productId);
    if (product === undefined || product.storeId !== input.storeId) {
      return { ok: false, reason: "PRODUCT_NOT_FOUND" };
    }
    const image = this.images.get(input.imageId);
    if (image === undefined || image.productId !== input.productId) {
      return { ok: false, reason: "IMAGE_NOT_FOUND" };
    }
    this.images.delete(input.imageId);
    return { ok: true, image };
  }

  /**
   * Idempotent promotion with clear-then-set, so the fake enforces the same
   * one-primary-per-product invariant the real drivers do.
   */
  async setPrimaryProductImage(
    input: SetPrimaryProductImageInput,
  ): Promise<SetPrimaryProductImageResult> {
    this.setPrimaryImageCalls.push(input);
    const product = this.products.get(input.productId);
    if (product === undefined || product.storeId !== input.storeId) {
      return { ok: false, reason: "PRODUCT_NOT_FOUND" };
    }
    const target = this.images.get(input.imageId);
    if (target === undefined || target.productId !== input.productId) {
      return { ok: false, reason: "IMAGE_NOT_FOUND" };
    }
    if (target.isPrimary) {
      return { ok: true, image: target };
    }
    // Clear-then-set, mirroring both drivers: the one-primary invariant never
    // sees two primaries, not even transiently inside the fake.
    for (const image of [...this.images.values()]) {
      if (image.productId === input.productId && image.isPrimary) {
        this.images.set(image.id, { ...image, isPrimary: false });
      }
    }
    const promoted: ProductImageRecord = { ...target, isPrimary: true };
    this.images.set(promoted.id, promoted);
    return { ok: true, image: promoted };
  }

  seedProduct(product: ProductRecord): void {
    this.products.set(product.id, product);
  }

  seedVariant(variant: VariantRecord): void {
    this.variants.set(variant.id, variant);
  }

  seedInventory(inventory: InventoryRecord): void {
    this.inventory.set(inventory.variantId, inventory);
  }

  seedImage(image: ProductImageRecord): void {
    this.images.set(image.id, image);
  }
}

/** Minimal catalog-repository fake: only the active-category list is used. */
class FakeCatalogRepository implements CatalogRepository {
  categories: CatalogCategoryRecord[] = [];

  async listActiveCategories(): Promise<CatalogCategoryRecord[]> {
    return this.categories;
  }

  async listActiveProducts(): Promise<never> {
    throw new Error("not exercised by seller service tests");
  }

  async findProductBySlug(): Promise<never> {
    throw new Error("not exercised by seller service tests");
  }

  async findVariantById(): Promise<never> {
    throw new Error("not exercised by seller service tests");
  }

  async findActiveStoreBySlug(): Promise<never> {
    throw new Error("not exercised by seller service tests");
  }

  async listStoreProducts(): Promise<never> {
    throw new Error("not exercised by seller service tests");
  }
}

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  const now = new Date();
  return {
    id: "user-authenticated",
    email: "user@example.com",
    name: "Ada Lovelace",
    role: "customer",
    status: "active",
    passwordHash: "hash",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const validBody = {
  slug: "  Ada-Shop ",
  displayName: "  Ada Lovelace  ",
  storeName: "  Ada's Store  ",
  storeSlug: "  ada-store ",
};

/**
 * Deterministic canonical UUIDv7-shaped id so service-side `isValidId` checks
 * (mirroring the real repository) accept the fake records.
 */
function fakeId(seq: number): string {
  return `01955f00-0000-7000-8000-${seq.toString(16).padStart(12, "0")}`;
}

/** Build a `product_images` row for the fake repository; `url` defaults off the id. */
function imageRecord(input: {
  id: string;
  productId: string;
  sortOrder?: number;
  isPrimary?: boolean;
  altText?: string | null;
  storageKey?: string | null;
}): ProductImageRecord {
  return {
    id: input.id,
    productId: input.productId,
    url: `https://cdn.test/${input.id}.jpg`,
    storageKey: input.storageKey ?? null,
    altText: input.altText ?? null,
    sortOrder: input.sortOrder ?? 0,
    isPrimary: input.isPrimary ?? false,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

/**
 * Header-shaped byte fixtures for the upload tests. The service only ever sniffs
 * the first bytes, so a real encoder's output would exercise the same path; these
 * are built from the format's signature plus enough structure to identify it, and
 * every one is padded past the sniffer's 16-byte floor so a failure is about the
 * signature under test rather than about a short buffer.
 */
function imageBytes(signature: number[]): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(signature);
  return bytes;
}

function pngBytes(seed = 0): Uint8Array {
  return imageBytes([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x10, seed & 0xff,
  ]);
}

function jpegBytes(): Uint8Array {
  return imageBytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]);
}

function webpBytes(): Uint8Array {
  return imageBytes([
    0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  ]);
}

function avifBytes(): Uint8Array {
  return imageBytes([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
    0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00,
  ]);
}

/**
 * In-memory media storage fake. It records every call so the upload tests can
 * assert what reached storage and, just as importantly, what did not.
 */
class FakeMediaStorage implements MediaStorage {
  readonly putCalls: Array<{ key: string; object: MediaObjectInput }> = [];
  readonly deleteCalls: string[] = [];
  readonly getCalls: string[] = [];
  /** Keys the fake should report as stored, read back by `get`. */
  readonly objects = new Map<string, MediaObjectOutput>();

  async put(key: string, object: MediaObjectInput): Promise<void> {
    this.putCalls.push({ key, object });
    this.objects.set(key, { bytes: object.bytes, contentType: object.contentType });
  }

  async get(key: string): Promise<MediaObjectOutput | null> {
    this.getCalls.push(key);
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.objects.delete(key);
  }

  publicUrl(key: string): string {
    return `https://media.test/${key}`;
  }
}

async function expectSellerError(
  run: () => Promise<unknown>,
  code: string,
  statusCode: number,
): Promise<void> {
  try {
    await run();
    expect.unreachable(`expected an AppError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    if (!(error instanceof AppError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    expect(error.statusCode).toBe(statusCode);
  }
}

describe("SellerService", () => {
  let repository: FakeSellerRepository;
  let products: FakeProductRepository;
  let catalog: FakeCatalogRepository;
  let mediaStorage: FakeMediaStorage;
  let service: SellerService;

  beforeEach(() => {
    repository = new FakeSellerRepository();
    products = new FakeProductRepository();
    catalog = new FakeCatalogRepository();
    mediaStorage = new FakeMediaStorage();
    service = new SellerService({
      sellerRepository: repository,
      productRepository: products,
      catalogRepository: catalog,
      mediaStorage,
    });
  });

  function seedApprovedSellerForProductReads(): void {
    repository.seedProfile({
      id: "sp-reads",
      userId: "user-authenticated",
      slug: "approved-shop",
      displayName: "Approved Seller",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    repository.seedStore({
      id: "st-reads",
      sellerProfileId: "sp-reads",
      name: "Approved Shop",
      slug: "approved-shop",
      description: null,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  describe("onboard", () => {
    it("valid onboarding returns a pending profile and a draft store", async () => {
      const result = await service.onboard(makeUser(), validBody);

      expect(result.sellerProfile.userId).toBe("user-authenticated");
      expect(result.sellerProfile.status).toBe("pending");
      expect(result.sellerProfile.slug).toBe("ada-shop");
      expect(result.store.status).toBe("draft");
      expect(result.store.slug).toBe("ada-store");
      expect(result.store.description).toBeNull();
    });

    it("normalizes slugs and names before reaching the repository", async () => {
      await service.onboard(makeUser(), validBody);

      expect(repository.lastCreateInput).toEqual({
        userId: "user-authenticated",
        profileSlug: "ada-shop",
        displayName: "Ada Lovelace",
        storeName: "Ada's Store",
        storeSlug: "ada-store",
      });
    });

    it("rejects an invalid profile slug", async () => {
      await expectSellerError(
        () => service.onboard(makeUser(), { ...validBody, slug: "Not Lowercase!" }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects an invalid store slug", async () => {
      await expectSellerError(
        () => service.onboard(makeUser(), { ...validBody, storeSlug: "no-good!" }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects an empty display name", async () => {
      await expectSellerError(
        () => service.onboard(makeUser(), { ...validBody, displayName: "   " }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects a display name that is too long", async () => {
      await expectSellerError(
        () => service.onboard(makeUser(), { ...validBody, displayName: "x".repeat(81) }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects an empty store name", async () => {
      await expectSellerError(
        () => service.onboard(makeUser(), { ...validBody, storeName: "" }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects a store name that is too long", async () => {
      await expectSellerError(
        () => service.onboard(makeUser(), { ...validBody, storeName: "x".repeat(121) }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("accumulates errors for every missing required field", async () => {
      const error = await service
        .onboard(makeUser(), {})
        .then(
          () => {
            throw new Error("expected a ValidationError");
          },
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) {
        throw error;
      }
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.fields).toEqual({
        slug: ["Slug is required."],
        displayName: ["Display name is required."],
        storeName: ["Store name is required."],
        storeSlug: ["Store slug is required."],
      });
    });

    it("rejects a non-object body through the shared validation mechanism", async () => {
      const error = await service
        .onboard(makeUser(), null)
        .then(
          () => {
            throw new Error("expected a ValidationError");
          },
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) {
        throw error;
      }
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.fields).toEqual({
        body: ["Request body must be a JSON object."],
      });
    });

    it("duplicate seller profile for the user returns SELLER_PROFILE_EXISTS 409", async () => {
      repository.seedProfile({
        id: "sp-existing",
        userId: "user-authenticated",
        slug: "existing-profile",
        displayName: "Existing",
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expectSellerError(
        () => service.onboard(makeUser(), validBody),
        AUTH_ERROR_CODES.SELLER_PROFILE_EXISTS,
        409,
      );
    });

    it("a taken profile slug returns SLUG_IN_USE 409", async () => {
      repository.seedProfile({
        id: "sp-existing",
        userId: "user-other",
        slug: "ada-shop",
        displayName: "Existing",
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expectSellerError(
        () => service.onboard(makeUser(), validBody),
        AUTH_ERROR_CODES.SLUG_IN_USE,
        409,
      );
    });

    it("a taken store slug returns SLUG_IN_USE 409", async () => {
      repository.seedStore({
        id: "st-existing",
        sellerProfileId: "sp-existing",
        name: "Existing",
        slug: "ada-store",
        description: null,
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expectSellerError(
        () => service.onboard(makeUser(), validBody),
        AUTH_ERROR_CODES.SLUG_IN_USE,
        409,
      );
    });

    it("a conflict appearing between pre-check and insert still maps to 409", async () => {
      repository.forceConflict = "STORE_SLUG_IN_USE";

      await expectSellerError(
        () => service.onboard(makeUser(), validBody),
        AUTH_ERROR_CODES.SLUG_IN_USE,
        409,
      );
    });

    it("a profile-exists conflict on insert maps to SELLER_PROFILE_EXISTS 409", async () => {
      repository.forceConflict = "SELLER_PROFILE_EXISTS";

      await expectSellerError(
        () => service.onboard(makeUser(), validBody),
        AUTH_ERROR_CODES.SELLER_PROFILE_EXISTS,
        409,
      );
    });

    it("rejects a suspended account before any repository lookup", async () => {
      const user = makeUser({ status: "suspended" });

      await expectSellerError(
        () => service.onboard(user, validBody),
        AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
        403,
      );
      expect(repository.lastCreateInput).toBeNull();
    });

    it("rejects a deleted account before any repository lookup", async () => {
      const user = makeUser({ status: "deleted" });

      await expectSellerError(
        () => service.onboard(user, validBody),
        AUTH_ERROR_CODES.ACCOUNT_DELETED,
        403,
      );
      expect(repository.lastCreateInput).toBeNull();
    });

    it("uses the authenticated user id and ignores spoofed userId/role/status in the body", async () => {
      const result = await service.onboard(makeUser(), {
        ...validBody,
        userId: "another-user",
        role: "seller",
        status: "active",
      });

      expect(result.sellerProfile.userId).toBe("user-authenticated");
      expect(repository.lastCreateInput?.userId).toBe("user-authenticated");
      expect(repository.lastCreateInput).not.toHaveProperty("role");
      expect(repository.lastCreateInput).not.toHaveProperty("status");
    });

    it("never changes the user's role", async () => {
      const user = makeUser();
      await service.onboard(user, validBody);

      expect(user.role).toBe("customer");
      expect(user.status).toBe("active");
    });

    it("DTOs contain exactly the shared fields and no sensitive data", async () => {
      const result = await service.onboard(makeUser(), validBody);

      expect(Object.keys(result.sellerProfile).sort()).toEqual([
        "displayName",
        "id",
        "slug",
        "status",
        "userId",
      ]);
      expect(Object.keys(result.store).sort()).toEqual([
        "description",
        "id",
        "name",
        "slug",
        "status",
      ]);
      expect(JSON.stringify(result)).not.toContain("passwordHash");
      expect(JSON.stringify(result)).not.toContain("session");
      expect(JSON.stringify(result)).not.toContain("createdAt");
      expect(JSON.stringify(result)).not.toContain("updatedAt");
    });
  });

  describe("activateSeller", () => {
    function seedPendingSeller(userId: string): void {
      repository.seedProfile({
        id: "sp-pending",
        userId,
        slug: "pending-shop",
        displayName: "Pending Seller",
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-pending",
        sellerProfileId: "sp-pending",
        name: "Pending Shop",
        slug: "pending-shop",
        description: null,
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    it("activates a pending seller: profile, store and DTO projection", async () => {
      seedPendingSeller("seller-user");

      const result = await service.activateSeller("seller-user");

      expect(result.sellerProfile.status).toBe("active");
      expect(result.store.status).toBe("active");
      expect(result.transitioned).toBe(true);
      expect(result.sellerProfile.slug).toBe("pending-shop");
      expect(Object.keys(result.sellerProfile).sort()).toEqual([
        "displayName",
        "id",
        "slug",
        "status",
        "userId",
      ]);
      expect(JSON.stringify(result)).not.toContain("passwordHash");
    });

    it("is idempotent for an already-active profile", async () => {
      seedPendingSeller("seller-user");
      repository.seedProfile({
        id: "sp-active",
        userId: "active-user",
        slug: "active-shop",
        displayName: "Active Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-active",
        sellerProfileId: "sp-active",
        name: "Active Shop",
        slug: "active-shop",
        description: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.activateSeller("active-user");

      expect(result.sellerProfile.status).toBe("active");
      expect(result.sellerProfile.id).toBe("sp-active");
      // No `pending → active` transition happened, so callers must not treat
      // this as a real activation (the admin layer uses this to skip audit).
      expect(result.transitioned).toBe(false);
    });

    it("returns NOT_FOUND 404 when the user has no seller profile", async () => {
      await expectSellerError(
        () => service.activateSeller("unknown-user"),
        "NOT_FOUND",
        404,
      );
    });

    it("returns SELLER_ACTIVATION_BLOCKED 409 for a suspended profile", async () => {
      repository.seedProfile({
        id: "sp-suspended",
        userId: "suspended-user",
        slug: "suspended-shop",
        displayName: "Suspended Seller",
        status: "suspended",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expectSellerError(
        () => service.activateSeller("suspended-user"),
        AUTH_ERROR_CODES.SELLER_ACTIVATION_BLOCKED,
        409,
      );
    });

    it("returns SELLER_ACTIVATION_BLOCKED 409 for a rejected profile", async () => {
      repository.seedProfile({
        id: "sp-rejected",
        userId: "rejected-user",
        slug: "rejected-shop",
        displayName: "Rejected Seller",
        status: "rejected",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expectSellerError(
        () => service.activateSeller("rejected-user"),
        AUTH_ERROR_CODES.SELLER_ACTIVATION_BLOCKED,
        409,
      );
    });
  });

  describe("listProducts", () => {
    it("uses the approved store, forwards bounded pagination, and returns safe summaries", async () => {
      seedApprovedSellerForProductReads();
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      products.seedProduct({
        id: fakeId(10),
        storeId: "st-reads",
        slug: "newest-owned",
        name: "Newest Owned",
        description: "Must not be listed",
        categoryId: "category-1",
        status: "active",
        createdAt,
        updatedAt: createdAt,
      });
      products.seedProduct({
        id: fakeId(11),
        storeId: "st-reads",
        slug: "older-owned",
        name: "Older Owned",
        description: null,
        categoryId: null,
        status: "draft",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: createdAt,
      });
      products.seedProduct({
        id: fakeId(12),
        storeId: "st-other",
        slug: "other-owned",
        name: "Other Owned",
        description: null,
        categoryId: null,
        status: "archived",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: createdAt,
      });

      const result = await service.listProducts(makeUser({ role: "seller" }), {
        limit: "1",
        cursor: "opaque-cursor",
      });

      expect(products.listCalls).toEqual([
        { storeId: "st-reads", query: { limit: 1, cursor: "opaque-cursor" } },
      ]);
      expect(result).toEqual({
        items: [
          {
            id: fakeId(10),
            slug: "newest-owned",
            name: "Newest Owned",
            categoryId: "category-1",
            status: "active",
            createdAt: createdAt.toISOString(),
          },
        ],
        nextCursor: `next:${fakeId(10)}`,
      });
      expect(result.items[0]).not.toHaveProperty("storeId");
      expect(result.items[0]).not.toHaveProperty("description");
      expect(result.items[0]).not.toHaveProperty("updatedAt");
    });

    it("uses the shared default page size when limit is omitted", async () => {
      seedApprovedSellerForProductReads();

      await service.listProducts(makeUser({ role: "seller" }), undefined);

      expect(products.listCalls[0]?.query).toEqual({
        limit: SELLER_PRODUCT_PAGE_LIMITS.default,
        cursor: null,
      });
    });

    it.each(["0", "51", "1.5", "abc"])(
      "rejects invalid limit %s before querying products",
      async (limit) => {
        seedApprovedSellerForProductReads();

        await expect(
          service.listProducts(makeUser({ role: "seller" }), { limit }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 422 });
        expect(products.listCalls).toHaveLength(0);
      },
    );
  });

  describe("getProduct", () => {
    it("returns owned detail with variants and nullable inventory without ownership fields", async () => {
      seedApprovedSellerForProductReads();
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      products.seedProduct({
        id: fakeId(20),
        storeId: "st-reads",
        slug: "owned-detail",
        name: "Owned Detail",
        description: "Complete product",
        categoryId: null,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      });
      products.seedVariant({
        id: fakeId(21),
        productId: fakeId(20),
        sku: null,
        name: "No Inventory",
        priceAmountCents: 1200,
        compareAtAmountCents: null,
        currency: "USD",
        status: "active",
        createdAt,
        updatedAt: createdAt,
      });
      const stockedVariant: VariantRecord = {
        id: fakeId(22),
        productId: fakeId(20),
        sku: "STOCKED",
        name: "Stocked",
        priceAmountCents: 1500,
        compareAtAmountCents: 1800,
        currency: "USD",
        status: "inactive",
        createdAt: new Date("2026-06-02T00:00:00.000Z"),
        updatedAt: createdAt,
      };
      products.seedVariant(stockedVariant);
      products.seedInventory({
        variantId: stockedVariant.id,
        quantity: 7,
        updatedAt: createdAt,
      });

      const result = await service.getProduct(makeUser({ role: "seller" }), fakeId(20));

      expect(result).toMatchObject({
        id: fakeId(20),
        name: "Owned Detail",
        description: "Complete product",
        variants: [
          { id: fakeId(21), name: "No Inventory", inventory: null },
          { id: fakeId(22), name: "Stocked", inventory: { quantity: 7 } },
        ],
      });
      expect(result).not.toHaveProperty("storeId");
      expect(result).not.toHaveProperty("updatedAt");
    });

    it("returns the same 404 for malformed, unknown, and cross-store product ids", async () => {
      seedApprovedSellerForProductReads();
      products.seedProduct({
        id: fakeId(30),
        storeId: "st-other",
        slug: "other-detail",
        name: "Other Detail",
        description: null,
        categoryId: null,
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const user = makeUser({ role: "seller" });

      for (const productId of ["not-an-id", fakeId(31), fakeId(30)]) {
        await expectSellerError(
          () => service.getProduct(user, productId),
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          404,
        );
      }
    });

    it("embeds the product's images in the repository's canonical order", async () => {
      seedApprovedSellerForProductReads();
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      products.seedProduct({
        id: fakeId(35),
        storeId: "st-reads",
        slug: "detail-with-media",
        name: "Detail With Media",
        description: null,
        categoryId: null,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      });
      products.seedImage(imageRecord({ id: fakeId(36), productId: fakeId(35), sortOrder: 0 }));
      products.seedImage(
        imageRecord({ id: fakeId(37), productId: fakeId(35), sortOrder: 4, isPrimary: true }),
      );

      const result = await service.getProduct(makeUser({ role: "seller" }), fakeId(35));

      expect(result.images.map((image) => image.id)).toEqual([fakeId(37), fakeId(36)]);
      expect(result.images[0]).toMatchObject({
        productId: fakeId(35),
        url: "https://cdn.test/01955f00-0000-7000-8000-000000000025.jpg",
        isPrimary: true,
        altText: null,
        sortOrder: 4,
        createdAt: "2026-06-01T00:00:00.000Z",
      });
    });

    it("returns an empty image list in detail for a product with no images", async () => {
      seedApprovedSellerForProductReads();
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      products.seedProduct({
        id: fakeId(38),
        storeId: "st-reads",
        slug: "detail-without-media",
        name: "Detail Without Media",
        description: null,
        categoryId: null,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      });

      const result = await service.getProduct(makeUser({ role: "seller" }), fakeId(38));

      expect(result.images).toEqual([]);
    });
  });

  describe("listProductImages", () => {
    /** Seed an approved-seller-owned product, returning its id. */
    function seedOwnedProduct(seq: number): string {
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      const productId = fakeId(seq);
      products.seedProduct({
        id: productId,
        storeId: "st-reads",
        slug: `owned-product-${seq}`,
        name: `Owned Product ${seq}`,
        description: null,
        categoryId: null,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      });
      return productId;
    }

    it("returns the owned product's images in canonical order and resolves the store from the session", async () => {
      seedApprovedSellerForProductReads();
      const productId = seedOwnedProduct(40);
      // Inserted out of order: the service must not re-sort, it forwards the
      // driver's order verbatim.
      products.seedImage(imageRecord({ id: fakeId(42), productId, sortOrder: 2 }));
      products.seedImage(
        imageRecord({
          id: fakeId(43),
          productId,
          sortOrder: 7,
          isPrimary: true,
          altText: "Hero shot",
        }),
      );
      products.seedImage(imageRecord({ id: fakeId(41), productId, sortOrder: 2 }));
      const siblingProductId = seedOwnedProduct(44);
      products.seedImage(
        imageRecord({ id: fakeId(45), productId: siblingProductId, sortOrder: 0, isPrimary: true }),
      );

      const result = await service.listProductImages(makeUser({ role: "seller" }), productId);

      expect(result.productId).toBe(productId);
      expect(result.images.map((image) => image.id)).toEqual([fakeId(43), fakeId(41), fakeId(42)]);
      expect(result.images[0]?.isPrimary).toBe(true);
      expect(result.images[0]?.altText).toBe("Hero shot");
      // `storeId` is taken from the authenticated seller's store, never input.
      expect(products.listImagesCalls).toEqual([{ productId, storeId: "st-reads" }]);
    });

    it("returns an empty list for an owned product with no images", async () => {
      seedApprovedSellerForProductReads();
      const productId = seedOwnedProduct(50);

      const result = await service.listProductImages(makeUser({ role: "seller" }), productId);

      expect(result).toEqual({ productId, images: [] });
    });

    it("returns the same 404 for malformed, unknown, and cross-store product ids", async () => {
      seedApprovedSellerForProductReads();
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      const foreignProductId = fakeId(60);
      products.seedProduct({
        id: foreignProductId,
        storeId: "st-other",
        slug: "foreign-images",
        name: "Foreign Images",
        description: null,
        categoryId: null,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      });
      products.seedImage(
        imageRecord({ id: fakeId(61), productId: foreignProductId, isPrimary: true }),
      );
      const user = makeUser({ role: "seller" });

      for (const productId of ["not-an-id", fakeId(62), foreignProductId]) {
        await expectSellerError(
          () => service.listProductImages(user, productId),
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          404,
        );
      }
      // The product lookup settles the 404 before images are ever read, so a
      // foreign product's rows cannot leak through the image list.
      expect(products.listImagesCalls).toHaveLength(0);
    });

    it("requires an approved seller before any product lookup happens", async () => {
      const customer = makeUser();

      await expectSellerError(
        () => service.listProductImages(customer, fakeId(70)),
        "SELLER_NOT_APPROVED",
        403,
      );
      expect(products.listImagesCalls).toHaveLength(0);
    });
  });

  describe("product image uploads", () => {
    /** Seed an approved seller whose store id is `st-reads`. */
    function seedImageSeller(): void {
      seedApprovedSellerForProductReads();
    }

    /** Seed a product owned by `st-reads` and return its id. */
    function seedOwnedProductWithId(seq: number, storeId = "st-reads"): string {
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      const productId = fakeId(seq);
      products.seedProduct({
        id: productId,
        storeId,
        slug: `image-product-${seq}`,
        name: `Image Product ${seq}`,
        description: null,
        categoryId: null,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      });
      return productId;
    }

    it("stores a sniffed image under a product-scoped key and returns a DTO without the key", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(100);
      const user = makeUser({ role: "seller" });

      const images = await service.addProductImages(user, productId, [{ bytes: pngBytes() }]);

      expect(images).toHaveLength(1);
      // The public DTO is the only read path a client gets: it carries the URL
      // and never the server-side storage key as a field of its own.
      expect(Object.keys(images[0] ?? {}).sort()).toEqual([
        "altText",
        "createdAt",
        "id",
        "isPrimary",
        "productId",
        "sortOrder",
        "url",
      ]);
      // The URL is the storage port's public address of that same opaque key, so
      // the key appears only inside the URL the client is meant to have.
      expect(images[0]?.url).toBe(
        `https://media.test/${products.addImagesCalls[0]?.images[0]?.storageKey}`,
      );
      expect(products.addImagesCalls[0]?.images[0]?.storageKey).toMatch(
        new RegExp(`^products/${productId}/[0-9a-f]{64}\\.png$`),
      );
    });

    it("keys the stored object by product, so identical bytes in two products differ", async () => {
      seedImageSeller();
      const user = makeUser({ role: "seller" });
      const first = seedOwnedProductWithId(101);
      const second = seedOwnedProductWithId(102);
      const bytes = pngBytes();

      await service.addProductImages(user, first, [{ bytes }]);
      await service.addProductImages(user, second, [{ bytes }]);

      const firstKey = products.addImagesCalls[0]?.images[0]?.storageKey;
      const secondKey = products.addImagesCalls[1]?.images[0]?.storageKey;
      // Same digest, different product: the second upload cannot replace the
      // first product's stored object.
      expect(firstKey).not.toBe(secondKey);
      expect(firstKey?.startsWith(`products/${first}/`)).toBe(true);
      expect(secondKey?.startsWith(`products/${second}/`)).toBe(true);
      expect(firstKey?.split("/")[2]).toBe(secondKey?.split("/")[2]);
      expect(mediaStorage.putCalls).toHaveLength(2);
    });

    it("uses the sniffed content type, not any client-declared one", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(103);

      // The upload surface has no MIME field at all, so there is nothing for a
      // caller to lie with: the bytes and only the bytes decide the type.
      const images = await service.addProductImages(makeUser({ role: "seller" }), productId, [
        { bytes: jpegBytes() },
        { bytes: webpBytes() },
        { bytes: avifBytes() },
      ]);

      expect(images).toHaveLength(3);
      expect(mediaStorage.putCalls.map((call) => call.object.contentType)).toEqual([
        "image/jpeg",
        "image/webp",
        "image/avif",
      ]);
      expect(products.addImagesCalls[0]?.images.map((image) => image.storageKey?.split(".").pop())).toEqual([
        "jpg",
        "webp",
        "avif",
      ]);
    });

    it("writes the sniffed byte size to storage, so a recorded size cannot lie", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(104);
      const bytes = pngBytes();

      await service.addProductImages(makeUser({ role: "seller" }), productId, [{ bytes }]);

      expect(mediaStorage.putCalls[0]?.object.size).toBe(bytes.byteLength);
      expect(mediaStorage.putCalls[0]?.object.bytes.byteLength).toBe(bytes.byteLength);
    });

    it("hands storage a copy, so a caller mutating its buffer cannot corrupt the digest", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(105);
      const bytes = pngBytes();

      await service.addProductImages(makeUser({ role: "seller" }), productId, [{ bytes }]);
      const key = products.addImagesCalls[0]?.images[0]?.storageKey as string;
      bytes.fill(0);

      expect((await mediaStorage.get(key))?.bytes.byteLength).toBe(pngBytes().byteLength);
    });

    it("appends after the highest existing sort order without renumbering", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(106);
      products.seedImage(imageRecord({ id: fakeId(107), productId, sortOrder: 0 }));
      products.seedImage(imageRecord({ id: fakeId(108), productId, sortOrder: 5, isPrimary: true }));

      await service.addProductImages(makeUser({ role: "seller" }), productId, [
        { bytes: pngBytes() },
        { bytes: jpegBytes() },
      ]);

      // New images continue at 6, 7; the existing rows keep 0 and 5 so a
      // display order already shown to a shopper cannot be reshuffled.
      expect(products.addImagesCalls[0]?.images.map((image) => image.sortOrder)).toEqual([6, 7]);
    });

    it("starts a fresh product's images at sort order 0", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(109);

      await service.addProductImages(makeUser({ role: "seller" }), productId, [
        { bytes: pngBytes() },
        { bytes: jpegBytes() },
      ]);

      expect(products.addImagesCalls[0]?.images.map((image) => image.sortOrder)).toEqual([0, 1]);
    });

    it("normalizes alt text and stores an empty description as null", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(110);

      const images = await service.addProductImages(makeUser({ role: "seller" }), productId, [
        { bytes: pngBytes(), altText: "  Front view  " },
        { bytes: jpegBytes(), altText: "   " },
        { bytes: webpBytes() },
      ]);

      expect(images.map((image) => image.altText)).toEqual(["Front view", null, null]);
    });

    it("rejects an over-long alt text instead of silently truncating it", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(111);
      const user = makeUser({ role: "seller" });

      // Alt text is validated in the same up-front pass as the bytes, so a
      // rejected description never leaves a stored object behind.
      await expect(
        service.addProductImages(user, productId, [
          { bytes: pngBytes(), altText: "x".repeat(PRODUCT_IMAGE_LIMITS.altTextMaxLength + 1) },
        ]),
      ).rejects.toThrow(ValidationError);
      expect(mediaStorage.putCalls).toHaveLength(0);
      expect(products.addImagesCalls).toHaveLength(0);
    });

    it("names the offending file for an over-long alt text too", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(112);

      try {
        await service.addProductImages(makeUser({ role: "seller" }), productId, [
          { bytes: pngBytes() },
          { bytes: jpegBytes(), altText: "x".repeat(PRODUCT_IMAGE_LIMITS.altTextMaxLength + 1) },
        ]);
        expect.unreachable("expected a ValidationError");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        if (!(error instanceof ValidationError)) {
          throw error;
        }
        expect(error.fields?.imagePosition).toEqual([
          `Image 2: Alt text must be at most ${PRODUCT_IMAGE_LIMITS.altTextMaxLength} characters.`,
        ]);
      }
    });

    it("validates every image before writing any bytes", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(112);
      const user = makeUser({ role: "seller" });

      // Three good files followed by one bad: not one object may be written, or
      // the seller is left with stored images their request never completed.
      await expect(
        service.addProductImages(user, productId, [
          { bytes: pngBytes() },
          { bytes: jpegBytes() },
          { bytes: webpBytes() },
          { bytes: new Uint8Array(0) },
        ]),
      ).rejects.toThrow(ValidationError);

      expect(mediaStorage.putCalls).toHaveLength(0);
      expect(products.addImagesCalls).toHaveLength(0);
    });

    it("names the rejected image's position in the batch, counting from 1", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(113);

      try {
        await service.addProductImages(makeUser({ role: "seller" }), productId, [
          { bytes: pngBytes() },
          { bytes: new TextEncoder().encode("<!doctype html><title>nope</title>") },
        ]);
        expect.unreachable("expected a ValidationError");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        if (!(error instanceof ValidationError)) {
          throw error;
        }
        expect(error.fields?.imagePosition).toEqual([
          "Image 2: Only JPEG, PNG, WebP and AVIF images are accepted.",
        ]);
      }
    });

    it("rejects an empty file and an oversized one with their own messages", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(114);
      const user = makeUser({ role: "seller" });

      try {
        await service.addProductImages(user, productId, [{ bytes: new Uint8Array(0) }]);
        expect.unreachable("expected a ValidationError");
      } catch (error) {
        if (!(error instanceof ValidationError)) {
          throw error;
        }
        expect(error.fields?.imagePosition).toEqual(["Image 1: The file is empty."]);
      }

      const oversized = new Uint8Array(PRODUCT_IMAGE_LIMITS.maxBytesPerFile + 1);
      oversized.set(pngBytes());
      try {
        await service.addProductImages(user, productId, [{ bytes: oversized }]);
        expect.unreachable("expected a ValidationError");
      } catch (error) {
        if (!(error instanceof ValidationError)) {
          throw error;
        }
        expect(error.fields?.imagePosition).toEqual([
          `Image 1: Each image must be at most ${PRODUCT_IMAGE_LIMITS.maxBytesPerFile} bytes.`,
        ]);
      }
    });

    it("rejects a truncated header, which is not a supported image", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(115);

      // The 8-byte PNG signature on its own: a prefix of a real header, and not
      // an image.
      const signatureOnly = pngBytes().slice(0, 8);

      await expect(
        service.addProductImages(makeUser({ role: "seller" }), productId, [{ bytes: signatureOnly }]),
      ).rejects.toThrow(ValidationError);
      expect(mediaStorage.putCalls).toHaveLength(0);
    });

    it("accepts a file of exactly the size limit and rejects one byte more", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(116);
      const user = makeUser({ role: "seller" });
      const atLimit = new Uint8Array(PRODUCT_IMAGE_LIMITS.maxBytesPerFile);
      atLimit.set(pngBytes());

      await expect(service.addProductImages(user, productId, [{ bytes: atLimit }])).resolves.toHaveLength(1);

      const overLimit = new Uint8Array(PRODUCT_IMAGE_LIMITS.maxBytesPerFile + 1);
      overLimit.set(pngBytes());
      await expect(service.addProductImages(user, productId, [{ bytes: overLimit }])).rejects.toThrow(
        ValidationError,
      );
    });

    it("refuses a batch that would push the product past the per-product cap", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(117);
      for (let index = 0; index < PRODUCT_IMAGE_LIMITS.maxPerProduct - 1; index += 1) {
        products.seedImage(imageRecord({ id: fakeId(200 + index), productId, sortOrder: index }));
      }

      // Seven stored, two submitted: the cap is checked before any byte is
      // written, so a refused request leaves no orphaned object behind.
      await expectSellerError(
        () =>
          service.addProductImages(makeUser({ role: "seller" }), productId, [
            { bytes: pngBytes() },
            { bytes: jpegBytes() },
          ]),
        SELLER_PRODUCT_ERROR_CODES.IMAGE_LIMIT_REACHED,
        409,
      );
      expect(mediaStorage.putCalls).toHaveLength(0);
    });

    it("accepts a batch that lands exactly on the per-product cap", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(118);
      for (let index = 0; index < PRODUCT_IMAGE_LIMITS.maxPerProduct - 2; index += 1) {
        products.seedImage(imageRecord({ id: fakeId(300 + index), productId, sortOrder: index }));
      }

      const images = await service.addProductImages(makeUser({ role: "seller" }), productId, [
        { bytes: pngBytes() },
        { bytes: jpegBytes() },
      ]);

      expect(images).toHaveLength(2);
      expect(await products.countImagesByProduct(productId, "st-reads")).toBe(
        PRODUCT_IMAGE_LIMITS.maxPerProduct,
      );
    });

    it("refuses a batch larger than the per-request file cap", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(119);
      const tooMany = Array.from(
        { length: PRODUCT_IMAGE_LIMITS.maxFilesPerRequest + 1 },
        (_unused, index) => ({ bytes: pngBytes(index + 1) }),
      );

      await expectSellerError(
        () => service.addProductImages(makeUser({ role: "seller" }), productId, tooMany),
        SELLER_PRODUCT_ERROR_CODES.IMAGE_LIMIT_REACHED,
        409,
      );
      expect(mediaStorage.putCalls).toHaveLength(0);
    });

    it("treats an empty batch as a checked no-op that still enforces ownership", async () => {
      seedImageSeller();
      const own = seedOwnedProductWithId(120);
      const foreign = seedOwnedProductWithId(121, "st-other");
      const user = makeUser({ role: "seller" });

      expect(await service.addProductImages(user, own, [])).toEqual([]);
      expect(mediaStorage.putCalls).toHaveLength(0);
      await expectSellerError(
        () => service.addProductImages(user, foreign, []),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
    });

    it("rejects another seller's product before reading or writing any media", async () => {
      seedImageSeller();
      const foreign = seedOwnedProductWithId(122, "st-other");

      await expectSellerError(
        () => service.addProductImages(makeUser({ role: "seller" }), foreign, [{ bytes: pngBytes() }]),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
      expect(mediaStorage.putCalls).toHaveLength(0);
      expect(products.addImagesCalls).toHaveLength(0);
    });

    it("returns the same 404 for a malformed, an unknown and a foreign product id", async () => {
      seedImageSeller();
      const foreign = seedOwnedProductWithId(123, "st-other");
      const user = makeUser({ role: "seller" });

      for (const productId of ["not-an-id", "../../etc/passwd", fakeId(124), foreign]) {
        await expectSellerError(
          () => service.addProductImages(user, productId, [{ bytes: pngBytes() }]),
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          404,
        );
      }
      // A traversal-shaped id is refused before a key is ever built, so nothing
      // client-supplied can address a directory.
      expect(mediaStorage.putCalls).toHaveLength(0);
    });

    it("requires an approved seller before touching media", async () => {
      const customer = makeUser();

      await expectSellerError(
        () => service.addProductImages(customer, fakeId(125), [{ bytes: pngBytes() }]),
        "SELLER_NOT_APPROVED",
        403,
      );
      expect(mediaStorage.putCalls).toHaveLength(0);
    });

    it("reports a lost race as a 404 rather than a success with no rows", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(126);
      products.forceAddImagesConflict = true;

      await expectSellerError(
        () => service.addProductImages(makeUser({ role: "seller" }), productId, [{ bytes: pngBytes() }]),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
    });
  });

  describe("deleteProductImage", () => {
    /** Seed an approved seller whose store id is `st-reads`. */
    function seedImageSeller(): void {
      seedApprovedSellerForProductReads();
    }

    /** Seed a product owned by `storeId` and return its id. */
    function seedOwnedProductWithId(seq: number, storeId = "st-reads"): string {
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      const productId = fakeId(seq);
      products.seedProduct({
        id: productId,
        storeId,
        slug: `image-product-${seq}`,
        name: `Image Product ${seq}`,
        description: null,
        categoryId: null,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      });
      return productId;
    }

    it("removes the row and returns the deleted image without its storage key", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(400);
      products.seedImage(
        imageRecord({ id: fakeId(401), productId, storageKey: `products/${productId}/a.png` }),
      );

      const deleted = await service.deleteProductImage(
        makeUser({ role: "seller" }),
        productId,
        fakeId(401),
      );

      expect(deleted.id).toBe(fakeId(401));
      expect(Object.keys(deleted).sort()).toEqual([
        "altText",
        "createdAt",
        "id",
        "isPrimary",
        "productId",
        "sortOrder",
        "url",
      ]);
      expect(products.deleteImageCalls).toEqual([
        { productId, imageId: fakeId(401), storeId: "st-reads" },
      ]);
      expect(await products.listImagesByProduct(productId, "st-reads")).toEqual([]);
    });

    it("does not touch stored bytes, which is a later phase's concern", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(402);
      const key = `products/${productId}/a.png`;
      products.seedImage(imageRecord({ id: fakeId(403), productId, storageKey: key }));
      const stored = pngBytes();
      await mediaStorage.put(key, {
        bytes: stored.buffer as ArrayBuffer,
        contentType: "image/png",
        size: stored.byteLength,
      });

      await service.deleteProductImage(makeUser({ role: "seller" }), productId, fakeId(403));

      // The object survives its row: byte reclamation is deliberately separate,
      // and a delete that destroyed bytes could not be undone once the row is gone.
      expect(mediaStorage.deleteCalls).toEqual([]);
      expect(await mediaStorage.get(key)).not.toBeNull();
    });

    it("may leave a product with no primary image, which is a valid state", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(404);
      products.seedImage(imageRecord({ id: fakeId(405), productId, isPrimary: true }));
      products.seedImage(imageRecord({ id: fakeId(406), productId, sortOrder: 1 }));

      await service.deleteProductImage(makeUser({ role: "seller" }), productId, fakeId(405));

      const remaining = await products.listImagesByProduct(productId, "st-reads");
      expect(remaining.map((image) => image.isPrimary)).toEqual([false]);
    });

    it("rejects an image belonging to another product of the same seller", async () => {
      seedImageSeller();
      const first = seedOwnedProductWithId(407);
      const second = seedOwnedProductWithId(408);
      products.seedImage(imageRecord({ id: fakeId(409), productId: second }));

      await expectSellerError(
        () => service.deleteProductImage(makeUser({ role: "seller" }), first, fakeId(409)),
        SELLER_PRODUCT_ERROR_CODES.IMAGE_NOT_FOUND,
        404,
      );
      expect(products.deleteImageCalls).toEqual([
        { productId: first, imageId: fakeId(409), storeId: "st-reads" },
      ]);
    });

    it("reports an unowned product as PRODUCT_NOT_FOUND, never as a missing image", async () => {
      seedImageSeller();
      const foreign = seedOwnedProductWithId(410, "st-other");
      products.seedImage(imageRecord({ id: fakeId(411), productId: foreign }));

      await expectSellerError(
        () => service.deleteProductImage(makeUser({ role: "seller" }), foreign, fakeId(411)),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
    });

    it("rejects malformed ids before reaching the repository", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(412);

      // A malformed id is refused outright: there is nothing to look up, so the
      // repository is never asked.
      for (const [badProduct, badImage] of [
        [productId, "not-an-id"],
        ["not-an-id", fakeId(414)],
        ["../../etc/passwd", fakeId(414)],
      ] as const) {
        await expectSellerError(
          () => service.deleteProductImage(makeUser({ role: "seller" }), badProduct, badImage),
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          404,
        );
      }
      expect(products.deleteImageCalls).toHaveLength(0);
    });

    it("sends a well-formed but unknown product to the repository, which reports it as missing", async () => {
      seedImageSeller();

      // Ownership cannot be decided by format-checking an id, so a well-formed id
      // is resolved against the store; the 404 comes from that lookup.
      await expectSellerError(
        () => service.deleteProductImage(makeUser({ role: "seller" }), fakeId(413), fakeId(414)),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
      expect(products.deleteImageCalls).toEqual([
        { productId: fakeId(413), imageId: fakeId(414), storeId: "st-reads" },
      ]);
    });

    it("requires an approved seller", async () => {
      await expectSellerError(
        () => service.deleteProductImage(makeUser(), fakeId(415), fakeId(416)),
        "SELLER_NOT_APPROVED",
        403,
      );
    });
  });

  describe("setPrimaryProductImage", () => {
    /** Seed an approved seller whose store id is `st-reads`. */
    function seedImageSeller(): void {
      seedApprovedSellerForProductReads();
    }

    /** Seed a product owned by `st-reads` and return its id. */
    function seedOwnedProductWithId(seq: number): string {
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      const productId = fakeId(seq);
      products.seedProduct({
        id: productId,
        storeId: "st-reads",
        slug: `image-product-${seq}`,
        name: `Image Product ${seq}`,
        description: null,
        categoryId: null,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      });
      return productId;
    }

    it("promotes an image, demotes the previous primary and leaves other rows alone", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(500);
      products.seedImage(imageRecord({ id: fakeId(501), productId, isPrimary: true, sortOrder: 0 }));
      products.seedImage(imageRecord({ id: fakeId(502), productId, sortOrder: 1 }));
      products.seedImage(imageRecord({ id: fakeId(503), productId, sortOrder: 2 }));

      const promoted = await service.setPrimaryProductImage(
        makeUser({ role: "seller" }),
        productId,
        fakeId(503),
      );

      expect(promoted.isPrimary).toBe(true);
      expect(products.setPrimaryImageCalls).toEqual([
        { productId, imageId: fakeId(503), storeId: "st-reads" },
      ]);
      const listed = await products.listImagesByProduct(productId, "st-reads");
      // Exactly one primary survives, and the canonical order (primary, then
      // sort order, then id) puts the promoted image first even though it sorted last.
      expect(listed.filter((image) => image.isPrimary).map((image) => image.id)).toEqual([fakeId(503)]);
      expect(listed.map((image) => image.id)).toEqual([
        fakeId(503),
        fakeId(501),
        fakeId(502),
      ]);
      // Only the flag moved: no sort order was renumbered.
      expect(listed.map((image) => image.sortOrder)).toEqual([2, 0, 1]);
    });

    it("is idempotent, so a retried promotion still succeeds", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(504);
      products.seedImage(imageRecord({ id: fakeId(505), productId, isPrimary: true }));
      const user = makeUser({ role: "seller" });

      const first = await service.setPrimaryProductImage(user, productId, fakeId(505));
      const second = await service.setPrimaryProductImage(user, productId, fakeId(505));

      expect(first.isPrimary).toBe(true);
      expect(second.isPrimary).toBe(true);
      expect(second.id).toBe(first.id);
    });

    it("returns a DTO with no storage key", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(506);
      products.seedImage(
        imageRecord({ id: fakeId(507), productId, storageKey: `products/${productId}/a.png` }),
      );

      const promoted = await service.setPrimaryProductImage(
        makeUser({ role: "seller" }),
        productId,
        fakeId(507),
      );

      expect(Object.keys(promoted).sort()).toEqual([
        "altText",
        "createdAt",
        "id",
        "isPrimary",
        "productId",
        "sortOrder",
        "url",
      ]);
    });

    it("rejects an image of another product, and an unowned product is a 404", async () => {
      seedImageSeller();
      const own = seedOwnedProductWithId(508);
      const sibling = seedOwnedProductWithId(509);
      products.seedImage(imageRecord({ id: fakeId(510), productId: sibling }));

      await expectSellerError(
        () => service.setPrimaryProductImage(makeUser({ role: "seller" }), own, fakeId(510)),
        SELLER_PRODUCT_ERROR_CODES.IMAGE_NOT_FOUND,
        404,
      );

      const foreign = fakeId(511);
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      products.seedProduct({
        id: foreign,
        storeId: "st-other",
        slug: "image-product-foreign",
        name: "Foreign",
        description: null,
        categoryId: null,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      });
      products.seedImage(imageRecord({ id: fakeId(512), productId: foreign }));
      await expectSellerError(
        () => service.setPrimaryProductImage(makeUser({ role: "seller" }), foreign, fakeId(512)),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
    });

    it("rejects malformed ids before reaching the repository", async () => {
      seedImageSeller();
      const productId = seedOwnedProductWithId(513);

      for (const [badProduct, badImage] of [
        [productId, "not-an-id"],
        ["not-an-id", fakeId(515)],
        ["../../etc/passwd", fakeId(515)],
      ] as const) {
        await expectSellerError(
          () => service.setPrimaryProductImage(makeUser({ role: "seller" }), badProduct, badImage),
          SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
          404,
        );
      }
      expect(products.setPrimaryImageCalls).toHaveLength(0);
    });

    it("sends a well-formed but unknown product to the repository, which reports it as missing", async () => {
      seedImageSeller();

      await expectSellerError(
        () => service.setPrimaryProductImage(makeUser({ role: "seller" }), fakeId(514), fakeId(515)),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
      expect(products.setPrimaryImageCalls).toEqual([
        { productId: fakeId(514), imageId: fakeId(515), storeId: "st-reads" },
      ]);
    });

    it("requires an approved seller", async () => {
      await expectSellerError(
        () => service.setPrimaryProductImage(makeUser(), fakeId(516), fakeId(517)),
        "SELLER_NOT_APPROVED",
        403,
      );
    });
  });

  describe("createProduct", () => {
    /**
     * Seed an approved seller: an `active` role user, an `active` profile and
     * an `active` store, plus one active category the product can reference.
     */
    function seedApprovedSeller(): void {
      repository.seedProfile({
        id: "sp-approved",
        userId: "user-authenticated",
        slug: "approved-shop",
        displayName: "Approved Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-approved",
        sellerProfileId: "sp-approved",
        name: "Approved Shop",
        slug: "approved-shop",
        description: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      catalog.categories = [
        { id: "01955f00-0000-7000-8000-000000000001", slug: "electronics", name: "Electronics" },
      ];
    }

    const validBody = {
      name: "Vintage Camera",
      slug: "  Vintage-Camera ",
      description: "A lovely film camera.",
      categoryId: "01955f00-0000-7000-8000-000000000001",
    };

    it("creates a product in the authenticated seller's own store", async () => {
      seedApprovedSeller();

      const product = await service.createProduct(makeUser({ role: "seller" }), validBody);

      expect(product.id).toBeTruthy();
      expect(product.storeId).toBe("st-approved");
      expect(product.slug).toBe("vintage-camera");
      expect(product.name).toBe("Vintage Camera");
      expect(product.description).toBe("A lovely film camera.");
      expect(product.categoryId).toBe("01955f00-0000-7000-8000-000000000001");
      expect(product.status).toBe("draft");
      expect(product.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("maps a missing description and omitted category to null", async () => {
      seedApprovedSeller();

      const product = await service.createProduct(makeUser({ role: "seller" }), {
        name: "Bare Listing",
        slug: "bare-listing",
      });

      expect(product.description).toBeNull();
      expect(product.categoryId).toBeNull();
    });

    it("uses the authenticated user id and ignores spoofed ownership fields", async () => {
      seedApprovedSeller();

      const product = await service.createProduct(makeUser({ role: "seller" }), {
        ...validBody,
        storeId: "st-someone-else",
        sellerProfileId: "sp-someone-else",
        userId: "someone-else",
        status: "active",
      });

      expect(product.storeId).toBe("st-approved");
    });

    it("rejects a customer role before any repository lookup", async () => {
      seedApprovedSeller();

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "customer" }), validBody),
        "SELLER_NOT_APPROVED",
        403,
      );
    });

    it("rejects an admin role", async () => {
      seedApprovedSeller();

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "admin" }), validBody),
        "SELLER_NOT_APPROVED",
        403,
      );
    });

    it("rejects a suspended account before looking up the profile", async () => {
      seedApprovedSeller();

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller", status: "suspended" }), validBody),
        AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
        403,
      );
    });

    it("rejects a deleted account before looking up the profile", async () => {
      seedApprovedSeller();

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller", status: "deleted" }), validBody),
        AUTH_ERROR_CODES.ACCOUNT_DELETED,
        403,
      );
    });

    it("rejects a missing seller profile as SELLER_NOT_APPROVED", async () => {
      repository.seedProfile({
        id: "sp-approved",
        userId: "seller-user",
        slug: "approved-shop",
        displayName: "Approved Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-approved",
        sellerProfileId: "sp-approved",
        name: "Approved Shop",
        slug: "approved-shop",
        description: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller", id: "another-user" }), validBody),
        "SELLER_NOT_APPROVED",
        403,
      );
    });

    it("rejects a pending seller profile as SELLER_NOT_APPROVED", async () => {
      repository.seedProfile({
        id: "sp-pending",
        userId: "seller-user",
        slug: "pending-shop",
        displayName: "Pending Seller",
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-pending",
        sellerProfileId: "sp-pending",
        name: "Pending Shop",
        slug: "pending-shop",
        description: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller" }), validBody),
        "SELLER_NOT_APPROVED",
        403,
      );
    });

    it("rejects an absent store as SELLER_NOT_APPROVED", async () => {
      repository.seedProfile({
        id: "sp-approved",
        userId: "seller-user",
        slug: "approved-shop",
        displayName: "Approved Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller" }), validBody),
        "SELLER_NOT_APPROVED",
        403,
      );
    });

    it("rejects a non-active store as SELLER_NOT_APPROVED", async () => {
      repository.seedProfile({
        id: "sp-approved",
        userId: "seller-user",
        slug: "approved-shop",
        displayName: "Approved Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-draft",
        sellerProfileId: "sp-approved",
        name: "Draft Shop",
        slug: "draft-shop",
        description: null,
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller" }), validBody),
        "SELLER_NOT_APPROVED",
        403,
      );
    });

    it("rejects an unknown or inactive category as CATEGORY_NOT_FOUND", async () => {
      seedApprovedSeller();
      catalog.categories = [
        { id: "cat-other", slug: "other", name: "Other" },
      ];

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller" }), validBody),
        "CATEGORY_NOT_FOUND",
        404,
      );
    });

    it("allows a product without a category even when the catalog is empty", async () => {
      seedApprovedSeller();
      catalog.categories = [];

      const product = await service.createProduct(makeUser({ role: "seller" }), {
        name: "Uncategorized",
        slug: "uncategorized",
      });

      expect(product.categoryId).toBeNull();
    });

    it("reports a duplicate slug within the store as PRODUCT_SLUG_IN_USE 409", async () => {
      seedApprovedSeller();
      await service.createProduct(makeUser({ role: "seller" }), {
        name: "First",
        slug: "same-slug",
      });

      await expectSellerError(
        () =>
          service.createProduct(makeUser({ role: "seller" }), {
            name: "Second",
            slug: "same-slug",
          }),
        "PRODUCT_SLUG_IN_USE",
        409,
      );
    });

    it("allows the same slug in a different store", async () => {
      seedApprovedSeller();
      await service.createProduct(makeUser({ role: "seller" }), {
        name: "Mine",
        slug: "shared-slug",
      });

      repository.seedProfile({
        id: "sp-other",
        userId: "other-seller",
        slug: "other-shop",
        displayName: "Other Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-other",
        sellerProfileId: "sp-other",
        name: "Other Shop",
        slug: "other-shop",
        description: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const product = await service.createProduct(
        makeUser({ role: "seller", id: "other-seller" }),
        { name: "Theirs", slug: "shared-slug" },
      );
      expect(product.storeId).toBe("st-other");
    });

    it("maps a race-triggered create conflict to PRODUCT_SLUG_IN_USE 409", async () => {
      seedApprovedSeller();
      products.forceCreateConflict = true;

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller" }), validBody),
        "PRODUCT_SLUG_IN_USE",
        409,
      );
    });

    it("rejects an invalid name", async () => {
      seedApprovedSeller();

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller" }), { ...validBody, name: "   " }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects an invalid product slug", async () => {
      seedApprovedSeller();

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller" }), { ...validBody, slug: "Not Lowercase!" }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects a non-object body", async () => {
      seedApprovedSeller();

      await expectSellerError(
        () => service.createProduct(makeUser({ role: "seller" }), null),
        "VALIDATION_ERROR",
        422,
      );
    });
  });

  describe("createVariant", () => {
    function seedApprovedSeller(): void {
      repository.seedProfile({
        id: "sp-approved",
        userId: "user-authenticated",
        slug: "approved-shop",
        displayName: "Approved Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-approved",
        sellerProfileId: "sp-approved",
        name: "Approved Shop",
        slug: "approved-shop",
        description: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    async function seedProduct(): Promise<string> {
      seedApprovedSeller();
      const product = await service.createProduct(makeUser({ role: "seller" }), {
        name: "Vintage Camera",
        slug: "vintage-camera",
      });
      return product.id;
    }

    it("creates an active variant on the seller's own draft product", async () => {
      const productId = await seedProduct();

      const data = await service.createVariant(makeUser({ role: "seller" }), productId, {
        name: "Body Only",
        sku: "CAM-BODY",
        priceAmountCents: 49900,
        compareAtAmountCents: 59900,
        currency: "USD",
      });

      expect(data.productId).toBe(productId);
      expect(data.sku).toBe("CAM-BODY");
      expect(data.name).toBe("Body Only");
      expect(data.priceAmountCents).toBe(49900);
      expect(data.compareAtAmountCents).toBe(59900);
      expect(data.currency).toBe("USD");
      expect(data.status).toBe("active");
    });

    it("defaults currency to USD and maps omitted optional fields to null", async () => {
      const productId = await seedProduct();

      const data = await service.createVariant(makeUser({ role: "seller" }), productId, {
        name: "Body Only",
        priceAmountCents: 49900,
      });

      expect(data.currency).toBe(DEFAULT_PRODUCT_CURRENCY);
      expect(data.sku).toBeNull();
      expect(data.compareAtAmountCents).toBeNull();
    });

    it("resolves the store from the session and ignores spoofed ownership/status fields", async () => {
      const productId = await seedProduct();

      const data = await service.createVariant(makeUser({ role: "seller" }), productId, {
        name: "Body Only",
        priceAmountCents: 49900,
        storeId: "st-someone-else",
        sellerProfileId: "sp-someone-else",
        status: "inactive",
      });

      expect(data.status).toBe("active");
      expect(products.createVariantCalls[0]?.storeId).toBe("st-approved");
    });

    it("rejects an unknown product id as PRODUCT_NOT_FOUND 404", async () => {
      seedApprovedSeller();

      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "seller" }), "product-unknown", {
            name: "Body Only",
            priceAmountCents: 100,
          }),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
    });

    it("does not let a seller add a variant to another store's product", async () => {
      seedApprovedSeller();
      const owned = await service.createProduct(makeUser({ role: "seller" }), {
        name: "Mine",
        slug: "mine",
      });
      repository.seedProfile({
        id: "sp-other",
        userId: "other-seller",
        slug: "other-shop",
        displayName: "Other Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-other",
        sellerProfileId: "sp-other",
        name: "Other Shop",
        slug: "other-shop",
        description: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const otherProduct = await service.createProduct(makeUser({ role: "seller", id: "other-seller" }), {
        name: "Theirs",
        slug: "theirs",
      });

      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "seller" }), otherProduct.id, {
            name: "Sneaky",
            priceAmountCents: 100,
          }),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "seller", id: "other-seller" }), owned.id, {
            name: "Sneaky",
            priceAmountCents: 100,
          }),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
    });

    it("maps a duplicate SKU to SKU_IN_USE 409", async () => {
      const productId = await seedProduct();
      await service.createVariant(makeUser({ role: "seller" }), productId, {
        name: "Body Only",
        sku: "CAM-BODY",
        priceAmountCents: 49900,
      });

      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "seller" }), productId, {
            name: "Body Only",
            sku: "CAM-BODY",
            priceAmountCents: 49900,
          }),
        SELLER_PRODUCT_ERROR_CODES.SKU_IN_USE,
        409,
      );
    });

    it("maps a race-triggered SKU conflict to SKU_IN_USE 409", async () => {
      const productId = await seedProduct();
      products.forceSkuConflict = true;

      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "seller" }), productId, {
            name: "Body Only",
            sku: "CAM-BODY",
            priceAmountCents: 49900,
          }),
        SELLER_PRODUCT_ERROR_CODES.SKU_IN_USE,
        409,
      );
    });

    it("rejects a missing variant name", async () => {
      const productId = await seedProduct();

      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "seller" }), productId, {
            name: "   ",
            priceAmountCents: 100,
          }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects an invalid SKU", async () => {
      const productId = await seedProduct();

      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "seller" }), productId, {
            name: "Body Only",
            sku: "bad sku!",
            priceAmountCents: 100,
          }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects a zero price", async () => {
      const productId = await seedProduct();

      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "seller" }), productId, {
            name: "Body Only",
            priceAmountCents: 0,
          }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects a string price", async () => {
      const productId = await seedProduct();

      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "seller" }), productId, {
            name: "Body Only",
            priceAmountCents: "49900",
          }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects an invalid currency", async () => {
      const productId = await seedProduct();

      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "seller" }), productId, {
            name: "Body Only",
            priceAmountCents: 100,
            currency: "usd",
          }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("enforces the seller gate before touching the product", async () => {
      seedApprovedSeller();

      await expectSellerError(
        () =>
          service.createVariant(makeUser({ role: "customer" }), "01955f00-0000-7000-8000-000000000001", {
            name: "Body Only",
            priceAmountCents: 100,
          }),
        "SELLER_NOT_APPROVED",
        403,
      );
    });
  });

  describe("setInventory", () => {
    function seedApprovedSeller(): void {
      repository.seedProfile({
        id: "sp-approved",
        userId: "user-authenticated",
        slug: "approved-shop",
        displayName: "Approved Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-approved",
        sellerProfileId: "sp-approved",
        name: "Approved Shop",
        slug: "approved-shop",
        description: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    async function seedVariant(): Promise<{ productId: string; variantId: string }> {
      seedApprovedSeller();
      const product = await service.createProduct(makeUser({ role: "seller" }), {
        name: "Vintage Camera",
        slug: "vintage-camera",
      });
      const variant = await service.createVariant(makeUser({ role: "seller" }), product.id, {
        name: "Body Only",
        priceAmountCents: 49900,
      });
      return { productId: product.id, variantId: variant.id };
    }

    it("upserts inventory for one of the seller's own variants", async () => {
      const { productId, variantId } = await seedVariant();

      const data = await service.setInventory(makeUser({ role: "seller" }), productId, variantId, {
        quantity: 7,
      });

      expect(data.variantId).toBe(variantId);
      expect(data.quantity).toBe(7);
      expect(products.setInventoryCalls[0]).toMatchObject({
        productId,
        variantId,
        storeId: "st-approved",
        quantity: 7,
      });
    });

    it("rejects an unknown product as PRODUCT_NOT_FOUND", async () => {
      const { variantId } = await seedVariant();

      await expectSellerError(
        () => service.setInventory(makeUser({ role: "seller" }), "product-unknown", variantId, { quantity: 1 }),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
    });

    it("rejects a variant that does not belong to the product", async () => {
      const { productId } = await seedVariant();

      await expectSellerError(
        () =>
          service.setInventory(makeUser({ role: "seller" }), productId, "variant-unknown", {
            quantity: 1,
          }),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
    });

    it("rejects a negative quantity", async () => {
      const { productId, variantId } = await seedVariant();

      await expectSellerError(
        () => service.setInventory(makeUser({ role: "seller" }), productId, variantId, { quantity: -1 }),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("rejects a fractional quantity", async () => {
      const { productId, variantId } = await seedVariant();

      await expectSellerError(
        () => service.setInventory(makeUser({ role: "seller" }), productId, variantId, { quantity: 2.5 }),
        "VALIDATION_ERROR",
        422,
      );
    });
  });

  describe("publishProduct", () => {
    function seedApprovedSeller(): void {
      repository.seedProfile({
        id: "sp-approved",
        userId: "user-authenticated",
        slug: "approved-shop",
        displayName: "Approved Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-approved",
        sellerProfileId: "sp-approved",
        name: "Approved Shop",
        slug: "approved-shop",
        description: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    async function seedPublishedProduct(): Promise<{ productId: string; variantId: string }> {
      seedApprovedSeller();
      const product = await service.createProduct(makeUser({ role: "seller" }), {
        name: "Vintage Camera",
        slug: "vintage-camera",
      });
      const variant = await service.createVariant(makeUser({ role: "seller" }), product.id, {
        name: "Body Only",
        priceAmountCents: 49900,
      });
      await service.setInventory(makeUser({ role: "seller" }), product.id, variant.id, { quantity: 3 });
      return { productId: product.id, variantId: variant.id };
    }

    it("publishes a draft when at least one variant is sellable", async () => {
      const { productId } = await seedPublishedProduct();

      const data = await service.publishProduct(makeUser({ role: "seller" }), productId);

      expect(data.id).toBe(productId);
      expect(data.status).toBe("active");
    });

    it("rejects publishing without any variant", async () => {
      seedApprovedSeller();
      const product = await service.createProduct(makeUser({ role: "seller" }), {
        name: "Vintage Camera",
        slug: "vintage-camera",
      });

      await expectSellerError(
        () => service.publishProduct(makeUser({ role: "seller" }), product.id),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_PUBLISHABLE,
        409,
      );
    });

    it("rejects publishing without inventory", async () => {
      seedApprovedSeller();
      const product = await service.createProduct(makeUser({ role: "seller" }), {
        name: "Vintage Camera",
        slug: "vintage-camera",
      });
      const variant = await service.createVariant(makeUser({ role: "seller" }), product.id, {
        name: "Body Only",
        priceAmountCents: 49900,
      });
      expect(variant.status).toBe("active");

      await expectSellerError(
        () => service.publishProduct(makeUser({ role: "seller" }), product.id),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_PUBLISHABLE,
        409,
      );
    });

    it("rejects publishing a variant owned by another store", async () => {
      seedApprovedSeller();
      const product = await service.createProduct(makeUser({ role: "seller" }), {
        name: "Vintage Camera",
        slug: "vintage-camera",
      });

      repository.seedProfile({
        id: "sp-other",
        userId: "other-seller",
        slug: "other-shop",
        displayName: "Other Seller",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.seedStore({
        id: "st-other",
        sellerProfileId: "sp-other",
        name: "Other Shop",
        slug: "other-shop",
        description: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expectSellerError(
        () => service.publishProduct(makeUser({ role: "seller", id: "other-seller" }), product.id),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
    });

    it("rejects an unknown product as PRODUCT_NOT_FOUND", async () => {
      seedApprovedSeller();

      await expectSellerError(
        () => service.publishProduct(makeUser({ role: "seller" }), "product-unknown"),
        SELLER_PRODUCT_ERROR_CODES.PRODUCT_NOT_FOUND,
        404,
      );
    });
  });
});