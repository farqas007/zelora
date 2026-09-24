import { and, asc, eq, gt, or } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { sellerProfiles, stores, users } from "../schema/identities";
import { decodeSellerCursor } from "./cursor";
import { toPendingListPage } from "./page";
import type { OnboardingConflictReason, SellerRepository } from "./repository";

/**
 * Local (better-sqlite3) implementation of the seller repository.
 *
 * Built on the existing local Drizzle client. Even though better-sqlite3 is
 * synchronous, the methods here still present the async port contract so
 * callers and tests are driver-agnostic and a Cloudflare D1 implementation can
 * satisfy the same interface later.
 *
 * `createOnboarding` runs both inserts inside a single better-sqlite3
 * transaction: if the store insert fails, the seller profile insert rolls
 * back, so no orphan profile remains. UNIQUE constraint failures are
 * translated into the driver-neutral {@link OnboardingConflictReason} result
 * values; anything else propagates unchanged. No raw driver error is exposed
 * as a conflict to callers.
 */
export function createLocalSellerRepository(db: LocalDatabase): SellerRepository {
  return {
    async findByUserId(userId) {
      return db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, userId)).get() ?? null;
    },

    async findByProfileSlug(slug) {
      return db.select().from(sellerProfiles).where(eq(sellerProfiles.slug, slug)).get() ?? null;
    },

    async findStoreBySlug(slug) {
      return db.select().from(stores).where(eq(stores.slug, slug)).get() ?? null;
    },

    async findStoreBySellerProfileId(sellerProfileId) {
      return db.select().from(stores).where(eq(stores.sellerProfileId, sellerProfileId)).get() ?? null;
    },

    async createOnboarding(input) {
      try {
        const result = db.transaction((tx) => {
          const sellerProfile = tx
            .insert(sellerProfiles)
            .values({
              userId: input.userId,
              slug: input.profileSlug,
              displayName: input.displayName,
            })
            .returning()
            .get();
          if (sellerProfile === undefined) {
            throw new Error("seller profile insert returned no row");
          }

          const store = tx
            .insert(stores)
            .values({
              sellerProfileId: sellerProfile.id,
              name: input.storeName,
              slug: input.storeSlug,
            })
            .returning()
            .get();
          if (store === undefined) {
            throw new Error("store insert returned no row");
          }

          return { sellerProfile, store };
        });

        return { ok: true, ...result };
      } catch (error) {
        const reason = mapUniqueConflict(error);
        if (reason !== null) {
          return { ok: false, reason };
        }
        throw error;
      }
    },

    async activateSeller(userId) {
      return db.transaction((tx) => {
        const profile = tx.select().from(sellerProfiles).where(eq(sellerProfiles.userId, userId)).get();
        if (profile === undefined) {
          return null;
        }

        const sellerProfile = tx
          .update(sellerProfiles)
          .set({ status: "active" })
          .where(eq(sellerProfiles.id, profile.id))
          .returning()
          .get();
        if (sellerProfile === undefined) {
          throw new Error("seller profile activation returned no row");
        }

        const store = tx
          .update(stores)
          .set({ status: "active" })
          .where(eq(stores.sellerProfileId, profile.id))
          .returning()
          .all()[0];
        if (store === undefined) {
          throw new Error("seller profile has no store to activate");
        }

        tx.update(users).set({ role: "seller" }).where(eq(users.id, userId)).run();

        return { sellerProfile, store };
      });
    },

    async listPendingProfiles({ limit, cursor }) {
      const start = cursor === null ? null : decodeSellerCursor(cursor);
      if (cursor !== null && start === null) {
        return { items: [], nextCursor: null };
      }

      const rows = db
        .select({
          profileId: sellerProfiles.id,
          profileUserId: sellerProfiles.userId,
          profileSlug: sellerProfiles.slug,
          profileDisplayName: sellerProfiles.displayName,
          profileStatus: sellerProfiles.status,
          profileCreatedAt: sellerProfiles.createdAt,
          profileUpdatedAt: sellerProfiles.updatedAt,
          userId: users.id,
          email: users.email,
          name: users.name,
          userStatus: users.status,
          userCreatedAt: users.createdAt,
          storeId: stores.id,
          storeSellerProfileId: stores.sellerProfileId,
          storeName: stores.name,
          storeSlug: stores.slug,
          storeDescription: stores.description,
          storeStatus: stores.status,
          storeCreatedAt: stores.createdAt,
          storeUpdatedAt: stores.updatedAt,
        })
        .from(sellerProfiles)
        .innerJoin(users, eq(users.id, sellerProfiles.userId))
        .innerJoin(stores, eq(stores.sellerProfileId, sellerProfiles.id))
        .where(
          and(
            eq(sellerProfiles.status, "pending"),
            start === null
              ? undefined
              : or(
                  gt(sellerProfiles.createdAt, start.createdAt),
                  and(
                    eq(sellerProfiles.createdAt, start.createdAt),
                    gt(sellerProfiles.id, start.id),
                  ),
                ),
          ),
        )
        .orderBy(asc(sellerProfiles.createdAt), asc(sellerProfiles.id))
        .limit(limit + 1)
        .all();

      return toPendingListPage(rows, limit);
    },

    async rejectSeller(userId) {
      return (
        db
          .update(sellerProfiles)
          .set({ status: "rejected" })
          .where(
            and(
              eq(sellerProfiles.userId, userId),
              eq(sellerProfiles.status, "pending"),
            ),
          )
          .returning()
          .get() ?? null
      );
    },
  };
}

/**
 * Translate a better-sqlite3 UNIQUE constraint failure into the driver-neutral
 * conflict reason. Column-level matching keeps the mapping unambiguous for the
 * three UNIQUE indexes that onboarding can hit.
 */
function mapUniqueConflict(error: unknown): OnboardingConflictReason | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (/UNIQUE constraint failed: seller_profiles\.user_id/.test(error.message)) {
    return "SELLER_PROFILE_EXISTS";
  }
  if (/UNIQUE constraint failed: seller_profiles\.slug/.test(error.message)) {
    return "PROFILE_SLUG_IN_USE";
  }
  if (/UNIQUE constraint failed: stores\.slug/.test(error.message)) {
    return "STORE_SLUG_IN_USE";
  }
  return null;
}