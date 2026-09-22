import type { MiddlewareHandler } from "hono";
import type { AppConfig, Logger } from "@zelora/core";

export function requestLogger(config: AppConfig, logger: Logger): MiddlewareHandler {
  if (config.nodeEnv === "test") {
    return async (_c, next) => {
      await next();
    };
  }

  return async (c, next) => {
    const requestId = crypto.randomUUID();
    c.header("X-Request-Id", requestId);
    const startedAt = performance.now();
    await next();
    const durationMs = Math.round(performance.now() - startedAt);
    logger.info("request completed", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
    });
  };
}