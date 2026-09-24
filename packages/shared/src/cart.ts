/**
 * Shared shopping-cart contracts between the API and the browser.
 *
 * A cart is the authenticated customer's working selection: a stable cart id
 * and a list of {@link CartItemDto} that reference sellable variants by id
 * with a positive quantity. Cart responses deliberately carry no pricing or
 * totals — money is always derived from live variant prices at checkout, never
 * trusted from the client — so the only fields are identity and quantity.
 *
 * Every cart endpoint returns the customer's cart as it looks after the
 * operation, wrapped in the standard envelope.
 */

import type { ApiEnvelope } from "./envelope";

/** Quantity bounds enforced by the API (and mirrored by the web app). */
export const CART_ITEM_QUANTITY_LIMITS = {
  min: 1,
  max: 99,
} as const;

export interface CartItemDto {
  id: string;
  variantId: string;
  quantity: number;
}

export interface CartDto {
  id: string;
  items: CartItemDto[];
}

/** Body for `POST /api/cart/items`. */
export interface AddCartItemRequest {
  variantId: string;
  quantity: number;
}

/** Body for `PATCH /api/cart/items/:itemId`. */
export interface UpdateCartItemRequest {
  quantity: number;
}

/** Error codes the cart endpoints can produce, as stable string values. */
export const CART_ERROR_CODES = {
  VARIANT_NOT_FOUND: "VARIANT_NOT_FOUND",
  CART_ITEM_NOT_FOUND: "CART_ITEM_NOT_FOUND",
} as const;
export type CartErrorCode = (typeof CART_ERROR_CODES)[keyof typeof CART_ERROR_CODES];

/** Typed envelope for the shared cart (all five endpoints return it). */
export type CartEnvelope = ApiEnvelope<CartDto>;