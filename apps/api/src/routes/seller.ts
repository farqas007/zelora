import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { AppError, type AppConfig } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRepository } from "@zelora/db/users";
import type {
  CreateProductEnvelope,
  CreateProductVariantEnvelope,
  GetSellerProductEnvelope,
  ListSellerProductsEnvelope,
  PublishProductEnvelope,
  SellerOnboardingEnvelope,
  SetInventoryEnvelope,
} from "@zelora/shared";
import type { AppEnv } from "../context";
import { createAuthMiddleware } from "../middleware/auth";
import { createCsrfMiddleware } from "../middleware/csrf";
import { createIpRateLimitMiddleware } from "../middleware/rate-limit";
import type { SellerService } from "../services/seller";
import type { Clock } from "../services/clock";
import type { ClientIpResolver } from "../services/client-ip";
import type { RateLimiter } from "../services/rate-limit";

/**
 * Seller routes mounted at `/api/seller`.
 *
 * `POST /api/seller/onboarding` runs behind the existing security stack in a
 * fixed order: authentication (session cookie), CSRF (synchronizer token) and
 * then the seller-onboarding per-IP rate limit before the handler. The handler
 * only reads the body, hands everything to the injected {@link SellerService},
 * and returns the shared envelope. It never touches repositories directly and
 * never constructs a service itself.
 *
 * `POST /api/seller/products` runs behind the same stack plus an explicit
 * seller-role gate ({@link requireSellerRole}) and a dedicated per-IP rate
 * limit, then delegates identity verification and product creation to
 * {@link SellerService.createProduct}.
 *
 * `POST /api/seller/products/:id/variants`,
 * `POST /api/seller/products/:id/variants/:variantId/inventory` and
 * `POST /api/seller/products/:id/publish` extend the same flow: each runs
 * behind auth, the seller-role gate, CSRF and its own per-IP rate limit, then
 * delegates to {@link SellerService}. Ownership is resolved entirely
 * server-side by the service from the authenticated session, never from the
 * request body.
 *
 * Route modules stay edge-compatible: the seller repository is injected by the
 * application boundary and only its contract is referenced here as a type.
 */

/** Reject non-seller callers after the auth middleware has resolved identity. */
export function requireSellerRole(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth.user.role !== "seller") {
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to perform this action.",
        403,
      );
    }
    await next();
  };
}

export interface SellerRoutesDependencies {
  config: AppConfig;
  sellerService: SellerService;
  sessionRepository: AuthSessionRepository;
  userRepository: UserRepository;
  clock: Clock;
  rateLimiter: RateLimiter;
  clientIpResolver: ClientIpResolver;
}

/**
 * Read the JSON request body as `unknown` so validation owns all shape
 * checks. Malformed JSON or an empty body surfaces as `null`, which the shared
 * validation layer rejects with a `VALIDATION_ERROR` envelope instead of
 * leaking a parser exception.
 */
async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function createSellerRoutes(dependencies: SellerRoutesDependencies): Hono<AppEnv> {
  const { config, sellerService, sessionRepository, userRepository, clock, rateLimiter, clientIpResolver } =
    dependencies;
  const app = new Hono<AppEnv>();

  const requireAuth = createAuthMiddleware({
    sessionRepository,
    userRepository,
    clock,
    config,
  });
  const requireCsrf = createCsrfMiddleware();

  const onboardingRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-onboarding",
    limit: config.rateLimitSellerOnboardingIpMax,
    windowSeconds: config.rateLimitSellerOnboardingIpWindowSeconds,
  });

  const productCreateRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-product-create",
    limit: config.rateLimitProductCreateIpMax,
    windowSeconds: config.rateLimitProductCreateIpWindowSeconds,
  });

  const productVariantRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-product-variant",
    limit: config.rateLimitProductCreateIpMax,
    windowSeconds: config.rateLimitProductCreateIpWindowSeconds,
  });

  const productInventoryRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-product-inventory",
    limit: config.rateLimitProductCreateIpMax,
    windowSeconds: config.rateLimitProductCreateIpWindowSeconds,
  });

  const productPublishRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-product-publish",
    limit: config.rateLimitProductCreateIpMax,
    windowSeconds: config.rateLimitProductCreateIpWindowSeconds,
  });

  app.post("/onboarding", requireAuth, requireCsrf, onboardingRateLimit, async (c) => {
    const auth = c.get("auth");
    const body = await readJsonBody(c);
    const data = await sellerService.onboard(auth.user, body);
    return c.json<SellerOnboardingEnvelope>({ ok: true, data }, 201);
  });

  app.get("/products", requireAuth, requireSellerRole(), async (c) => {
    const auth = c.get("auth");
    const data = await sellerService.listProducts(auth.user, {
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    return c.json<ListSellerProductsEnvelope>({ ok: true, data }, 200);
  });

  app.get("/products/:id", requireAuth, requireSellerRole(), async (c) => {
    const auth = c.get("auth");
    const data = await sellerService.getProduct(auth.user, c.req.param("id"));
    return c.json<GetSellerProductEnvelope>({ ok: true, data }, 200);
  });

  app.post(
    "/products",
    requireAuth,
    requireSellerRole(),
    requireCsrf,
    productCreateRateLimit,
    async (c) => {
      const auth = c.get("auth");
      const body = await readJsonBody(c);
      const data = await sellerService.createProduct(auth.user, body);
      return c.json<CreateProductEnvelope>({ ok: true, data }, 201);
    },
  );

  app.post(
    "/products/:id/variants",
    requireAuth,
    requireSellerRole(),
    requireCsrf,
    productVariantRateLimit,
    async (c) => {
      const auth = c.get("auth");
      const id = c.req.param("id");
      const body = await readJsonBody(c);
      const data = await sellerService.createVariant(auth.user, id, body);
      return c.json<CreateProductVariantEnvelope>({ ok: true, data }, 201);
    },
  );

  app.post(
    "/products/:id/variants/:variantId/inventory",
    requireAuth,
    requireSellerRole(),
    requireCsrf,
    productInventoryRateLimit,
    async (c) => {
      const auth = c.get("auth");
      const id = c.req.param("id");
      const variantId = c.req.param("variantId");
      const body = await readJsonBody(c);
      const data = await sellerService.setInventory(auth.user, id, variantId, body);
      return c.json<SetInventoryEnvelope>({ ok: true, data }, 200);
    },
  );

  app.post(
    "/products/:id/publish",
    requireAuth,
    requireSellerRole(),
    requireCsrf,
    productPublishRateLimit,
    async (c) => {
      const auth = c.get("auth");
      const id = c.req.param("id");
      const data = await sellerService.publishProduct(auth.user, id);
      return c.json<PublishProductEnvelope>({ ok: true, data }, 200);
    },
  );

  return app;
}