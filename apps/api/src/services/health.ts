import { SERVICE_NAME, type HealthResponse } from "@zelora/shared";
import type { AppConfig } from "@zelora/core";

export function buildHealthResponse(config: AppConfig): HealthResponse {
  return {
    status: "ok",
    service: SERVICE_NAME,
    version: config.appVersion,
    timestamp: new Date().toISOString(),
  };
}