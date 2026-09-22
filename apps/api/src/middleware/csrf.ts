import type { MiddlewareHandler } from "hono";
import { AUTH_ERROR_CODES } from "@zelora/shared";
import { AppError, constantTimeEqual } from "@zelora/core";
import type { AppEnv } from "../context";

/** Header the authenticated client must echo the session's CSRF token in. */
export const CSRF_HEADER = "X-Zelora-CSRF";

/**
 * Methods that must not require CSRF validation: they are safe to invoke
 * cross-site because no server-side state changes as a side effect.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function csrfFailedError(): AppError {
  return new AppError(
    AUTH_ERROR_CODES.CSRF_FAILED,
    "CSRF validation failed.",
    403,
  );
}

/**
 * Synchronizer-token CSRF middleware.
 *
 * Sits behind the auth middleware on authenticated mutating routes. Safe
 * methods pass straight through; unsafe methods must supply the session's
 * CSRF token in the {@link CSRF_HEADER} header. The token is verified with a
 * constant-time comparison against the resolved session's token and never
 * echoed back in an error. Failures are indistinguishable to an attacker
 * (single generic {@link AppError} with no details).
 *
 * Edge-compatible: no Node-only APIs. `TextEncoder` is a web standard global.
 */
export function createCsrfMiddleware(): MiddlewareHandler<AppEnv> {
  const encoder = new TextEncoder();

  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }

    const auth = c.get("auth");
    if (auth === undefined) {
      throw csrfFailedError();
    }

    const provided = c.req.header(CSRF_HEADER);
    if (provided === undefined || provided === "") {
      throw csrfFailedError();
    }

    const providedBytes = encoder.encode(provided);
    const expectedBytes = encoder.encode(auth.session.csrfToken);
    if (!constantTimeEqual(providedBytes, expectedBytes)) {
      throw csrfFailedError();
    }

    await next();
  };
}