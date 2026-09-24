import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { AppError, type AppConfig } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRepository } from "@zelora/db/users";
import { isValidId } from "@zelora/db/ids";
import type {
  AdminBootstrapEnvelope,
  AdminPendingSellersEnvelope,
  SellerActivationEnvelope,
  SellerRejectionEnvelope,
} from "@zelora/shared";
import type { AppEnv } from "../context";
import { createAuthMiddleware } from "../middleware/auth";
import { createCsrfMiddleware } from "../middleware/csrf";
import type { AdminService } from "../services/admin";
import type { Clock } from "../services/clock";

/**
 * Admin-only routes mounted at `/api/admin`.
 *
 * Two distinct security postures live here:
 *
 * 1. `POST /bootstrap` is the single unauthenticated provisioning endpoint
 *    that creates the first administrator. It is guarded solely by the
 *    server-side `ADMIN_BOOTSTRAP_SECRET` presented in a dedicated header and
 *    compared in constant time (see {@link ADMIN_BOOTSTRAP_HEADER}). It is
 *    rendered indistinguishable from a missing resource when the secret is
 *    unset, never signs a session, and refuses to promote an existing
 *    account.
 *
 * 2. Everything else (`/sellers/*`) runs behind the same stack as every
 *    mutation: session auth, an explicit admin-role gate, then CSRF. The
 *    target is addressed by the owning user's id (UUIDv7) so a pending
 *    account is never reachable by guessing a sequential profile id.
 *
 * All transitions — bootstrap, activation, rejection — are audited by the
 * {@link AdminService}.
 */

/** Header carrying the bootstrap secret. Named distinctly so CSRF/session
 *  middleware can never collide with it. */
export const ADMIN_BOOTSTRAP_HEADER = "X-Zelora-Admin-Bootstrap";

export interface AdminRoutesDependencies {
  config: AppConfig;
  adminService: AdminService;
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

export function createAdminRoutes(dependencies: AdminRoutesDependencies): Hono<AppEnv> {
  const { config, adminService, sessionRepository, userRepository, clock } = dependencies;
  const app = new Hono<AppEnv>();

  const requireAuth = createAuthMiddleware({
    sessionRepository,
    userRepository,
    clock,
    config,
  });
  const requireCsrf = createCsrfMiddleware();
  const requireAdminRole = requireAdmin();

  app.post("/bootstrap", async (c) => {
    const body = await readJsonBody(c);
    const result = await adminService.bootstrapAdmin(
      c.req.header(ADMIN_BOOTSTRAP_HEADER),
      body,
    );
    return c.json<AdminBootstrapEnvelope>(
      { ok: true, data: { user: result.user } },
      result.created ? 201 : 200,
    );
  });

  app.get("/sellers/pending", requireAuth, requireAdminRole, async (c) => {
    const data = await adminService.listPendingSellers(c.req.query());
    return c.json<AdminPendingSellersEnvelope>({ ok: true, data }, 200);
  });

  app.post(
    "/sellers/:userId/activate",
    requireAuth,
    requireAdminRole,
    requireCsrf,
    async (c) => {
      const userId = c.req.param("userId");
      if (!isValidId(userId)) {
        throw new AppError("NOT_FOUND", "The requested resource was not found.", 404);
      }

      const auth = c.get("auth");
      const data = await adminService.activateSeller(auth.user, userId);
      return c.json<SellerActivationEnvelope>({ ok: true, data }, 200);
    },
  );

  app.post(
    "/sellers/:userId/reject",
    requireAuth,
    requireAdminRole,
    requireCsrf,
    async (c) => {
      const userId = c.req.param("userId");
      if (!isValidId(userId)) {
        throw new AppError("NOT_FOUND", "The requested resource was not found.", 404);
      }

      const auth = c.get("auth");
      const data = await adminService.rejectSeller(auth.user, userId);
      return c.json<SellerRejectionEnvelope>({ ok: true, data }, 200);
    },
  );

  return app;
}