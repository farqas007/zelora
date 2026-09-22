import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { isValidId } from "../ids";
import * as schema from "../schema";
import { createLocalSellerRepository } from "../seller/local-repository";
import type { CreateOnboardingInput } from "../seller/repository";
import { createTestDatabase } from "./helpers";

/**
 * Real-SQLite integration tests for the seller repository. Each test uses an
 * isolated in-memory database with the committed migrations applied (foreign
 * keys ON), matching the Cloudflare D1 runtime behavior.
 */

let userSeq = 0;
let onboardingSeq = 0;

function insertUser(db: LocalDatabase): string {
  userSeq += 1;
  return db
    .insert(schema.users)
    .values({ email: `seller-user-${userSeq}@example.test`, name: "Seller User" })
    .returning({ id: schema.users.id })
    .get().id;
}

function onboardingInput(userId: string, overrides: Partial<CreateOnboardingInput> = {}): CreateOnboardingInput {
  onboardingSeq += 1;
  return {
    userId,
    profileSlug: `profile-${onboardingSeq}`,
    displayName: "Seller Name",
    storeName: "Seller Store",
    storeSlug: `store-${onboardingSeq}`,
    ...overrides,
  };
}

describe("seller repository onboarding", () => {
  it("creates the seller profile and initial store together", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    const result = await repo.createOnboarding(onboardingInput(userId));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a successful onboarding");
    }

    expect(isValidId(result.sellerProfile.id)).toBe(true);
    expect(result.sellerProfile.userId).toBe(userId);
    expect(result.sellerProfile.status).toBe("pending");

    expect(isValidId(result.store.id)).toBe(true);
    expect(result.store.sellerProfileId).toBe(result.sellerProfile.id);
    expect(result.store.name).toBe("Seller Store");
    expect(result.store.status).toBe("draft");
    expect(result.store.description).toBeNull();
  });

  it("stores the profile and store rows in the database", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    const result = await repo.createOnboarding(onboardingInput(userId));

    if (!result.ok) {
      throw new Error("expected a successful onboarding");
    }

    const profile = db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.id, result.sellerProfile.id))
      .get();
    expect(profile?.userId).toBe(userId);

    const store = db
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, result.store.id))
      .get();
    expect(store?.sellerProfileId).toBe(result.sellerProfile.id);
    expect(store?.name).toBe("Seller Store");
  });

  it("finds a seller profile by user id", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    expect(await repo.findByUserId(userId)).toBeNull();

    const result = await repo.createOnboarding(onboardingInput(userId));
    if (!result.ok) {
      throw new Error("expected a successful onboarding");
    }

    const found = await repo.findByUserId(userId);
    expect(found?.id).toBe(result.sellerProfile.id);
  });

  it("finds a seller profile by its slug", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    const result = await repo.createOnboarding(onboardingInput(userId, { profileSlug: "unique-slug" }));
    if (!result.ok) {
      throw new Error("expected a successful onboarding");
    }

    expect((await repo.findByProfileSlug("unique-slug"))?.id).toBe(result.sellerProfile.id);
    expect(await repo.findByProfileSlug("missing-slug")).toBeNull();
  });

  it("finds a store by its slug", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    const result = await repo.createOnboarding(onboardingInput(userId, { storeSlug: "unique-store" }));
    if (!result.ok) {
      throw new Error("expected a successful onboarding");
    }

    expect((await repo.findStoreBySlug("unique-store"))?.id).toBe(result.store.id);
    expect(await repo.findStoreBySlug("missing-store")).toBeNull();
  });

  it("reports a conflict when the user already has a seller profile", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    expect((await repo.createOnboarding(onboardingInput(userId))).ok).toBe(true);
    const second = await repo.createOnboarding(onboardingInput(userId));

    expect(second.ok).toBe(false);
    if (second.ok) {
      throw new Error("expected a conflict");
    }
    expect(second.reason).toBe("SELLER_PROFILE_EXISTS");

    const profiles = db.select().from(schema.sellerProfiles).all();
    expect(profiles).toHaveLength(1);
  });

  it("reports a conflict for an existing seller profile slug", async () => {
    const { db } = createTestDatabase();
    const ownerA = insertUser(db);
    const ownerB = insertUser(db);
    const repo = createLocalSellerRepository(db);

    expect((await repo.createOnboarding(onboardingInput(ownerA, { profileSlug: "shared-profile" }))).ok).toBe(true);
    const duplicate = await repo.createOnboarding(onboardingInput(ownerB, { profileSlug: "shared-profile" }));

    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) {
      throw new Error("expected a conflict");
    }
    expect(duplicate.reason).toBe("PROFILE_SLUG_IN_USE");
  });

  it("reports a conflict for an existing store slug", async () => {
    const { db } = createTestDatabase();
    const ownerA = insertUser(db);
    const ownerB = insertUser(db);
    const repo = createLocalSellerRepository(db);

    expect((await repo.createOnboarding(onboardingInput(ownerA, { storeSlug: "shared-store" }))).ok).toBe(true);
    const duplicate = await repo.createOnboarding(onboardingInput(ownerB, { storeSlug: "shared-store" }));

    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) {
      throw new Error("expected a conflict");
    }
    expect(duplicate.reason).toBe("STORE_SLUG_IN_USE");
  });

  it("rolls back atomically when the store insert fails, leaving no orphan profile", async () => {
    const { db } = createTestDatabase();
    const ownerA = insertUser(db);
    const ownerB = insertUser(db);
    const repo = createLocalSellerRepository(db);

    expect((await repo.createOnboarding(onboardingInput(ownerA, { storeSlug: "taken-store" }))).ok).toBe(true);

    const failed = await repo.createOnboarding(onboardingInput(ownerB, { storeSlug: "taken-store" }));

    expect(failed.ok).toBe(false);
    if (failed.ok) {
      throw new Error("expected a conflict");
    }
    expect(failed.reason).toBe("STORE_SLUG_IN_USE");

    // The failed attempt must not leave a seller profile behind for ownerB.
    expect(await repo.findByUserId(ownerB)).toBeNull();
    const profiles = db.select().from(schema.sellerProfiles).all();
    expect(profiles).toHaveLength(1);
    const stores = db.select().from(schema.stores).all();
    expect(stores).toHaveLength(1);
  });

  it("rejects onboarding for a non-existent user (FK) without any partial rows", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalSellerRepository(db);

    await expect(
      repo.createOnboarding(onboardingInput("00000000-0000-7000-8000-000000000001")),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    expect(db.select().from(schema.sellerProfiles).all()).toHaveLength(0);
    expect(db.select().from(schema.stores).all()).toHaveLength(0);
  });
});