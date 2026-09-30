/*
Checkout idempotency on `orders`, applied non-destructively.

`orders` is a parent of `order_items` and `order_addresses` (both `ON DELETE
RESTRICT`), so it can never be rebuilt the way a Drizzle-generated "recreate the
table" migration does. That style writes a `__new_orders` table, copies rows,
then `DROP TABLE orders` with foreign keys off. On a populated D1 database where
`PRAGMA foreign_keys` is already ON, that DROP is a `FOREIGN KEY constraint
failed`, and `PRAGMA foreign_keys=OFF` cannot rescue it because D1 runs every
migration inside a transaction where the pragma is a no-op.

This migration therefore only ever adds columns, backfills and adds indexes. The
table is never dropped, renamed or rewritten, so every existing order row and
every existing foreign key survives untouched.

The idempotency pair is `idempotency_key` (the client's key) and
`idempotency_fingerprint` (the server's digest of the customer plus the
request's addresses). Both columns are added nullable, because SQLite refuses
`ALTER TABLE ADD COLUMN ... NOT NULL` without a constant default on a table that
already holds rows, and the only constant available would be a permanent
placeholder default that silently accepts an order whose key was never supplied.

Two mechanisms restore the intended constraints without a rebuild:

  * The length CHECKs are added inline with the columns under the same names the
    Drizzle schema declares, so `orders_idempotency_key_length` and
    `orders_idempotency_fingerprint_length` reject bad values on both SQLite and
    D1 with the message callers already match on.
  * NOT NULL is enforced by BEFORE INSERT/UPDATE triggers that abort with the
    same `NOT NULL constraint failed: orders.<column>` text a real NOT NULL
    column raises. Without them a NULL key would slip past the UNIQUE index,
    since SQLite treats NULLs as distinct, which is exactly the hole the
    idempotency guarantee must not have.

The schema's `notNull()` declarations stay as they are: they describe the
guarantee and remain true of every row, enforced by these triggers rather than by
a column flag SQLite cannot add without rebuilding the table.

Existing rows are backfilled with their own `id` as the key and an all-zero
fingerprint. Zeroes are not a reachable SHA-256 output, so such a row can only
ever answer "conflict" and can never replay an order that did not exist when the
key was sent.

Note on formatting: this rationale is a block comment rather than a run of line
comments on purpose. The D1 test harnesses collapse each statement onto a single
line, which would turn leading line comments into one long comment that swallows
the first statement. Keep this note as a block comment, and keep the file
LF-terminated: `wrangler d1 migrations apply` splits statements itself and has
historically choked on CRLF inside compound statements such as the triggers below.
*/
ALTER TABLE `orders` ADD `idempotency_key` text CONSTRAINT "orders_idempotency_key_length" CHECK(length("orders"."idempotency_key") between 8 and 64);--> statement-breakpoint
ALTER TABLE `orders` ADD `idempotency_fingerprint` text CONSTRAINT "orders_idempotency_fingerprint_length" CHECK(length("orders"."idempotency_fingerprint") = 64);--> statement-breakpoint
UPDATE `orders` SET `idempotency_key` = `id`, `idempotency_fingerprint` = '0000000000000000000000000000000000000000000000000000000000000000';--> statement-breakpoint
CREATE TRIGGER `orders_idempotency_key_not_null_insert` BEFORE INSERT ON `orders` WHEN NEW.`idempotency_key` IS NULL BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: orders.idempotency_key'); END;--> statement-breakpoint
CREATE TRIGGER `orders_idempotency_key_not_null_update` BEFORE UPDATE ON `orders` WHEN NEW.`idempotency_key` IS NULL BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: orders.idempotency_key'); END;--> statement-breakpoint
CREATE TRIGGER `orders_idempotency_fingerprint_not_null_insert` BEFORE INSERT ON `orders` WHEN NEW.`idempotency_fingerprint` IS NULL BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: orders.idempotency_fingerprint'); END;--> statement-breakpoint
CREATE TRIGGER `orders_idempotency_fingerprint_not_null_update` BEFORE UPDATE ON `orders` WHEN NEW.`idempotency_fingerprint` IS NULL BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: orders.idempotency_fingerprint'); END;--> statement-breakpoint
CREATE UNIQUE INDEX `orders_customer_idempotency_key_unique` ON `orders` (`customer_user_id`,`idempotency_key`);