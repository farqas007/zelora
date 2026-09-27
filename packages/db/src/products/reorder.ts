import { sql, type SQL } from "drizzle-orm";
import { productImages } from "../schema/catalog";

/**
 * The two shared halves of a product-image reorder, used by **both** repository
 * drivers.
 *
 * A reorder is the one image operation whose correctness is a *set* property
 * rather than a single-row property: the request is only applicable when the
 * submitted ids are a permutation of the product's actual image ids. Writing
 * that check twice would be writing the rule the drivers must never disagree
 * about twice, so the check and the write expression live here and each driver
 * supplies only its own read and execution.
 *
 * Edge-compatible: this module imports only `drizzle-orm` and the catalog
 * schema, both of which are already in the Cloudflare Worker bundle, and it
 * never touches a database client.
 */

/**
 * Whether `submitted` is a complete, duplicate-free permutation of `current`.
 *
 * A reorder request is all-or-nothing by design, so this is the gate that makes
 * it so: anything that is not an exact permutation — a duplicate, a missing id,
 * an id from another product, an id that does not exist — is rejected before a
 * single row is written, and the caller can re-send the current list instead.
 *
 * Three properties are checked rather than one, because a length comparison
 * alone is not sufficient:
 *
 * 1. **Same length.** Catches a missing image (`[a, b]` for `[a, b, c]`).
 * 2. **Every submitted id is a current id.** Catches a foreign or non-existent
 *    id, and — because a duplicate displaces a real id — also catches most
 *    duplicate lists.
 * 3. **No submitted id repeats.** Catches the case length alone misses: `[a, b,
 *    a]` for a current set of `[a, b, c]` has the right length, but `c` is
 *    missing and `a` is duplicated.
 *
 * Two empty lists are an exact permutation of each other: reordering a product
 * that has no images is a successful no-op, not an error.
 */
export function isExactImageOrderPermutation(
  submitted: readonly string[],
  current: readonly string[],
): boolean {
  if (submitted.length !== current.length) {
    return false;
  }
  // Defensive: image ids are the primary key, so a real result set can never
  // repeat one. Guarding anyway means a duplicate `current` cannot be satisfied
  // by a submitted list that also duplicates it, which would silently renumber
  // fewer rows than the caller asked for.
  const currentIds = new Set(current);
  if (currentIds.size !== current.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const imageId of submitted) {
    if (!currentIds.has(imageId) || seen.has(imageId)) {
      return false;
    }
    seen.add(imageId);
  }
  return true;
}

/**
 * The `sortOrder` expression that renumbers a product's images to
 * `imageIds` order: a single `CASE` mapping each image id to its new position.
 *
 * ### Why one expression rather than a loop of `UPDATE`s
 *
 * All-or-nothing is the whole point of the exact-set rule, and a loop of
 * per-row updates cannot deliver it: on D1 — which has no interactive
 * transaction — the first few rows would be renumbered before a later statement
 * failed, leaving a product with a half-applied order. A single `UPDATE` is one
 * statement, so SQLite either applies every assignment or none of them.
 *
 * The expression is scoped by the caller's `WHERE product_id = ?`, so it can
 * only ever touch the product's own rows. Every id and every position is bound,
 * never interpolated: `imageIds` is server-validated data by the time it
 * arrives here, but binding costs nothing and removes the question.
 *
 * ### Why there is deliberately no `ELSE`
 *
 * A `CASE` with no `ELSE` yields `NULL` for any row the submitted list does not
 * name, and `product_images.sort_order` is `NOT NULL`. So if a row appeared
 * between the driver's read and this write, the statement would fail on the
 * constraint and **no** row would be renumbered.
 *
 * That is the intended outcome, not an oversight. The exact-set check has
 * already run, so the only way to reach an unnamed row is a concurrent insert —
 * a request that is genuinely no longer applicable. Adding `ELSE sort_order`
 * would instead quietly renumber the rows it *does* know about and leave the
 * newcomer out of the order, turning a loud refusal into a silent partial
 * reorder. A failure the seller can retry is better than a gallery that looks
 * correct and is not.
 *
 * `imageIds` must be non-empty — the caller guards the empty case, because an
 * empty `CASE` is not valid SQL.
 */
export function buildImageSortOrderExpression(imageIds: readonly string[]): SQL {
  return sql`case ${productImages.id} ${sql.join(
    imageIds.map((imageId, position) => sql`when ${imageId} then ${position}`),
    sql` `,
  )} end`;
}
