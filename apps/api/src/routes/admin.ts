import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { AppError, type AppConfig } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRepository } from "@zelora/db/users";
import { isValidId } from "@zelora/db/ids";
import type { SellerActivationEnvelope } from "@zelora/shared";
import type { AppEnv } from "../context";
import { createAuthMiddleware } from "../middleware/auth";
import { createCsrfMiddleware } from "../middleware/csrf";
import type { SellerService } from "../services/seller";
import type { Clock } from "../services/clock";

/**
 * Admin-only routes mounted at `/api/admin`.
 *
 * `POST /api/admin/sellers/:userId/activate` is the approval step that
 * completes the seller lifecycle: onboarding creates a `pending` profile and a
 * `draft` store, and this endpoint (server-assigned role `admin` only) flips
 * both to `active` and promotes the owner to `seller`. It runs behind the same
 * stack as every mutation: session auth, an explicit admin-role gate, then
 * CSRF. The target is addressed by the owning user's id (UUIDv7) so a pending
 * account is never activatable by guessing a sequential profile id.
 */

export interface AdminRoutesDependencies {
  config: AppConfig;
  sellerService: SellerService;
  sessionRepository: AuthSessionRepository;
  userRepository: UserRepository;
  clock: Clock;
}

/** Reject non-admin callers after the auth middleware has resolved identity. */
export function requireAdmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth.user.role !== "admin") {
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to perform this action.",
        403,
      );
    }
    await next();
  };
}

export function createAdminRoutes(dependencies: AdminRoutesDependencies): Hono<AppEnv> {
  const { config, sellerService, sessionRepository, userRepository, clock } = dependencies;
  const app = new Hono<AppEnv>();

  const requireAuth = createAuthMiddleware({
    sessionRepository,
    userRepository,
    clock,
    config,
  });
  const requireCsrf = createCsrfMiddleware();

  app.post(
    "/sellers/:userId/activate",
    requireAuth,
    requireAdmin(),
    requireCsrf,
    async (c) => {
      const userId = c.req.param("userId");
      if (!isValidId(userId)) {
        throw new AppError("NOT_FOUND", "The requested resource was not found.", 404);
      }

      const data = await sellerService.activateSeller(userId);
      return c.json<SellerActivationEnvelope>({ ok: true, data }, 200);
    },
  );

  return app;
}