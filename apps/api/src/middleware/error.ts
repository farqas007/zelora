import type { Context } from "hono";
import type { ApiFailure } from "@zelora/shared";
import { AppError, NotFoundError, toApiFailure, type Logger } from "@zelora/core";

export function createErrorHandler(logger: Logger) {
  return (err: Error, c: Context): Response => {
    if (err instanceof AppError) {
      logger.warn("request failed", {
        code: err.code,
        status: err.statusCode,
        message: err.message,
      });
    } else {
      logger.error("unhandled error", {
        name: err instanceof Error ? err.name : "unknown",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const status = err instanceof AppError ? err.statusCode : 500;
    const failure = toApiFailure(err);
    return c.json(failure, status);
  };
}

export function notFoundHandler(c: Context): Response {
  const failure: ApiFailure = toApiFailure(new NotFoundError());
  return c.json(failure, 404);
}