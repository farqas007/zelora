import { AUTH_ERROR_CODES } from "@zelora/shared";
import { ApiClientError, ApiFailureError } from "../api/client";

/**
 * Maps failures from the API client into user-safe, presentation-ready form
 * feedback. Raw internal messages (INTERNAL_ERROR, unexpected envelopes) are
 * never surfaced verbatim — callers only ever see friendly copy.
 */

export interface ResolvedFormError {
  message: string;
  fields: Record<string, string[]>;
}

const GENERIC_MESSAGE = "Something went wrong. Please try again.";
const NETWORK_MESSAGE =
  "Unable to reach the server. Please check your connection and try again.";

/** Stable copy for a known auth error code; `fallback` is the API's own message. */
export function describeAuthCode(code: string, fallback: string): string {
  switch (code) {
    case AUTH_ERROR_CODES.INVALID_CREDENTIALS:
      return "Invalid email or password.";
    case AUTH_ERROR_CODES.EMAIL_IN_USE:
      return "An account with this email already exists.";
    case AUTH_ERROR_CODES.ACCOUNT_SUSPENDED:
    case AUTH_ERROR_CODES.ACCOUNT_DELETED:
      return fallback;
    case AUTH_ERROR_CODES.RATE_LIMITED:
      return "Too many attempts. Please wait a moment and try again.";
    case AUTH_ERROR_CODES.CSRF_FAILED:
      return "Your session could not be verified. Please refresh the page and try again.";
    case AUTH_ERROR_CODES.SESSION_EXPIRED:
      return "Your session has expired. Please sign in again.";
    default:
      return GENERIC_MESSAGE;
  }
}

export function resolveApiFailure(error: unknown): ResolvedFormError {
  if (error instanceof ApiFailureError) {
    if (
      error.code === "VALIDATION_ERROR" &&
      error.fields !== undefined &&
      Object.keys(error.fields).length > 0
    ) {
      return { message: "Please fix the highlighted fields and try again.", fields: error.fields };
    }
    return { message: describeAuthCode(error.code, error.message), fields: {} };
  }
  if (error instanceof ApiClientError) {
    return { message: NETWORK_MESSAGE, fields: {} };
  }
  return { message: GENERIC_MESSAGE, fields: {} };
}