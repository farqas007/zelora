import { eq } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { sellerProfiles, stores } from "../schema/identities";
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