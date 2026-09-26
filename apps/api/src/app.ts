import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { UserRepository } from "@zelora/db/users";
import type { SellerRepository } from "@zelora/db/seller";
import type { CatalogRepository } from "@zelora/db/catalog";
import type { ProductRepository } from "@zelora/db/products";
import type { CartRepository } from "@zelora/db/cart";
import { createLogger, type AppConfig, type PasswordHasher } from "@zelora/core";
import { createErrorHandler, notFoundHandler } from "./middleware/error";
import { requestLogger } from "./middleware/request-log";
import { createAuthRoutes } from "./routes/auth";
import { createAdminRoutes } from "./routes/admin";
import { createCartRoutes } from "./routes/cart";
import { createCatalogRoutes } from "./routes/catalog";
import { createHealthRoutes } from "./routes/health";
import { createSellerRoutes } from "./routes/seller";
import { createStorefrontRoutes } from "./routes/storefront";
import { AdminService } from "./services/admin";
import { AuthService } from "./services/auth";
import { CartService } from "./services/cart";
import { CatalogService } from "./services/catalog";
import { SellerService } from "./services/seller";
import type { Clock } from "./services/clock";
import type { ClientIpResolver } from "./services/client-ip";
import { MemoryWindowRateLimiter, type RateLimiter } from "./services/rate-limit";
import { createUnavailableMediaStorage, type MediaStorage } from "./services/media/storage";

/**
 * Everything the API composition needs. The concrete repositories, password
 * hasher and clock are supplied by the runtime boundary (Node today,
 * Cloudflare D1 later); this module only wires them together and never
 * instantiates a database implementation itself.
 *
 * When a rate limiter or client-IP resolver is omitted, safe local defaults
 * are used: a {@link MemoryWindowRateLimiter} driven by the injected clock and
 * a resolver that reports no IP (requests share the `unknown` bucket).
 *
 * `mediaStorage` is optional and defaults to a fail-closed implementation that
 * throws on every operation. That is deliberate rather than permissive: media
 * storage is opt-in (it is unset unless `MEDIA_PUBLIC_BASE_URL` is configured),
 * and a default that quietly succeeded would mean an unconfigured deployment
 * accepts uploads, drops the bytes, and stores a URL that 404s — a silent data
 * loss that only shows up as broken images in production. Failing loudly at
 * the boundary keeps the misconfiguration visible.
 */
export interface AppDependencies {
  config: AppConfig;
  userRepository: UserRepository;
  sessionRepository: AuthSessionRepository;
  sellerRepository: SellerRepository;
  catalogRepository: CatalogRepository;
  productRepository: ProductRepository;
  cartRepository: CartRepository;
  auditLogRepository: AuditLogRepository;
  passwordHasher: PasswordHasher;
  clock: Clock;
  rateLimiter?: RateLimiter;
  clientIpResolver?: ClientIpResolver;
  mediaStorage?: MediaStorage;
}

/**
 * Resolve the media storage the app is composed with: the supplied
 * implementation, or a fail-closed default that throws on every operation.
 *
 * Extracted from {@link createApp} purely so the default is directly
 * observable — the app holds its services privately, so without this the
 * "unconfigured deployments are fail-closed" guarantee could only be asserted
 * against the factory, never against the wiring that actually installs it.
 * Behavior is identical to an inline `??`.
 */
export function resolveAppMediaStorage(mediaStorage: MediaStorage | undefined): MediaStorage {
  return mediaStorage ?? createUnavailableMediaStorage("MEDIA_PUBLIC_BASE_URL is not set");
}

export function createApp(dependencies: AppDependencies): Hono {
  const { config, userRepository, sessionRepository, sellerRepository, catalogRepository, productRepository, cartRepository, auditLogRepository, passwordHasher, clock } = dependencies;
  const rateLimiter = dependencies.rateLimiter ?? new MemoryWindowRateLimiter(clock);
  const clientIpResolver: ClientIpResolver = dependencies.clientIpResolver ?? {
    resolve: () => undefined,
  };
  const mediaStorage = resolveAppMediaStorage(dependencies.mediaStorage);
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

  const sellerService = new SellerService({
    sellerRepository,
    productRepository,
    catalogRepository,
    mediaStorage,
  });
  const catalogService = new CatalogService({ catalogRepository });
  const cartService = new CartService({ cartRepository, catalogRepository });
  const adminService = new AdminService({
    config,
    userRepository,
    sellerRepository,
    sellerService,
    auditLogRepository,
    passwordHasher,
  });

  app.route(
    "/api/catalog",
    createCatalogRoutes({ catalogService }),
  );

  app.route(
    "/api",
    createStorefrontRoutes({ catalogService }),
  );

  app.route(
    "/api",
    createCartRoutes({
      config,
      cartService,
      sessionRepository,
      userRepository,
      clock,
    }),
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
      adminService,
      userRepository,
      sessionRepository,
      clock,
    }),
  );

  return app;
}