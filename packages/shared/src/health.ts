export const SERVICE_NAME = "zelora-api";

/** Shape returned by the platform health endpoint. */
export interface HealthResponse {
  status: "ok";
  service: typeof SERVICE_NAME;
  version: string;
  timestamp: string;
}