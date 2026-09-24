import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAtColumn, idColumn } from "./_common";
import { users } from "./identities";

/**
 * Append-only audit log of administrator actions.
 *
 * Rows are written once, never updated and never hard-deleted (a later
 * lifecycle phase may archive them). `actor_user_id` is the administrator who
 * performed the action; `target_user_id` is the user the action affected (for
 * example the pending seller whose profile was activated or rejected). Both
 * use `set null` on delete so removing an account never orphans its history.
 * `details` is a JSON document of action-specific context.
 */
export const auditLogs = sqliteTable("audit_logs", {
  id: idColumn(),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  /** Machine-readable action name, e.g. `seller.activate`, `seller.reject`. */
  action: text("action").notNull(),
  targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
  /** JSON string with action-specific context (entity ids, emails, ...). */
  details: text("details"),
  createdAt: createdAtColumn(),
}, (table) => [
  index("audit_logs_actor_user_id_idx").on(table.actorUserId),
  index("audit_logs_target_user_id_idx").on(table.targetUserId),
  index("audit_logs_action_idx").on(table.action),
]);