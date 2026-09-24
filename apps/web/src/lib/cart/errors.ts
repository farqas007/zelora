import { AUTH_ERROR_CODES, CART_ERROR_CODES } from "@zelora/shared";
import { ApiFailureError } from "../api/client";
import { resolveApiFailure } from "../auth/errors";

/**
 * Maps failures from the cart API into user-safe, presentation-ready copy.
 * Builds on {@link resolveApiFailure} (auth + transport handling) and layers
 * on the stable cart error codes so callers surface precise feedback instead
 * of the raw API message.
 */

export function resolveCartFailure(error: unknown): string {
  if (error instanceof ApiFailureError) {
    switch (error.code) {
      case CART_ERROR_CODES.VARIANT_NOT_FOUND:
        return "This product is no longer available.";
      case CART_ERROR_CODES.CART_ITEM_NOT_FOUND:
        return "This item is no longer in your cart.";
      case AUTH_ERROR_CODES.SESSION_EXPIRED:
        return "Your session has expired. Please sign in again.";
      case AUTH_ERROR_CODES.CSRF_FAILED:
        return "Your session could not be verified. Please refresh the page and try again.";
      default:
        break;
    }
  }
  return resolveApiFailure(error).message;
}