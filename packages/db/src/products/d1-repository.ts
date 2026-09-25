import { and, asc, desc, eq, gte, lt, or } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { decodeCatalogCursor, encodeCatalogCursor } from "../catalog/cursor";
import { inventory, products, productVariants } from "../schema/catalog";
import type {
  CreateProductConflictReason,
  CreateVariantConflictReason,
  ProductDetailRecord,
  ProductListPage,
  ProductListQuery,
  ProductRecord,
  ProductRepository,
  ProductVariantDetailRecord,
} from "./repository";

/**
 * Cloudflare D1 implementation of the product repository.
 *
 * Concrete implementation of {@link ProductRepository} against the Drizzle D1
 * client created by {@link createD1Client}. Mirrors the local better-sqlite3
 * contract: reads resolve to `null` when unknown, `createProduct` maps the
 * `(store_id, slug)` UNIQUE constraint failure and `createVariant` maps the
 * global `product_variants.sku` constraint into driver-neutral results.
 *
 * Worker-safe: only the Drizzle D1 driver and the product contract are
 * imported; the Node-only SQLite stack is never pulled into the Worker bundle.
 */
export function createD1ProductRepository(
  db: DrizzleD1Database<DatabaseSchema>,
): ProductRepository {
  return {
    async listByStore(storeId, query) {
      return loadProductPage(db, storeId, query);
    },

    async findByStoreAndId(storeId, productId) {
      return findProductDetail(db, storeId, productId);
    },

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

    async createVariant(input) {
      const product = await findOwnedProduct(db, input.productId, input.storeId);
      if (product === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      try {
        const rows = await db
          .insert(productVariants)
          .values({
            productId: input.productId,
            sku: input.sku,
            name: input.name,
            priceAmountCents: input.priceAmountCents,
            compareAtAmountCents: input.compareAtAmountCents,
            currency: input.currency,
            status: "active",
          })
          .returning();
        const variant = rows[0];
        if (variant === undefined) {
          throw new Error("variant insert returned no row");
        }
        return { ok: true, variant };
      } catch (error) {
        const reason = mapD1VariantCreateConflict(error);
        if (reason !== null) {
          return { ok: false, reason };
        }
        throw error;
      }
    },

    async setInventory(input) {
      const variant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(
          and(
            eq(productVariants.id, input.variantId),
            eq(products.id, input.productId),
            eq(products.storeId, input.storeId),
          ),
        )
        .get();
      if (variant === undefined) {
        return { ok: false, reason: "VARIANT_NOT_FOUND" };
      }
      const rows = await db
        .insert(inventory)
        .values({ variantId: input.variantId, quantity: input.quantity })
        .onConflictDoUpdate({
          target: inventory.variantId,
          set: { quantity: input.quantity, updatedAt: new Date() },
        })
        .returning();
      const inventoryRow = rows[0];
      if (inventoryRow === undefined) {
        throw new Error("inventory upsert returned no row");
      }
      return { ok: true, inventory: inventoryRow };
    },

    async publishProduct(productId, storeId) {
      const product = await findOwnedProduct(db, productId, storeId);
      if (product === null) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" };
      }
      if (product.status === "archived") {
        return { ok: false, reason: "PRODUCT_ARCHIVED" };
      }
      const sellableVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .innerJoin(inventory, eq(inventory.variantId, productVariants.id))
        .where(
          and(
            eq(productVariants.productId, productId),
            eq(productVariants.status, "active"),
            gte(productVariants.priceAmountCents, 1),
            gte(inventory.quantity, 1),
          ),
        )
        .limit(1)
        .get();
      if (sellableVariant === undefined) {
        return { ok: false, reason: "NOT_PUBLISHABLE" };
      }
      if (product.status === "active") {
        return { ok: true, product };
      }
      const updatedRows = await db
        .update(products)
        .set({ status: "active" })
        .where(eq(products.id, productId))
        .returning();
      const updated = updatedRows[0];
      if (updated === undefined) {
        throw new Error("product publish returned no row");
      }
      return { ok: true, product: updated };
    },
  };
}

async function loadProductPage(
  db: DrizzleD1Database<DatabaseSchema>,
  storeId: string,
  query: ProductListQuery,
): Promise<ProductListPage> {
  const start = query.cursor === null ? null : decodeCatalogCursor(query.cursor);
  if (query.cursor !== null && start === null) {
    return { items: [], nextCursor: null };
  }

  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.storeId, storeId),
        start === null
          ? undefined
          : or(
              lt(products.createdAt, start.createdAt),
              and(eq(products.createdAt, start.createdAt), lt(products.id, start.id)),
            ),
      ),
    )
    .orderBy(desc(products.createdAt), desc(products.id))
    .limit(query.limit + 1);
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows[pageRows.length - 1];

  return {
    items: pageRows,
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? encodeCatalogCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

async function findProductDetail(
  db: DrizzleD1Database<DatabaseSchema>,
  storeId: string,
  productId: string,
): Promise<ProductDetailRecord | null> {
  const product = await findOwnedProduct(db, productId, storeId);
  if (product === null) {
    return null;
  }

  const rows = await db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      sku: productVariants.sku,
      name: productVariants.name,
      priceAmountCents: productVariants.priceAmountCents,
      compareAtAmountCents: productVariants.compareAtAmountCents,
      currency: productVariants.currency,
      status: productVariants.status,
      createdAt: productVariants.createdAt,
      updatedAt: productVariants.updatedAt,
      inventoryVariantId: inventory.variantId,
      inventoryQuantity: inventory.quantity,
      inventoryUpdatedAt: inventory.updatedAt,
    })
    .from(productVariants)
    .leftJoin(inventory, eq(inventory.variantId, productVariants.id))
    .where(eq(productVariants.productId, productId))
    .orderBy(asc(productVariants.createdAt), asc(productVariants.id));

  const variants: ProductVariantDetailRecord[] = rows.map((row) => ({
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    name: row.name,
    priceAmountCents: row.priceAmountCents,
    compareAtAmountCents: row.compareAtAmountCents,
    currency: row.currency,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    inventory:
      row.inventoryVariantId === null ||
      row.inventoryQuantity === null ||
      row.inventoryUpdatedAt === null
        ? null
        : {
            variantId: row.inventoryVariantId,
            quantity: row.inventoryQuantity,
            updatedAt: row.inventoryUpdatedAt,
          },
  }));

  return { ...product, variants };
}

/**
 * Resolve one product the caller owns (by id and store), or `null`. Keeps
 * existence hidden from callers who do not own the product.
 */
async function findOwnedProduct(
  db: DrizzleD1Database<DatabaseSchema>,
  productId: string,
  storeId: string,
): Promise<ProductRecord | null> {
  const product = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.storeId, storeId)))
    .get();
  return product ?? null;
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
 * Same shape as {@link PRODUCT_UNIQUE_CONFLICT_PATTERN} but for the global
 * `product_variants.sku` unique index.
 */
const VARIANT_UNIQUE_CONFLICT_PATTERN =
  /UNIQUE constraint failed:\s+product_variants\.sku/i;

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
 * Translate a D1/Drizzle UNIQUE constraint failure for the global
 * `product_variants.sku` index into the driver-neutral conflict reason, or
 * `null` when the error is unrelated. Same tolerance rules as
 * {@link mapD1ProductCreateConflict}. Pure and exported for tests.
 */
export function mapD1VariantCreateConflict(error: unknown): CreateVariantConflictReason | null {
  for (const message of collectErrorMessages(error)) {
    if (VARIANT_UNIQUE_CONFLICT_PATTERN.test(message)) {
      return "SKU_IN_USE";
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