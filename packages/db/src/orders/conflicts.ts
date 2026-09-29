import type { CreateOrderConflictReason } from "./repository";

/**
 * The inventory CHECK constraint (SQLite renders named constraints as
 * `CHECK constraint failed: inventory_quantity_non_negative`, and the table
 * name `inventory` covers any anonymous-equivalent driver rendering).
 *
 * FOREIGN KEY here is only reachable one way: `order_items.variant_id`
 * referencing a variant that vanished in the window between the sellability
 * read and the create. `order_items.order_id`/`store_id` and
 * `orders.customer_user_id` can never be the violator (the order row was just
 * inserted and the store/customer were resolved moments earlier).
 */
const CONFLICT_PATTERNS = {
  INSUFFICIENT_STOCK: /CHECK constraint failed:\s*(?:inventory|inventory_quantity_non_negative)/i,
  VARIANT_NOT_FOUND: /FOREIGN KEY constraint failed/i,
} as const satisfies Record<CreateOrderConflictReason, RegExp>;

/**
 * Translate an SQLite CHECK/FK failure into the driver-neutral order conflict
 * reason, or `null` when the error is unrelated. Identical to how the seller
 * and products repositories translate UNIQUE conflicts: tolerant of D1's
 * wrapper prefixes, trailing `SQLITE_CONSTRAINT_*` codes and nested `cause`
 * chains.
 *
 * Pure and side-effect free so both the local and the D1 repositories share
 * it without importing each other's driver stack. Exported for tests.
 */
export function mapCreateOrderConflict(error: unknown): CreateOrderConflictReason | null {
  for (const message of collectErrorMessages(error)) {
    for (const [reason, pattern] of Object.entries(CONFLICT_PATTERNS)) {
      if (pattern.test(message)) {
        return reason as CreateOrderConflictReason;
      }
    }
  }
  return null;
}

/**
 * Collect non-empty error messages across up to three levels of `cause`
 * nesting, tolerating plain objects (D1 errors can cross realm boundaries
 * where `instanceof Error` is unreliable) and bare strings.
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