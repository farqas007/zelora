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

describe("seller repository activation", () => {
  it("activates the profile, its store and promotes the user role atomically", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    const onboarding = await repo.createOnboarding(onboardingInput(userId));
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }

    const activated = await repo.activateSeller(userId);

    expect(activated).not.toBeNull();
    expect(activated?.sellerProfile.status).toBe("active");
    expect(activated?.store.status).toBe("active");
    expect(activated?.store.sellerProfileId).toBe(activated?.sellerProfile.id);
    expect(activated?.sellerProfile.id).toBe(onboarding.sellerProfile.id);

    expect(await repo.findByUserId(userId)).toMatchObject({ status: "active" });
    expect(await repo.findStoreBySlug(onboarding.store.slug)).toMatchObject({ status: "active" });

    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    expect(user?.role).toBe("seller");
  });

  it("is idempotent for an already-active profile", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    await repo.createOnboarding(onboardingInput(userId));
    const first = await repo.activateSeller(userId);
    const second = await repo.activateSeller(userId);

    expect(first?.sellerProfile.id).toBe(second?.sellerProfile.id);
    expect(first?.store.id).toBe(second?.store.id);
    expect(second?.sellerProfile.status).toBe("active");
    expect(second?.store.status).toBe("active");
    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    expect(user?.role).toBe("seller");
  });

  it("returns null when the user has no seller profile", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    expect(await repo.activateSeller(userId)).toBeNull();
  });

  it("does not promote a user who has no seller profile", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    await repo.activateSeller(userId);

    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    expect(user?.role).toBe("customer");
  });
});

describe("seller repository pending review queue", () => {
  it("lists pending applications oldest-first with owner and store projection", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalSellerRepository(db);

    const userA = insertUser(db);
    const userB = insertUser(db);
    const userC = insertUser(db);

    const third = await repo.createOnboarding(onboardingInput(userC, { profileSlug: "profile-c" }));
    const first = await repo.createOnboarding(onboardingInput(userA, { profileSlug: "profile-a" }));
    const second = await repo.createOnboarding(onboardingInput(userB, { profileSlug: "profile-b" }));
    if (!first.ok || !second.ok || !third.ok) {
      throw new Error("expected successful onboardings");
    }

    // `createdAt` defaults to the insert instant, which can tie across quick
    // inserts; pin explicit timestamps so the oldest-first contract is tested,
    // not the clock.
    db.update(schema.sellerProfiles)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(schema.sellerProfiles.id, first.sellerProfile.id))
      .run();
    db.update(schema.sellerProfiles)
      .set({ createdAt: new Date("2026-01-02T00:00:00.000Z") })
      .where(eq(schema.sellerProfiles.id, second.sellerProfile.id))
      .run();
    db.update(schema.sellerProfiles)
      .set({ createdAt: new Date("2026-01-03T00:00:00.000Z") })
      .where(eq(schema.sellerProfiles.id, third.sellerProfile.id))
      .run();

    const page = await repo.listPendingProfiles({ limit: 10, cursor: null });

    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.sellerProfile.userId)).toEqual([userA, userB, userC]);
    expect(page.items.map((item) => item.sellerProfile.status)).toEqual(["pending", "pending", "pending"]);

    // Owner projection carries identity but never credential material.
    for (const item of page.items) {
      expect(item.user.id).toBe(item.sellerProfile.userId);
      expect(item.user.email).toMatch(/seller-user-.*@example\.test/);
      expect(item.user.name).toBe("Seller User");
      expect(item.user.status).toBe("active");
      expect(item.store).toMatchObject({ status: "draft" });
      expect(item.store.sellerProfileId).toBe(item.sellerProfile.id);
    }
  });

  it("paginates with a keyset cursor respecting the page size", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalSellerRepository(db);

    for (let index = 0; index < 3; index += 1) {
      await repo.createOnboarding(onboardingInput(insertUser(db)));
    }

    const first = await repo.listPendingProfiles({ limit: 2, cursor: null });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await repo.listPendingProfiles({ limit: 2, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    // The keyset cursor must never overlap with the previous page.
    const seen = new Set(first.items.map((item) => item.sellerProfile.id));
    for (const item of second.items) {
      expect(seen.has(item.sellerProfile.id)).toBe(false);
    }
  });

  it("treats a malformed cursor as an empty last page", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalSellerRepository(db);

    await repo.createOnboarding(onboardingInput(insertUser(db)));

    const page = await repo.listPendingProfiles({ limit: 10, cursor: "not-a-cursor" });
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it("treats an unknown-format cursor as an empty page even with pending rows present", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalSellerRepository(db);

    await repo.createOnboarding(onboardingInput(insertUser(db)));

    const page = await repo.listPendingProfiles({
      limit: 10,
      cursor: "9999999999999:01955f00-0000-7000-8000-000000000091",
    });
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it("excludes profiles that are no longer pending", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalSellerRepository(db);

    const pendingUser = insertUser(db);
    const rejectedUser = insertUser(db);
    const activeUser = insertUser(db);
    await repo.createOnboarding(onboardingInput(pendingUser, { profileSlug: "pending-a" }));
    await repo.createOnboarding(onboardingInput(rejectedUser, { profileSlug: "rejected-b" }));
    await repo.createOnboarding(onboardingInput(activeUser, { profileSlug: "active-c" }));

    await repo.rejectSeller(rejectedUser);
    await repo.activateSeller(activeUser);

    const page = await repo.listPendingProfiles({ limit: 10, cursor: null });
    expect(page.items.map((item) => item.sellerProfile.userId)).toEqual([pendingUser]);
  });
});

describe("seller repository rejection", () => {
  it("rejects a pending profile but leaves the store draft and the role untouched", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    const onboarding = await repo.createOnboarding(onboardingInput(userId));
    if (!onboarding.ok) {
      throw new Error("expected a successful onboarding");
    }

    const rejected = await repo.rejectSeller(userId);

    expect(rejected).not.toBeNull();
    expect(rejected?.id).toBe(onboarding.sellerProfile.id);
    expect(rejected?.status).toBe("rejected");

    expect(await repo.findByUserId(userId)).toMatchObject({ status: "rejected" });
    expect(await repo.findStoreBySlug(onboarding.store.slug)).toMatchObject({ status: "draft" });
    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    expect(user?.role).toBe("customer");
  });

  it("returns null for a user with no seller profile", async () => {
    const { db } = createTestDatabase();
    const repo = createLocalSellerRepository(db);

    expect(await repo.rejectSeller(insertUser(db))).toBeNull();
  });

  it("cannot reject an already-rejected profile (idempotent no-op)", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    await repo.createOnboarding(onboardingInput(userId));

    expect((await repo.rejectSeller(userId))?.status).toBe("rejected");
    expect(await repo.rejectSeller(userId)).toBeNull();
  });

  it("cannot reject an activated profile", async () => {
    const { db } = createTestDatabase();
    const userId = insertUser(db);
    const repo = createLocalSellerRepository(db);

    await repo.createOnboarding(onboardingInput(userId));
    await repo.activateSeller(userId);

    expect(await repo.rejectSeller(userId)).toBeNull();
    expect(await repo.findByUserId(userId)).toMatchObject({ status: "active" });
  });
});