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
import type { OrderRepository } from "@zelora/db/orders";
import { IDEMPOTENCY_HEADER } from "@zelora/shared";
import { createLogger, type AppConfig, type PasswordHasher } from "@zelora/core";
import { createErrorHandler, notFoundHandler } from "./middleware/error";
import { requestLogger } from "./middleware/request-log";
import { createAuthRoutes } from "./routes/auth";
import { createAdminRoutes } from "./routes/admin";
import { createCartRoutes } from "./routes/cart";
import { createCatalogRoutes } from "./routes/catalog";
import { createHealthRoutes } from "./routes/health";
import { createMediaRoutes } from "./routes/media";
import { createOrderRoutes } from "./routes/orders";
import { createSellerRoutes } from "./routes/seller";
import { createStorefrontRoutes } from "./routes/storefront";
import { AdminService } from "./services/admin";
import { AuthService } from "./services/auth";
import { CartService } from "./services/cart";
import { CatalogService } from "./services/catalog";
import { OrderService } from "./services/orders";
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
 *
 * The same instance backs both halves of the media surface: the seller-only
 * writes in `routes/seller.ts` and the unauthenticated reads in
 * `routes/media.ts`, so a deployment can never write through one driver and
 * read through another.
 */
export interface AppDependencies {
  config: AppConfig;
  userRepository: UserRepository;
  sessionRepository: AuthSessionRepository;
  sellerRepository: SellerRepository;
  catalogRepository: CatalogRepository;
  productRepository: ProductRepository;
  cartRepository: CartRepository;
  orderRepository: OrderRepository;
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

/**
 * Security headers applied to every response.
 *
 * `crossOriginResourcePolicy` is the one default Hono overrides. Its default is
 * `same-origin`, which is a *response* policy rather than a request one: the
 * browser blocks a cross-origin **no-CORS** load of the resource, and an
 * `<img src>` is exactly such a load. The public media route is served from the
 * API origin while the storefront that renders those images is a different
 * origin, so `same-origin` there does not fail loudly at boot or in CI — it
 * fails silently in production, as a catalog full of broken product photos,
 * while every seed image (same-origin, served by the web Worker) keeps working
 * and hides the fault.
 *
 * `cross-origin` is the accurate value for this app and it is *not* a relaxation
 * of the API's read access. The two policies are independent: CORP only governs
 * no-CORS loads, and every `/api` surface is a JSON envelope that the SPA reads
 * in CORS mode with credentials, where the `cors()` middleware below is — and
 * remains — the only thing that decides who may read a credentialed response.
 * So this header changes nothing for `/api` and unblocks `/media`.
 *
 * It is set here rather than on the media sub-app because Hono's
 * `secureHeaders` applies its headers *after* `await next()`: a nested instance
 * would set `cross-origin` first and then be overwritten by this one on the way
 * out. One call site is also the only place where "which policy applies where"
 * can be read at a glance; `routes/media.test.ts` pins the resulting contract so
 * neither half can drift silently again.
 */
const SECURITY_HEADERS = secureHeaders({ crossOriginResourcePolicy: "cross-origin" });

export function createApp(dependencies: AppDependencies): Hono {
  const { config, userRepository, sessionRepository, sellerRepository, catalogRepository, productRepository, cartRepository, orderRepository, auditLogRepository, passwordHasher, clock } = dependencies;
  const rateLimiter = dependencies.rateLimiter ?? new MemoryWindowRateLimiter(clock);
  const clientIpResolver: ClientIpResolver = dependencies.clientIpResolver ?? {
    resolve: () => undefined,
  };
  const mediaStorage = resolveAppMediaStorage(dependencies.mediaStorage);
  const app = new Hono();
  const logger = createLogger("api");

  app.use("*", SECURITY_HEADERS);
  app.use(
    "/api/*",
    cors({
      origin: config.corsOrigin,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // `Idempotency-Key` is a *request* header the SPA must be allowed to send:
      // a browser strips any header not listed here, and checkout is refused
      // without one, so leaving it out would make every checkout fail in the
      // browser while passing in tests.
      allowHeaders: ["Content-Type", "Accept", "X-Request-Id", "X-Zelora-CSRF", IDEMPOTENCY_HEADER],
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
    userRepository,
    mediaStorage,
  });
  const catalogService = new CatalogService({ catalogRepository });
  const cartService = new CartService({ cartRepository, catalogRepository });
  const orderService = new OrderService({
    cartRepository,
    catalogRepository,
    orderRepository,
  });
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
    "/api/orders",
    createOrderRoutes({
      config,
      orderService,
      sessionRepository,
      userRepository,
      clock,
      rateLimiter,
      clientIpResolver,
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

  // Public media reads, deliberately outside `/api`: the stored URL is
  // `MEDIA_PUBLIC_BASE_URL` + the storage key, and a deployment points that base
  // at a host/path that already ends in `/media`. Keeping the mount here (rather
  // than inside `createSellerRoutes`) is what makes the route available without a
  // session, which is what a customer's catalog and storefront pages need.
  //
  // Being outside `/api` also means outside the `cors()` middleware above, which
  // is correct and sufficient: a cross-origin `<img>` load is a no-CORS request,
  // so `Access-Control-Allow-Origin` would be ignored by the browser anyway. What
  // actually unblocks it is `crossOriginResourcePolicy` on the shared
  // {@link SECURITY_HEADERS} instance, and the route's own contract — no
  // credentials, content-addressed keys, structural key validation — is asserted
  // in `routes/media.test.ts`.
  app.route("/media", createMediaRoutes({ mediaStorage }));

  return app;
}