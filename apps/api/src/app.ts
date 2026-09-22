import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { createErrorHandler, notFoundHandler } from "./middleware/error";
import { requestLogger } from "./middleware/request-log";
import { createHealthRoutes } from "./routes/health";
import { createLogger, type AppConfig } from "@zelora/core";

export function createApp(config: AppConfig): Hono {
  const app = new Hono();
  const logger = createLogger("api");

  app.use("*", secureHeaders());
  app.use(
    "/api/*",
    cors({
      origin: config.corsOrigin,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Accept", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id"],
    }),
  );
  app.use("*", requestLogger(config, logger));

  app.onError(createErrorHandler(logger));
  app.notFound(notFoundHandler);

  app.route("/api/health", createHealthRoutes(config));

  return app;
}