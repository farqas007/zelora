import { desc, eq } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { DatabaseSchema } from "../client";
import { auditLogs } from "../schema/audit";
import type { AuditLogRepository } from "./repository";

/**
 * Cloudflare D1 implementation of the audit-log repository.
 *
 * Concrete implementation of {@link AuditLogRepository} against the Drizzle D1
 * client created by {@link createD1Client}. Every method is async (D1 is
 * promise-based) and mirrors the local better-sqlite3 implementation, so the
 * admin service behaves identically on both runtimes.
 *
 * This module is deliberately Worker-safe: it imports only the Drizzle D1
 * driver and the audit contract. The Node-only SQLite stack never appears
 * here, so the Worker bundle stays free of `better-sqlite3`.
 */
export function createD1AuditLogRepository(db: DrizzleD1Database<DatabaseSchema>): AuditLogRepository {
  return {
    async create(input) {
      const row = await db.insert(auditLogs).values(input).returning().get();
      if (row === undefined) {
        throw new Error("audit log insert returned no row");
      }
      return row;
    },

    async listByAction(action, limit = 50) {
      const bound = Math.min(Math.max(limit, 1), 200);
      return db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, action))
        .orderBy(desc(auditLogs.createdAt))
        .limit(bound);
    },
  };
}

export type { AuditLogRecord, AuditLogRepository, CreateAuditLogInput } from "./repository";