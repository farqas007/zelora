import { Hono } from "hono";
import type { Context } from "hono";
import type { AppConfig } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRepository } from "@zelora/db/users";
import { IDEMPOTENCY_HEADER, type GetOrderEnvelope, type ListOrdersEnvelope, type PlaceOrderEnvelope } from "@zelora/shared";
import type { AppEnv } from "../context";
import { createAuthMiddleware } from "../middleware/auth";
import { createCsrfMiddleware } from "../middleware/csrf";
import { createIpRateLimitMiddleware } from "../middleware/rate-limit";
import type { OrderService } from "../services/orders";
import { parseIdempotencyKey } from "../services/validation";
import type { Clock } from "../services/clock";
import type { ClientIpResolver } from "../services/client-ip";
import type { RateLimiter } from "../services/rate-limit";

/**
 * Customer order routes mounted at `/api/orders`.
 *
 * `GET /api/orders` and `GET /api/orders/:orderId` are reads behind the
 * session-auth middleware only, matching the other customer reads: no CSRF
 * check (they change no state) and no write rate limit.
 *
 * `POST /api/orders` is the checkout mutation and runs the full security
 * stack in the same order as every other authenticated write: session auth,
 * CSRF synchronizer-token check, then a dedicated per-IP
 * `order-place` budget before the handler. The handler stays thin — it reads
 * the raw body and the `Idempotency-Key` header and hands both to the injected
 * {@link OrderService}, which owns all of the address validation, cart
 * re-pricing, atomic persistence and cart clearing. Identity always comes from
 * the session; nothing in the request body is an owner.
 *
 * The key is required, and it is required from the client: the server has no
 * safe way to invent one (anything it generated would differ per attempt and
 * turn every retry into a second order). Reading it here rather than deep in
 * the service keeps it in the transport layer where it belongs — a header, not
 * a field of the priced order.
 *
 * The rate limit deliberately runs before the body is parsed, so a caller
 * over budget is refused without buffering a payload — checkout is the most
 * expensive write in the customer surface (live price resolution plus an
 * atomic stock decrement), so it is the one gated by the cheap check.
 *
 * Route modules stay edge-compatible: repositories are injected by the
 * application boundary and only their contracts are referenced here as types.
 */

export interface OrderRoutesDependencies {
  config: AppConfig;
  orderService: OrderService;
  sessionRepository: AuthSessionRepository;
  userRepository: UserRepository;
  clock: Clock;
  rateLimiter: RateLimiter;
  clientIpResolver: ClientIpResolver;
}

/**
 * Read the JSON request body as `unknown` so validation owns all of the shape
 * checks. Malformed JSON or an empty body surfaces as `null`, which the
 * service's validation layer rejects with a `VALIDATION_ERROR` envelope
 * instead of leaking a parser exception.
 */
async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function createOrderRoutes(dependencies: OrderRoutesDependencies): Hono<AppEnv> {
  const { config, orderService, sessionRepository, userRepository, clock, rateLimiter, clientIpResolver } =
    dependencies;
  const app = new Hono<AppEnv>();

  const requireAuth = createAuthMiddleware({
    sessionRepository,
    userRepository,
    clock,
    config,
  });
  const requireCsrf = createCsrfMiddleware();
  const orderPlaceRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "order-place",
    limit: config.rateLimitOrderPlaceIpMax,
    windowSeconds: config.rateLimitOrderPlaceIpWindowSeconds,
  });

  app.get("/", requireAuth, async (c) => {
    const auth = c.get("auth");
    const data = await orderService.listOrders(auth.user, {
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    return c.json<ListOrdersEnvelope>({ ok: true, data }, 200);
  });

  app.post("/", requireAuth, requireCsrf, orderPlaceRateLimit, async (c) => {
    const auth = c.get("auth");
    // The idempotency key is validated before the body is even read: it is
    // transport-level, and refusing a checkout that could not be replayed is
    // cheaper than parsing a payload we are going to reject anyway.
    const idempotencyKey = parseIdempotencyKey(c.req.header(IDEMPOTENCY_HEADER));
    const body = await readJsonBody(c);
    const data = await orderService.placeOrder(auth.user, body, idempotencyKey);
    return c.json<PlaceOrderEnvelope>({ ok: true, data }, 201);
  });

  app.get("/:orderId", requireAuth, async (c) => {
    const auth = c.get("auth");
    const data = await orderService.getOrder(auth.user, c.req.param("orderId"));
    return c.json<GetOrderEnvelope>({ ok: true, data }, 200);
  });

  return app;
}