/**
 * Shared checkout/order contracts between the API and the browser.
 *
 * This module is the customer-facing vocabulary for placing an order and
 * reviewing past orders. It stays dependency-free (plain types/constants),
 * mirroring the `packages/db` enums on purpose exactly like `./products`.
 *
 * The checkout flow is deliberately price-verifying: the web app gathers an
 * address and the customer's session cart, but the API never accepts a price
 * or a total from the client. `PlaceOrderRequest` carries only addresses; the
 * server resolves the cart, recomputes every line total and the order total
 * from live catalog prices, snapshots them into `order_items`/`orders`, and
 * decrements inventory in the same atomic write.
 */

import type { ApiEnvelope } from "./envelope";

export const ORDER_STATUSES = ["pending", "confirmed", "processing", "completed", "cancelled", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_ITEM_STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled", "refunded"] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

export const ORDER_ADDRESS_KINDS = ["shipping", "billing"] as const;
export type OrderAddressKind = (typeof ORDER_ADDRESS_KINDS)[number];

/**
 * Validation limits for the address snapshots accepted at checkout. Shared so
 * the web app can mirror field hints without hardcoding. `countryCode` must be
 * exactly two uppercase letters (ISO 3166-1 alpha-2), enforced by the same
 * `CURRENCY_PATTERN`-style rule the schema's `CHECK (length = 2)` guards.
 */
export const CHECKOUT_LIMITS = {
  recipientNameMinLength: 1,
  recipientNameMaxLength: 120,
  phoneMaxLength: 40,
  line1MinLength: 1,
  line1MaxLength: 120,
  line2MaxLength: 120,
  cityMinLength: 1,
  cityMaxLength: 120,
  regionMaxLength: 120,
  postalCodeMaxLength: 32,
} as const;

/** 2-letter ISO 3166-1 alpha-2 country code, e.g. `US`. */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/** Page-size bounds for `GET /api/orders`, shared so the web app can mirror them. */
export const ORDER_PAGE_LIMITS = {
  min: 1,
  max: 50,
  default: 20,
} as const;

/**
 * The header carrying the client-generated idempotency key on `POST
 * /api/orders`. It is a header rather than a body field so the key never
 * reaches repricing, and so intermediaries treat it as metadata.
 */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/**
 * Bounds on an idempotency key. The floor keeps a key from being trivially
 * guessable or accidentally constant (a key that collides by accident turns
 * two unrelated checkouts into one); the ceiling keeps it inside what a single
 * `text` column, an index entry and an HTTP header all hold cheaply, which is
 * what the orders schema's `CHECK (length BETWEEN ...)` mirrors.
 *
 * 64 also covers a UUIDv4 (36), a UUIDv7 (36) and a ULID (26) with room to
 * spare, so the natural choices of client-side generators all fit.
 */
export const IDEMPOTENCY_KEY_LIMITS = {
  minLength: 8,
  maxLength: 64,
} as const;

/**
 * The characters an idempotency key may contain: alphanumerics plus `.`, `_`,
 * `~`, `:` and `-`.
 *
 * The set is deliberately narrow. A key is echoed back into a header, indexed
 * and logged, so it excludes every delimiter that would make those ambiguous
 * (`"` and `\` for logs, CR and LF for headers, `,` and `;` for multi-value
 * header folding) and everything outside printable ASCII.
 *
 * The character class carries no length quantifier on purpose: length is
 * `IDEMPOTENCY_KEY_LIMITS`' job, and a second bound baked into the pattern is
 * one more place for the two to drift apart. `POST /api/orders` therefore
 * applies both, and `limits.test.ts` holds them in agreement.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:-]+$/;

/**
 * Length of an `idempotency_fingerprint`: a SHA-256 digest rendered as hex.
 * The orders schema's `CHECK (length = ...)` is derived from this so a digest
 * of the wrong width cannot be stored.
 */
export const IDEMPOTENCY_FINGERPRINT_HEX_LENGTH = 64;

/**
 * One address snapshot to persist at checkout. Every address field is
 * collected server-side from the request (never from a stored address book) so
 * the order is self-describing.
 */
export interface OrderAddressRequest {
  recipientName: string;
  phone?: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  countryCode: string;
}

/**
 * Body of `POST /api/orders`. `shippingAddress` is required; `billingAddress`
 * is optional and defaults to the shipping address when absent.
 */
export interface PlaceOrderRequest {
  shippingAddress: OrderAddressRequest;
  billingAddress?: OrderAddressRequest;
}

/** One order line as the customer sees it (name and price snapshotted at checkout). */
export interface OrderLineDto {
  id: string;
  variantId: string;
  /** The store that owns the line, recorded at checkout time. */
  storeId: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitAmountCents: number;
  lineTotalAmountCents: number;
  currency: string;
  status: OrderItemStatus;
}

/** A persisted order-address snapshot. */
export interface OrderAddressDto {
  kind: OrderAddressKind;
  recipientName: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
}

/**
 * Order summary for a list row or a checkout response: the order itself, its
 * lines, and the derived `itemCount`. Addresses are deliberately absent — a
 * customer does not need their shipping snapshot on an order list row.
 */
export interface OrderSummaryDto {
  id: string;
  status: OrderStatus;
  currency: string;
  subtotalAmountCents: number;
  shippingAmountCents: number;
  discountAmountCents: number;
  totalAmountCents: number;
  itemCount: number;
  items: OrderLineDto[];
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/** Order detail: everything in the summary plus the saved address snapshots. */
export interface OrderDetailDto extends OrderSummaryDto {
  addresses: OrderAddressDto[];
}

export interface OrderListData {
  items: OrderSummaryDto[];
  /** Opaque keyset cursor for the next page, or `null` when this is the last page. */
  nextCursor: string | null;
}

export type ListOrdersEnvelope = ApiEnvelope<OrderListData>;
export type PlaceOrderEnvelope = ApiEnvelope<OrderDetailDto>;
export type GetOrderEnvelope = ApiEnvelope<OrderDetailDto>;

/**
 * Error codes the order endpoints can produce, as stable string values.
 * Auth/ownership transport errors reuse the auth vocabulary
 * (`ACCOUNT_SUSPENDED`, `ACCOUNT_DELETED`, `RATE_LIMITED`, `VALIDATION_ERROR`).
 *
 * The 409 family distinguishes the checkout failure modes a customer can act
 * on: the line became un-buyable (`LINE_UNAVAILABLE`, e.g. the product was
 * archived or its store deactivated) versus the line is still buyable but its
 * stock no longer covers the requested quantity (`STOCK_CHANGED`).
 */
export const ORDER_ERROR_CODES = {
  /** The session cart is empty, so there is nothing to check out. */
  CART_EMPTY: "CART_EMPTY",
  /** At least one cart line is no longer sellable (inactive / taken down). */
  LINE_UNAVAILABLE: "LINE_UNAVAILABLE",
  /** A line is still sellable but its live stock no longer covers the quantity. */
  STOCK_CHANGED: "STOCK_CHANGED",
  /** Cart lines span multiple currencies; a single order holds one currency. */
  CURRENCY_MIX: "CURRENCY_MIX",
  /** The requested order does not exist for this customer. */
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  /**
   * The idempotency key was already used by this customer for a materially
   * different checkout. Reusing a key is safe, changing what it means is not:
   * silently honouring the first order would hand back the wrong merchandise.
   */
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
} as const;
export type OrderErrorCode = (typeof ORDER_ERROR_CODES)[keyof typeof ORDER_ERROR_CODES];