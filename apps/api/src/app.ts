import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRepository } from "@zelora/db/users";
import { createLogger, type AppConfig, type PasswordHasher } from "@zelora/core";
import { createErrorHandler, notFoundHandler } from "./middleware/error";
import { requestLogger } from "./middleware/request-log";
import { createAuthRoutes } from "./routes/auth";
import { createHealthRoutes } from "./routes/health";
import { AuthService } from "./services/auth";
import type { Clock } from "./services/clock";

/**
 * Everything the API composition needs. The concrete repositories, password
 * hasher and clock are supplied by the runtime boundary (Node today,
 * Cloudflare D1 later); this module only wires them together and never
 * instantiates a database implementation itself.
 */
export interface AppDependencies {
  config: AppConfig;
  userRepository: UserRepository;
  sessionRepository: AuthSessionRepository;
  passwordHasher: PasswordHasher;
  clock: Clock;
}

export function createApp(dependencies: AppDependencies): Hono {
  const { config, userRepository, sessionRepository, passwordHasher, clock } = dependencies;
  const app = new Hono();
  const logger = createLogger("api");

  app.use("*", secureHeaders());
  app.use(
    "/api/*",
    cors({
      origin: config.corsOrigin,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Accept", "X-Request-Id", "X-Zelora-CSRF"],
      exposeHeaders: ["X-Request-Id"],
    }),
  );
  app.use("*", requestLogger(config, logger));

  app.onError(createErrorHandler(logger));
  app.notFound(notFoundHandler);

  const authService = new AuthService({
    config,
    userRepository,
    sessionRepository,
    passwordHasher,
    clock,
  });

  app.route(
    "/api/auth",
    createAuthRoutes({
      config,
      authService,
      userRepository,
      sessionRepository,
      clock,
    }),
  );
  app.route("/api/health", createHealthRoutes(config));

  return app;
}