import { encodeSellerCursor } from "./cursor";
import type { PendingSellerListPage, PendingSellerRecord } from "./repository";

/**
 * Driver-neutral row projection for `listPendingProfiles`.
 *
 * Both driver implementations fetch `limit + 1` raw joined rows (the `+1` row
 * signals that a next page exists) and delegate to this pure builder, so the
 * item mapping and cursor rules can never diverge between local SQLite and
 * Cloudflare D1.
 */
export function toPendingListPage(
  rows: Array<{
    profileId: string;
    profileUserId: string;
    profileSlug: string;
    profileDisplayName: string;
    profileStatus: PendingSellerRecord["sellerProfile"]["status"];
    profileCreatedAt: Date;
    profileUpdatedAt: Date;
    userId: string;
    email: string;
    name: string;
    userStatus: PendingSellerRecord["user"]["status"];
    userCreatedAt: Date;
    storeId: string;
    storeSellerProfileId: string;
    storeName: string;
    storeSlug: string;
    storeDescription: string | null;
    storeStatus: PendingSellerRecord["store"]["status"];
    storeCreatedAt: Date;
    storeUpdatedAt: Date;
  }>,
  limit: number,
): PendingSellerListPage {
  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  if (pageRows.length === 0) {
    return { items: [], nextCursor: null };
  }

  const items: PendingSellerRecord[] = pageRows.map((row) => ({
    sellerProfile: {
      id: row.profileId,
      userId: row.profileUserId,
      slug: row.profileSlug,
      displayName: row.profileDisplayName,
      status: row.profileStatus,
      createdAt: row.profileCreatedAt,
      updatedAt: row.profileUpdatedAt,
    },
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      status: row.userStatus,
      createdAt: row.userCreatedAt,
    },
    store: {
      id: row.storeId,
      sellerProfileId: row.storeSellerProfileId,
      name: row.storeName,
      slug: row.storeSlug,
      description: row.storeDescription,
      status: row.storeStatus,
      createdAt: row.storeCreatedAt,
      updatedAt: row.storeUpdatedAt,
    },
  }));

  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last !== undefined
        ? encodeSellerCursor({ createdAt: last.profileCreatedAt, id: last.profileId })
        : null,
  };
}