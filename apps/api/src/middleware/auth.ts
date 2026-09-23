import type { MiddlewareHandler } from "hono";
import { AUTH_ERROR_CODES } from "@zelora/shared";
import { AppError, hashSessionToken, type AppConfig } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRepository } from "@zelora/db/users";
import type { AppEnv } from "../context";
import type { Clock } from "../services/clock";
import { clearSessionCookie, readSessionCookie } from "../services/cookie";

/**
 * Session-cookie authentication middleware.
 *
 * Resolves the caller's identity from the configured session cookie: the raw
 * token is hashed before lookup, the session is expiry-checked against the
 * injected clock, and the owning user is verified (missing/suspended/deleted
 * users invalidate the session). On success the resolved identity is placed
 * on the Hono context under `auth`. Failures surface as `AppError`s that the
 * shared error boundary maps to the standard API failure envelope.
 *
 * Repository contracts are imported as types only, so edge runtimes never
 * pull the Node-only SQLite stack through this module.
 */

export interface AuthMiddlewareDependencies {
  sessionRepository: AuthSessionRepository;
  userRepository: UserRepository;
  clock: Clock;
  config: AppConfig;
}

function sessionExpiredError(): AppError {
  return new AppError(
    AUTH_ERROR_CODES.SESSION_EXPIRED,
    "Your session has expired. Please sign in again.",
    401,
  );
}

export function createAuthMiddleware(
  dependencies: AuthMiddlewareDependencies,
): MiddlewareHandler<AppEnv> {
  const { sessionRepository, userRepository, clock, config } = dependencies;

  return async (c, next) => {
    const rawToken = readSessionCookie(config, c);
    if (rawToken === undefined) {
      throw sessionExpiredError();
    }

    let tokenHash: string;
    try {
      tokenHash = await hashSessionToken(rawToken);
    } catch {
      clearSessionCookie(config, c);
      throw sessionExpiredError();
    }

    const session = await sessionRepository.findByTokenHash(tokenHash);
    if (session === null) {
      clearSessionCookie(config, c);
      throw sessionExpiredError();
    }

    if (session.expiresAt.getTime() <= clock.now().getTime()) {
      await sessionRepository.deleteById(session.id);
      clearSessionCookie(config, c);
      throw sessionExpiredError();
    }

    const user = await userRepository.findById(session.userId);
    if (user === null) {
      await sessionRepository.deleteById(session.id);
      clearSessionCookie(config, c);
      throw sessionExpiredError();
    }

    if (user.status === "suspended") {
      await sessionRepository.deleteAllForUser(user.id);
      clearSessionCookie(config, c);
      throw new AppError(
        AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
        "This account has been suspended.",
        403,
      );
    }

    if (user.status === "deleted") {
      await sessionRepository.deleteAllForUser(user.id);
      clearSessionCookie(config, c);
      throw new AppError(
        AUTH_ERROR_CODES.ACCOUNT_DELETED,
        "This account has been deleted.",
        403,
      );
    }

    const now = clock.now();
    const touchThresholdMs = config.sessionLastUsedThrottleSeconds * 1_000;
    const lastUsedAt = session.lastUsedAt;
    if (lastUsedAt === null || now.getTime() - lastUsedAt.getTime() >= touchThresholdMs) {
      await sessionRepository.updateLastUsedAt(session.id, now);
      session.lastUsedAt = now;
    }
    c.set("auth", { session, user });
    await next();
  };
}
