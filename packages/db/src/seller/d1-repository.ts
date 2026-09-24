import { and, asc, eq, gt, or } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { createId } from "../ids";
import { sellerProfiles, stores, users } from "../schema/identities";
import { decodeSellerCursor } from "./cursor";
import { toPendingListPage } from "./page";
import type {
  OnboardingConflictReason,
  SellerRepository,
} from "./repository";

/**
 * Cloudflare D1 implementation of the seller repository.
 *
 * Concrete implementation of {@link SellerRepository} against the Drizzle D1
 * client created by {@link createD1Client}. Mirrors the local better-sqlite3
 * contract: reads resolve to `null` when unknown, and `createOnboarding`
 * creates the seller profile plus its first store atomically via D1's native
 * `batch()`, translating UNIQUE constraint hits into the driver-neutral
 * {@link OnboardingConflictReason} result.
 *
 * Worker-safe: only the Drizzle D1 driver and the seller contract are
 * imported; the Node-only SQLite stack is never pulled into the Worker bundle.
 */
export function createD1SellerRepository(
  db: DrizzleD1Database<DatabaseSchema>,
): SellerRepository {
  return {
    async findByUserId(userId) {
      const row = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, userId)).get();
      return row ?? null;
    },

    async findByProfileSlug(slug) {
      const row = await db.select().from(sellerProfiles).where(eq(sellerProfiles.slug, slug)).get();
      return row ?? null;
    },

    async findStoreBySlug(slug) {
      const row = await db.select().from(stores).where(eq(stores.slug, slug)).get();
      return row ?? null;
    },

    async findStoreBySellerProfileId(sellerProfileId) {
      const row = await db.select().from(stores).where(eq(stores.sellerProfileId, sellerProfileId)).get();
      return row ?? null;
    },

    async createOnboarding(input) {
      try {
        // D1 rejects raw `BEGIN` statements, so Drizzle's driver-level
        // `db.transaction()` fails at runtime. D1's native atomic primitive is
        // `batch()`: every statement in the batch commits or rolls back as
        // one unit. Ids are generated client-side (UUIDv7) so the store row
        // can reference the profile id before either insert runs.
        const sellerProfileId = createId();
        const storeId = createId();

        const [sellerProfileRows, storeRows] = await db.batch([
          db
            .insert(sellerProfiles)
            .values({
              id: sellerProfileId,
              userId: input.userId,
              slug: input.profileSlug,
              displayName: input.displayName,
            })
            .returning(),
          db
            .insert(stores)
            .values({
              id: storeId,
              sellerProfileId,
              name: input.storeName,
              slug: input.storeSlug,
            })
            .returning(),
        ]);

        const sellerProfile = sellerProfileRows[0];
        const store = storeRows[0];
        if (sellerProfile === undefined || store === undefined) {
          throw new Error("seller onboarding insert returned no row");
        }

        return { ok: true, sellerProfile, store };
      } catch (error) {
        const reason = mapD1SellerOnboardingConflict(error);
        if (reason !== null) {
          return { ok: false, reason };
        }
        throw error;
      }
    },

    async activateSeller(userId) {
      const profile = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, userId)).get();
      if (profile === undefined) {
        return null;
      }

      // D1 rejects raw `BEGIN`, so the whole promotion is one `batch()`:
      // profile, every store and the user's role flip together or not at all.
      const now = new Date();
      const [profileRows, storeRows] = await db.batch([
        db
          .update(sellerProfiles)
          .set({ status: "active", updatedAt: now })
          .where(eq(sellerProfiles.id, profile.id))
          .returning(),
        db
          .update(stores)
          .set({ status: "active", updatedAt: now })
          .where(eq(stores.sellerProfileId, profile.id))
          .returning(),
        db
          .update(users)
          .set({ role: "seller", updatedAt: now })
          .where(eq(users.id, userId))
          .returning(),
      ]);

      const sellerProfile = profileRows[0];
      const store = storeRows[0];
      if (sellerProfile === undefined || store === undefined) {
        throw new Error("seller activation returned no row");
      }

      return { sellerProfile, store };
    },

    async listPendingProfiles({ limit, cursor }) {
      const start = cursor === null ? null : decodeSellerCursor(cursor);
      if (cursor !== null && start === null) {
        return { items: [], nextCursor: null };
      }

      const rows = await db
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
        .limit(limit + 1);

      return toPendingListPage(rows, limit);
    },

    async rejectSeller(userId) {
      const rows = await db
        .update(sellerProfiles)
        .set({ status: "rejected" })
        .where(
          and(
            eq(sellerProfiles.userId, userId),
            eq(sellerProfiles.status, "pending"),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
  };
}

/**
 * Table.column selectors (as rendered by SQLite in error messages) for each
 * UNIQUE index onboarding can hit. The unique constraints remain the
 * race-condition backstop; these names drive the driver-neutral mapping.
 */
const CONFLICT_TABLE_COLUMNS: Readonly<Record<string, OnboardingConflictReason>> = {
  "seller_profiles.user_id": "SELLER_PROFILE_EXISTS",
  "seller_profiles.slug": "PROFILE_SLUG_IN_USE",
  "stores.slug": "STORE_SLUG_IN_USE",
};

/**
 * SQLite emits the conflict text as `UNIQUE constraint failed: <table>.<column>`.
 * D1 wraps it as `D1_ERROR: <sqlite text>: SQLITE_CONSTRAINT_UNIQUE`, and
 * Drizzle forwards the driver error verbatim. This matcher extracts the
 * table.column token from any of those shapes and maps it back to the
 * driver-neutral reason.
 */
const UNIQUE_CONFLICT_PATTERN = /UNIQUE constraint failed:\s+([a-z0-9_]+)\.([a-z0-9_]+)/i;

/**
 * Translate a D1/Drizzle UNIQUE constraint failure into the driver-neutral
 * onboarding conflict reason, or `null` when the error is unrelated.
 *
 * The installed Drizzle version exposes no structured SQLite error code over
 * the D1 driver, so the conflict is identified from the SQLite-generated
 * `UNIQUE constraint failed: <table>.<column>` message. Extraction is tolerant
 * of wrapper prefixes (`D1_ERROR:`), the trailing `: SQLITE_CONSTRAINT_UNIQUE`
 * code, nested `cause` chains and cross-realm error objects. Unrelated
 * failures (foreign keys, missing tables, network errors) return `null` and
 * propagate unchanged. This function is pure and exported for tests.
 */
export function mapD1SellerOnboardingConflict(error: unknown): OnboardingConflictReason | null {
  for (const message of collectErrorMessages(error)) {
    const match = UNIQUE_CONFLICT_PATTERN.exec(message);
    if (match === null) {
      continue;
    }
    const table = match[1]?.toLowerCase();
    const column = match[2]?.toLowerCase();
    const conflict = CONFLICT_TABLE_COLUMNS[`${table}.${column}`];
    if (conflict !== undefined) {
      return conflict;
    }
  }
  return null;
}

/**
 * Collect non-empty error messages across up to three levels of `cause`
 * nesting, tolerating plain objects (D1 errors can cross realm boundaries
 * where `instanceof Error` is unreliable) and bare strings. Wrapper layers
 * established by Drizzle/Driver adapters often carry their own message with
 * the driver error attached as `cause`, so the conflict matcher above
 * inspects every collected message rather than only the outermost one.
 */
function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== null && current !== undefined; depth++) {
    if (typeof current === "string" && current !== "") {
      messages.push(current);
    } else if (typeof current === "object") {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string" && message !== "") {
        messages.push(message);
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return messages;
}