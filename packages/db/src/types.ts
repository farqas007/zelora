/**
 * Timestamp columns shared by every row. Stored as Unix epoch milliseconds
 * (`integer ({ mode: "timestamp_ms" })`) which is compact, INT64-safe on
 * Cloudflare D1, and free of format drifts.
 */
export interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}