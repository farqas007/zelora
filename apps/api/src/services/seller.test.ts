import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@zelora/core";
import type { UserRecord } from "@zelora/db/users";
import type {
  CreateOnboardingInput,
  OnboardingConflictReason,
  SellerProfileRecord,
  SellerRepository,
  StoreRecord,
} from "@zelora/db/seller";
import type { CatalogCategoryRecord, CatalogRepository } from "@zelora/db/catalog";
import type {
  CreateProductInput,
  CreateProductResult,
  ProductRecord,
  ProductRepository,
} from "@zelora/db/products";
import { AUTH_ERROR_CODES } from "@zelora/shared";
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
 * the real repository's `(store_id, slug)` constraint.
 */
class FakeProductRepository implements ProductRepository {
  private products: Map<string, ProductRecord> = new Map();
  private nextId = 1;

  forceCreateConflict: boolean = false;

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
      id: `pr-${this.nextId}`,
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
  let service: SellerService;

  beforeEach(() => {
    repository = new FakeSellerRepository();
    products = new FakeProductRepository();
    catalog = new FakeCatalogRepository();
    service = new SellerService({
      sellerRepository: repository,
      productRepository: products,
      catalogRepository: catalog,
    });
  });

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
});