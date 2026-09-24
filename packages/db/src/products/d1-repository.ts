import { and, eq } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { products } from "../schema/catalog";
import type { CreateProductConflictReason, ProductRepository } from "./repository";

/**
 * Cloudflare D1 implementation of the product repository.
 *
 * Concrete implementation of {@link ProductRepository} against the Drizzle D1
 * client created by {@link createD1Client}. Mirrors the local better-sqlite3
 * contract: reads resolve to `null` when unknown, and `createProduct` maps the
 * `(store_id, slug)` UNIQUE constraint failure into the driver-neutral
 * {@link CreateProductConflictReason} result.
 *
 * Worker-safe: only the Drizzle D1 driver and the product contract are
 * imported; the Node-only SQLite stack is never pulled into the Worker bundle.
 */
export function createD1ProductRepository(
  db: DrizzleD1Database<DatabaseSchema>,
): ProductRepository {
  return {
    async findByStoreAndSlug(storeId, slug) {
      const row = await db
        .select()
        .from(products)
        .where(and(eq(products.storeId, storeId), eq(products.slug, slug)))
        .get();
      return row ?? null;
    },

    async createProduct(input) {
      try {
        const rows = await db
          .insert(products)
          .values({
            storeId: input.storeId,
            categoryId: input.categoryId,
            name: input.name,
            slug: input.slug,
            description: input.description,
          })
          .returning();
        const product = rows[0];
        if (product === undefined) {
          throw new Error("product insert returned no row");
        }
        return { ok: true, product };
      } catch (error) {
        const reason = mapD1ProductCreateConflict(error);
        if (reason !== null) {
          return { ok: false, reason };
        }
        throw error;
      }
    },
  };
}

/**
 * SQLite emits the conflict text as `UNIQUE constraint failed: <table>.<column>`.
 * D1 wraps it as `D1_ERROR: <sqlite text>: SQLITE_CONSTRAINT_UNIQUE`, and
 * Drizzle forwards the driver error verbatim. This matcher extracts the token
 * for the composite `(store_id, slug)` index and maps it back to the
 * driver-neutral reason.
 */
const PRODUCT_UNIQUE_CONFLICT_PATTERN =
  /UNIQUE constraint failed:\s+products\.store_id,\s*products\.slug/i;

/**
 * Translate a D1/Drizzle UNIQUE constraint failure for the product
 * `(store_id, slug)` index into the driver-neutral conflict reason, or `null`
 * when the error is unrelated. Extraction is tolerant of wrapper prefixes
 * (`D1_ERROR:`), the trailing `: SQLITE_CONSTRAINT_UNIQUE` code, nested
 * `cause` chains and cross-realm error objects. This function is pure and
 * exported for tests.
 */
export function mapD1ProductCreateConflict(error: unknown): CreateProductConflictReason | null {
  for (const message of collectErrorMessages(error)) {
    if (PRODUCT_UNIQUE_CONFLICT_PATTERN.test(message)) {
      return "PRODUCT_SLUG_IN_USE";
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