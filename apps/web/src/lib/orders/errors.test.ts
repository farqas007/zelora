import { describe, expect, it } from "vitest";
import { ORDER_ERROR_CODES } from "@zelora/shared";
import { ApiFailureError } from "../api/client";
import { resolveOrderFailure } from "./errors";

function failure(code: string): ApiFailureError {
  return new ApiFailureError({ code, message: "raw server message" });
}

describe("resolveOrderFailure", () => {
  it("maps each stable order error code to presentation copy", () => {
    const messages = [
      failure(ORDER_ERROR_CODES.CART_EMPTY),
      failure(ORDER_ERROR_CODES.LINE_UNAVAILABLE),
      failure(ORDER_ERROR_CODES.STOCK_CHANGED),
      failure(ORDER_ERROR_CODES.CURRENCY_MIX),
      failure(ORDER_ERROR_CODES.ORDER_NOT_FOUND),
    ].map((error) => resolveOrderFailure(error));

    expect(messages.some((message) => message.includes("Your cart is empty."))).toBe(true);
    expect(messages.some((message) => message.includes("no longer available"))).toBe(true);
    expect(messages.some((message) => message.includes("no longer has enough stock"))).toBe(true);
    expect(messages.some((message) => message.includes("different currencies"))).toBe(true);
    expect(messages.some((message) => message.includes("This order could not be found."))).toBe(
      true,
    );
  });

  it("does not leak the raw server message for known codes", () => {
    for (const code of [
      ORDER_ERROR_CODES.CART_EMPTY,
      ORDER_ERROR_CODES.LINE_UNAVAILABLE,
      ORDER_ERROR_CODES.STOCK_CHANGED,
      ORDER_ERROR_CODES.CURRENCY_MIX,
      ORDER_ERROR_CODES.ORDER_NOT_FOUND,
    ]) {
      expect(resolveOrderFailure(failure(code))).not.toBe("raw server message");
    }
  });

  it("reports an expired session and CSRF failures the same way as the rest of the app", () => {
    expect(resolveOrderFailure(failure("SESSION_EXPIRED"))).toContain("session has expired");
    expect(resolveOrderFailure(failure("CSRF_FAILED"))).toContain("could not be verified");
  });
});