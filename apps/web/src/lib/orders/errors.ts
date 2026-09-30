import { AUTH_ERROR_CODES, ORDER_ERROR_CODES } from "@zelora/shared";
import { ApiFailureError } from "../api/client";
import { resolveApiFailure } from "../auth/errors";

/**
 * Maps failures from the order API into user-safe, presentation-ready copy.
 * Builds on {@link resolveApiFailure} (auth + transport handling) and layers
 * on the stable order error codes so callers surface precise feedback instead
 * of the raw API message.
 */

export function resolveOrderFailure(error: unknown): string {
  if (error instanceof ApiFailureError) {
    switch (error.code) {
      case ORDER_ERROR_CODES.CART_EMPTY:
        return "Your cart is empty. Add something before checking out.";
      case ORDER_ERROR_CODES.LINE_UNAVAILABLE:
        return "An item in your cart is no longer available. Please review it and try again.";
      case ORDER_ERROR_CODES.STOCK_CHANGED:
        return "An item in your cart no longer has enough stock. Please review it and try again.";
      case ORDER_ERROR_CODES.CURRENCY_MIX:
        return "Your cart contains items priced in different currencies. Please remove one before checking out.";
      case ORDER_ERROR_CODES.ORDER_NOT_FOUND:
        return "This order could not be found.";
      case ORDER_ERROR_CODES.IDEMPOTENCY_CONFLICT:
        // The key already placed a *different* order, so this page's key belongs
        // to a checkout that is finished. Retrying would keep colliding, and the
        // shopper has to deliberately start a new one instead.
        return "This checkout has already been placed with different details. Review your orders, then start a new checkout.";
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