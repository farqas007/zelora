import type { MiddlewareHandler } from "hono";
import {
  TooManyRequestsError,
  type AppConfig,
} from "@zelora/core";
import type { Clock } from "../services/clock";
import type { RateLimiter } from "../services/rate-limit";
import { normalizeClientIp, type ClientIpResolver } from "../services/client-ip";

/**
 * Per-IP fixed-window throttle for the public auth endpoints.
 *
 * The middleware resolves the client address through the injected
 * {@link ClientIpResolver} (never from raw headers by default), consumes a
 * namespaced bucket before any request body is parsed or any expensive work
 * runs, and surfaces a `429` through the existing error envelope with a
 * `Retry-After` header. Disabled, it is a transparent pass-through.
 *
 * Edge-compatible: only Hono/core types are used — the client-IP source of
 * truth is injected by the Node composition boundary.
 */

export interface IpRateLimitMiddlewareOptions {
  config: AppConfig;
  rateLimiter: RateLimiter;
  clientIpResolver: ClientIpResolver;
  clock: Clock;
  /** Namespacing component, e.g. "login" or "register". */
  scope: string;
  limit: number;
  windowSeconds: number;
}

export function createIpRateLimitMiddleware(
  options: IpRateLimitMiddlewareOptions,
): MiddlewareHandler {
  const { config, rateLimiter, clientIpResolver, clock, scope, limit, windowSeconds } =
    options;

  return async (c, next) => {
    if (!config.rateLimitEnabled) {
      await next();
      return;
    }

    const resolved = clientIpResolver.resolve(c);
    const ip = normalizeClientIp(resolved) ?? "unknown";
    const outcome = await rateLimiter.consume(
      `auth:${scope}:ip:${ip}`,
      limit,
      windowSeconds,
    );

    if (outcome.allowed) {
      await next();
      return;
    }

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((outcome.resetAt.getTime() - clock.now().getTime()) / 1000),
    );
    c.header("Retry-After", String(retryAfterSeconds));
    throw new TooManyRequestsError("Too many requests. Please try again later.", {
      retryAfterSeconds,
      scope: "ip",
    });
  };
}