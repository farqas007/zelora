import { Hono } from "hono";
import type { AppConfig } from "@zelora/core";
import type { HealthResponse } from "@zelora/shared";
import { buildHealthResponse } from "../services/health";

export function createHealthRoutes(config: AppConfig): Hono {
  const app = new Hono();

  app.get("/", (c) =>
    c.json<{ ok: true; data: HealthResponse }>({
      ok: true,
      data: buildHealthResponse(config),
    }),
  );

  return app;
}