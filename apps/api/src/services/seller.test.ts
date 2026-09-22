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

  clear(): void {
    this.profiles.clear();
    this.stores.clear();
    this.nextId = 1;
    this.lastCreateInput = null;
    this.forceConflict = null;
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
  let service: SellerService;

  beforeEach(() => {
    repository = new FakeSellerRepository();
    service = new SellerService({ sellerRepository: repository });
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
});