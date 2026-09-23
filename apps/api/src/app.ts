import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRepository } from "@zelora/db/users";
import type { SellerRepository } from "@zelora/db/seller";
import type { CatalogRepository } from "@zelora/db/catalog";
import { createLogger, type AppConfig, type PasswordHasher } from "@zelora/core";
import { createErrorHandler, notFoundHandler } from "./middleware/error";
import { requestLogger } from "./middleware/request-log";
import { createAuthRoutes } from "./routes/auth";
import { createAdminRoutes } from "./routes/admin";
import { createCatalogRoutes } from "./routes/catalog";
import { createHealthRoutes } from "./routes/health";
import { createSellerRoutes } from "./routes/seller";
import { AuthService } from "./services/auth";
import { CatalogService } from "./services/catalog";
import { SellerService } from "./services/seller";
import type { Clock } from "./services/clock";
import type { ClientIpResolver } from "./services/client-ip";
import { MemoryWindowRateLimiter, type RateLimiter } from "./services/rate-limit";

/**
 * Everything the API composition needs. The concrete repositories, password
 * hasher and clock are supplied by the runtime boundary (Node today,
 * Cloudflare D1 later); this module only wires them together and never
 * instantiates a database implementation itself.
 *
 * When a rate limiter or client-IP resolver is omitted, safe local defaults
 * are used: a {@link MemoryWindowRateLimiter} driven by the injected clock and
 * a resolver that reports no IP (requests share the `unknown` bucket).
 */
export interface AppDependencies {
  config: AppConfig;
  userRepository: UserRepository;
  sessionRepository: AuthSessionRepository;
  sellerRepository: SellerRepository;
  catalogRepository: CatalogRepository;
  passwordHasher: PasswordHasher;
  clock: Clock;
  rateLimiter?: RateLimiter;
  clientIpResolver?: ClientIpResolver;
}

export function createApp(dependencies: AppDependencies): Hono {
  const { config, userRepository, sessionRepository, sellerRepository, catalogRepository, passwordHasher, clock } = dependencies;
  const rateLimiter = dependencies.rateLimiter ?? new MemoryWindowRateLimiter(clock);
  const clientIpResolver: ClientIpResolver = dependencies.clientIpResolver ?? {
    resolve: () => undefined,
  };
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
      credentials: true,
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
    rateLimiter,
  });

  const sellerService = new SellerService({ sellerRepository });
  const catalogService = new CatalogService({ catalogRepository });

  app.route(
    "/api/catalog",
    createCatalogRoutes({ catalogService }),
  );

  app.route(
    "/api/auth",
    createAuthRoutes({
      config,
      authService,
      userRepository,
      sessionRepository,
      clock,
      rateLimiter,
      clientIpResolver,
    }),
  );
  app.route(
    "/api/seller",
    createSellerRoutes({
      config,
      sellerService,
      userRepository,
      sessionRepository,
      clock,
      rateLimiter,
      clientIpResolver,
    }),
  );
  app.route("/api/health", createHealthRoutes(config));
  app.route(
    "/api/admin",
    createAdminRoutes({
      config,
      sellerService,
      userRepository,
      sessionRepository,
      clock,
    }),
  );

  return app;
}