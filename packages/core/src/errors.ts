import type { ApiErrorBody, ApiFailure } from "@zelora/shared";

/** HTTP status codes the platform can produce. */
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;

/**
 * Base class for all intentionally thrown application errors.
 * Errors are mapped to the typed API failure envelope by the API's
 * error boundary. Any other `Error` that escapes is treated as an
 * internal server error (see {@link UnknownError}).
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: HttpStatus;
  readonly details?: Record<string, unknown>;
  readonly fields?: Record<string, string[]>;

  constructor(
    code: string,
    message: string,
    statusCode: HttpStatus,
    details?: Record<string, unknown>,
    fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.fields = fields;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request.", details?: Record<string, unknown>) {
    super("BAD_REQUEST", message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required.") {
    super("UNAUTHORIZED", message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super("FORBIDDEN", message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "The requested resource was not found.") {
    super("NOT_FOUND", message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = "The request conflicts with the current state.") {
    super("CONFLICT", message, 409);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests. Please try again later.", details?: Record<string, unknown>) {
    super("RATE_LIMITED", message, 429, details);
  }
}

export class ValidationError extends AppError {
  constructor(
    message = "The request is invalid.",
    fields?: Record<string, string[]>,
    details?: Record<string, unknown>,
  ) {
    super("VALIDATION_ERROR", message, 422, details, fields);
  }
}

/** Internal/unknown error; never leak its message to clients. */
export class UnknownError extends AppError {
  constructor(message = "Internal server error.", details?: Record<string, unknown>) {
    super("INTERNAL_ERROR", message, 500, details);
  }
}

/** Convert any thrown value into the shared API failure envelope. */
export function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof AppError) {
    const body: ApiErrorBody = { code: error.code, message: error.message };
    if (error.details !== undefined) {
      body.details = error.details;
    }
    if (error.fields !== undefined) {
      body.fields = error.fields;
    }
    return { ok: false, error: body };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: error.message },
    };
  }

  return { ok: false, error: { code: "INTERNAL_ERROR", message: "Unknown error." } };
}