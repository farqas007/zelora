import { Hono } from "hono";
import type { Context } from "hono";
import type { AppConfig } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRepository } from "@zelora/db/users";
import type { CartEnvelope } from "@zelora/shared";
import type { AppEnv } from "../context";
import { createAuthMiddleware } from "../middleware/auth";
import { createCsrfMiddleware } from "../middleware/csrf";
import type { CartService } from "../services/cart";
import type { Clock } from "../services/clock";

/**
 * Cart routes mounted at `/api`.
 *
 * `GET /api/cart` reads behind the session-auth middleware only; every
 * mutation (`POST/PATCH/DELETE`) additionally runs the CSRF synchronizer-token
 * check, matching the rest of the authenticated write surface. Handlers stay
 * thin: they resolve identity from the session, hand the raw body / path id to
 * the injected {@link CartService}, and return the shared {@link CartEnvelope}
 * carrying the caller's cart after the operation. `POST /api/cart/items`
 * signals `201` when a genuinely new row was created and `200` when an
 * existing item's quantity was incremented.
 */

export interface CartRoutesDependencies {
  config: AppConfig;
  cartService: CartService;
  sessionRepository: AuthSessionRepository;
  userRepository: UserRepository;
  clock: Clock;
}

/**
 * Read the JSON request body as `unknown` so validation owns all of the shape
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

export function createCartRoutes(dependencies: CartRoutesDependencies): Hono<AppEnv> {
  const { config, cartService, sessionRepository, userRepository, clock } = dependencies;
  const app = new Hono<AppEnv>();

  const requireAuth = createAuthMiddleware({
    sessionRepository,
    userRepository,
    clock,
    config,
  });
  const requireCsrf = createCsrfMiddleware();

  app.get("/cart", requireAuth, async (c) => {
    const auth = c.get("auth");
    const data = await cartService.getCart(auth.user);
    return c.json<CartEnvelope>({ ok: true, data }, 200);
  });

  app.post("/cart/items", requireAuth, requireCsrf, async (c) => {
    const auth = c.get("auth");
    const body = await readJsonBody(c);
    const { data, created } = await cartService.addItem(auth.user, body);
    return c.json<CartEnvelope>({ ok: true, data }, created ? 201 : 200);
  });

  app.patch("/cart/items/:itemId", requireAuth, requireCsrf, async (c) => {
    const auth = c.get("auth");
    const itemId = c.req.param("itemId");
    const body = await readJsonBody(c);
    const data = await cartService.updateItemQuantity(auth.user, itemId, body);
    return c.json<CartEnvelope>({ ok: true, data }, 200);
  });

  app.delete("/cart/items/:itemId", requireAuth, requireCsrf, async (c) => {
    const auth = c.get("auth");
    const itemId = c.req.param("itemId");
    const data = await cartService.removeItem(auth.user, itemId);
    return c.json<CartEnvelope>({ ok: true, data }, 200);
  });

  app.delete("/cart", requireAuth, requireCsrf, async (c) => {
    const auth = c.get("auth");
    const data = await cartService.clearCart(auth.user);
    return c.json<CartEnvelope>({ ok: true, data }, 200);
  });

  return app;
}