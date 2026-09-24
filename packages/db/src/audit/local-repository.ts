import { desc, eq } from "drizzle-orm";
import type { LocalDatabase } from "../client";
import { auditLogs } from "../schema/audit";
import type { AuditLogRepository } from "./repository";

/**
 * Local (better-sqlite3) implementation of the audit-log repository.
 *
 * Built on the existing local Drizzle client. Even though better-sqlite3 is
 * synchronous, the methods present the async port contract so callers and
 * tests are driver-agnostic and a Cloudflare D1 implementation can satisfy the
 * same interface later.
 */
export function createLocalAuditLogRepository(db: LocalDatabase): AuditLogRepository {
  return {
    async create(input) {
      const row = db.insert(auditLogs).values(input).returning().get();
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