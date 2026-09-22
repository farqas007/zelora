import { Hono } from "hono";
import type { Context } from "hono";
import type { AppConfig } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRecord, UserRepository } from "@zelora/db/users";
import type {
  AuthMeEnvelope,
  AuthUserResponse,
  LoginEnvelope,
  LoginRequest,
  LogoutAllEnvelope,
  LogoutEnvelope,
  RegisterEnvelope,
  RegisterRequest,
  UserDto,
} from "@zelora/shared";
import type { AppEnv } from "../context";
import { createAuthMiddleware } from "../middleware/auth";
import { createCsrfMiddleware } from "../middleware/csrf";
import { createIpRateLimitMiddleware } from "../middleware/rate-limit";
import type { AuthService } from "../services/auth";
import { clearSessionCookie, setSessionCookie } from "../services/cookie";
import type { Clock } from "../services/clock";
import type { ClientIpResolver } from "../services/client-ip";
import type { RateLimiter } from "../services/rate-limit";

/**
 * Auth endpoints mounted at `/api/auth`.
 *
 * The request handler layer only reads the body, delegates validation and
 * credential/session work to the injected {@link AuthService}, issues or
 * clears the configured session cookie, and returns the shared response
 * envelopes. It never touches repositories directly and never constructs
 * its own AuthService — both are composed by the application boundary.
 *
 * Route modules stay edge-compatible: database contracts are imported as
 * types only and the local (better-sqlite3) repositories are instantiated
 * in the Node composition module, never here.
 */

export interface AuthRoutesDependencies {
  config: AppConfig;
  authService: AuthService;
  userRepository: UserRepository;
  sessionRepository: AuthSessionRepository;
  clock: Clock;
  rateLimiter: RateLimiter;
  clientIpResolver: ClientIpResolver;
}

/**
 * Read the JSON request body as `unknown` so validation owns all of the
 * shape checks. Malformed JSON or an empty body surfaces as `null`, which
 * the shared validation layer rejects with a `VALIDATION_ERROR` envelope
 * instead of leaking a parser exception.
 */
async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * Project an authenticated user row to the public DTO shape. The projection
 * is explicit so route handlers can never leak `passwordHash` or `updatedAt`.
 */
function toUserDto(user: UserRecord): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

export function createAuthRoutes(dependencies: AuthRoutesDependencies): Hono<AppEnv> {
  const { config, authService, userRepository, sessionRepository, clock, rateLimiter, clientIpResolver } =
    dependencies;
  const app = new Hono<AppEnv>();

  const requireAuth = createAuthMiddleware({
    sessionRepository,
    userRepository,
    clock,
    config,
  });
  const requireCsrf = createCsrfMiddleware();

  const loginRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "login",
    limit: config.rateLimitLoginIpMax,
    windowSeconds: config.rateLimitLoginIpWindowSeconds,
  });

  const registerRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "register",
    limit: config.rateLimitRegisterIpMax,
    windowSeconds: config.rateLimitRegisterIpWindowSeconds,
  });

  app.post("/register", registerRateLimit, async (c) => {
    const body = await readJsonBody(c);
    const result = await authService.register(body as RegisterRequest);
    setSessionCookie(config, c, result.rawSessionToken);

    const data: AuthUserResponse = { user: result.user, session: result.session };
    return c.json<RegisterEnvelope>({ ok: true, data }, 201);
  });

  app.post("/login", loginRateLimit, async (c) => {
    const body = await readJsonBody(c);
    const result = await authService.login(body as LoginRequest);
    setSessionCookie(config, c, result.rawSessionToken);

    const data: AuthUserResponse = { user: result.user, session: result.session };
    return c.json<LoginEnvelope>({ ok: true, data });
  });

  app.post("/logout", requireAuth, requireCsrf, async (c) => {
    const auth = c.get("auth");
    await sessionRepository.deleteById(auth.session.id);
    clearSessionCookie(config, c);
    return c.json<LogoutEnvelope>({ ok: true, data: { done: true } });
  });

  app.post("/logout-all", requireAuth, requireCsrf, async (c) => {
    const auth = c.get("auth");
    await sessionRepository.deleteAllForUser(auth.user.id);
    clearSessionCookie(config, c);
    return c.json<LogoutAllEnvelope>({ ok: true, data: { done: true } });
  });

  app.get("/me", requireAuth, async (c) => {
    const auth = c.get("auth");
    return c.json<AuthMeEnvelope>({ ok: true, data: { user: toUserDto(auth.user) } });
  });

  return app;
}