/**
 * Append-only audit-log repository port.
 *
 * Structural contract shared by the local better-sqlite3 implementation and
 * the Cloudflare D1 implementation. Every method is async so the same
 * interface drives both drivers. This module is deliberately dependency-free
 * (it never imports a database client) so edge/API runtimes can import the
 * contract without pulling in the Node-only SQLite stack.
 *
 * Audit rows are append-only: there is deliberately no `update` or `delete`.
 * Administrators' write paths (bootstrap, seller activation, seller rejection)
 * record an immutable event here, and a future read-side can surface them.
 */

/** A persisted audit row, mirroring the `audit_logs` table. */
export interface AuditLogRecord {
  id: string;
  /** The administrator who performed the action, or `null` for system events. */
  actorUserId: string | null;
  /** Machine-readable action name, e.g. `seller.activate`, `seller.reject`. */
  action: string;
  /** The user the action affected, or `null` when there is no target. */
  targetUserId: string | null;
  /** JSON string with action-specific context, or `null`. */
  details: string | null;
  createdAt: Date;
}

/** Everything required to append an audit row. Never mutable after creation. */
export interface CreateAuditLogInput {
  actorUserId: string | null;
  action: string;
  /** Optional user the action affected. */
  targetUserId?: string | null;
  /** Optional JSON string of action-specific context. */
  details?: string | null;
}

export interface AuditLogRepository {
  /** Append a new audit row and return the created row. */
  create(input: CreateAuditLogInput): Promise<AuditLogRecord>;
  /** Return the most recent audit rows for an action, newest first. */
  listByAction(action: string, limit?: number): Promise<AuditLogRecord[]>;
}