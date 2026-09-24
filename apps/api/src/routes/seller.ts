import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { AppError, type AppConfig } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRepository } from "@zelora/db/users";
import type { SellerOnboardingEnvelope, CreateProductEnvelope } from "@zelora/shared";
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

  app.post("/onboarding", requireAuth, requireCsrf, onboardingRateLimit, async (c) => {
    const auth = c.get("auth");
    const body = await readJsonBody(c);
    const data = await sellerService.onboard(auth.user, body);
    return c.json<SellerOnboardingEnvelope>({ ok: true, data }, 201);
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

  return app;
}