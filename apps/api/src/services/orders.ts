import {
  AUTH_ERROR_CODES,
  ORDER_ERROR_CODES,
  ORDER_PAGE_LIMITS,
  type OrderAddressDto,
  type OrderAddressKind,
  type OrderDetailDto,
  type OrderLineDto,
  type OrderListData,
  type OrderSummaryDto,
  type PlaceOrderRequest,
} from "@zelora/shared";
import { AppError, NotFoundError, ValidationError } from "@zelora/core";
import { isValidId } from "@zelora/db/ids";
import type { UserRecord } from "@zelora/db/users";
import type { CartRepository, CartWithItemsRecord } from "@zelora/db/cart";
import type { CatalogRepository } from "@zelora/db/catalog";
import type {
  CreateOrderAddressInput,
  CreateOrderLineInput,
  OrderAddressRecord,
  OrderItemRecord,
  OrderRecord,
  OrderRepository,
  OrderWithItemsRecord,
} from "@zelora/db/orders";
import { fingerprintCheckoutRequest } from "./order-fingerprint";
import { parsePlaceOrderRequest } from "./validation";

/**
 * Order lifecycle for an authenticated customer.
 *
 * Every method takes the authenticated {@link UserRecord} and owns three data
 * dependencies: the cart repository (the session's items), the catalog
 * repository (live prices + sellability at checkout time), and the order
 * repository (atomic persistence). Identity always comes from the session —
 * nothing from the request body is trusted, and reads always scope to the
 * caller's own orders.
 *
 * `placeOrder` is deliberately a *re-pricing* step, never a pass-through:
 * totals are recomputed server-side from live variant prices via
 * {@link CatalogRepository.listSellableVariantsByIds}, the cart's quantity is
 * the only client-owned input, and the monetized columns are snapshotted into
 * the order's immutable records. The order repository then decrements
 * inventory in the same atomic write; a stock undershoot or a deleted variant
 * in the race window surfaces as a conflict the service maps to a stable
 * {@link ORDER_ERROR_CODES} value. `CURRENCY_MIX` is rejected here because one
 * order holds a single currency.
 *
 * Checkout is idempotent. Each call carries a client-generated
 * `idempotencyKey`, and the key is written by the same atomic insert that
 * decrements inventory — so the key is consumed exactly when an order commits,
 * and a checkout that rolled back leaves it free for the shopper to retry. A
 * repeat of the same key and request returns the original order untouched
 * (including not clearing the cart again); a repeat of the same key with a
 * different request is refused with `IDEMPOTENCY_CONFLICT` rather than being
 * answered with the wrong order. See {@link fingerprintCheckoutRequest} for
 * what makes two requests "the same".
 *
 * Money is always present at checkout but the cart itself stays money-free —
 * the shared {@link CartDto} never carries a price, and the subtotal the web
 * app displays is derived from live catalog prices, never trusted.
 *
 * Edge-compatible: database contracts are imported as types only and all
 * repository I/O goes through the injected async ports.
 */

export interface OrderServiceDependencies {
  cartRepository: CartRepository;
  catalogRepository: CatalogRepository;
  orderRepository: OrderRepository;
}

/** Query parameters accepted by `GET /api/orders`; `limit`/`cursor` are raw strings or missing. */
export interface ListOrdersParams {
  limit?: string;
  cursor?: string;
}

function assertActiveUser(user: UserRecord): void {
  if (user.status === "suspended") {
    throw new AppError(
      AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
      "This account has been suspended.",
      403,
    );
  }
  if (user.status === "deleted") {
    throw new AppError(
      AUTH_ERROR_CODES.ACCOUNT_DELETED,
      "This account has been deleted.",
      403,
    );
  }
}

function toOrderLineDto(item: OrderItemRecord): OrderLineDto {
  return {
    id: item.id,
    variantId: item.variantId,
    storeId: item.storeId,
    productName: item.productName,
    variantName: item.variantName,
    quantity: item.quantity,
    unitAmountCents: item.unitAmountCents,
    lineTotalAmountCents: item.lineTotalAmountCents,
    currency: item.currency,
    status: item.status,
  };
}

function toOrderAddressDto(address: OrderAddressRecord): OrderAddressDto {
  return {
    kind: address.kind,
    recipientName: address.recipientName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
  };
}

function toOrderSummaryDto(record: OrderWithItemsRecord): OrderSummaryDto {
  const { order, items } = record;
  return {
    id: order.id,
    status: order.status,
    currency: order.currency,
    subtotalAmountCents: order.subtotalAmountCents,
    shippingAmountCents: order.shippingAmountCents,
    discountAmountCents: order.discountAmountCents,
    totalAmountCents: order.totalAmountCents,
    itemCount: items.length,
    items: items.map(toOrderLineDto),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

function toOrderDetailDto(
  order: OrderRecord,
  addresses: OrderAddressRecord[],
  items: OrderItemRecord[],
): OrderDetailDto {
  return {
    ...toOrderSummaryDto({ order, items }),
    addresses: addresses.map(toOrderAddressDto),
  };
}

/**
 * Parse the `limit` query string against {@link ORDER_PAGE_LIMITS}. Blank or
 * missing falls back to the default; anything that is not a positive integer
 * is a {@link ValidationError}, not a silent repair.
 */
function parseOrderListLimit(rawLimit: string | undefined): number {
  if (rawLimit === undefined || rawLimit === "") {
    return ORDER_PAGE_LIMITS.default;
  }
  if (!/^\d+$/.test(rawLimit)) {
    throw new ValidationError("The request is invalid.", {
      limit: ["Limit must be a positive integer."],
    });
  }
  const limit = Number(rawLimit);
  if (limit < ORDER_PAGE_LIMITS.min || limit > ORDER_PAGE_LIMITS.max) {
    throw new ValidationError("The request is invalid.", {
      limit: [
        `Limit must be between ${ORDER_PAGE_LIMITS.min} and ${ORDER_PAGE_LIMITS.max}.`,
      ],
    });
  }
  return limit;
}

function toCreateOrderAddressInput(
  address: PlaceOrderRequest["shippingAddress"],
  kind: OrderAddressKind,
): CreateOrderAddressInput {
  return {
    kind,
    recipientName: address.recipientName,
    phone: address.phone ?? null,
    line1: address.line1,
    line2: address.line2 ?? null,
    city: address.city,
    region: address.region ?? null,
    postalCode: address.postalCode ?? null,
    countryCode: address.countryCode,
  };
}

export class OrderService {
  private readonly cartRepository: CartRepository;
  private readonly catalogRepository: CatalogRepository;
  private readonly orderRepository: OrderRepository;

  constructor(dependencies: OrderServiceDependencies) {
    this.cartRepository = dependencies.cartRepository;
    this.catalogRepository = dependencies.catalogRepository;
    this.orderRepository = dependencies.orderRepository;
  }

  /**
   * Resolve a customer's own cart and its items, or `null`. Unlike the cart
   * service's lazy create this never creates a row: checkout needs a real cart
   * to place an order, so a missing cart is simply empty.
   */
  private async getCartOrNull(userId: string): Promise<CartWithItemsRecord | null> {
    return this.cartRepository.getCartByUserId(userId);
  }

  /**
   * Place an order from the session cart and the submitted addresses.
   *
   * `idempotencyKey` is the caller's client-generated key (already validated by
   * {@link parseIdempotencyKey} at the edge). Checkout is retryable: the same
   * key plus the same request always resolves to the same order, however many
   * times it is sent, and a key the checkout then fails on is left unused so the
   * shopper can retry with it.
   *
   * The request body is parsed (and only addresses are accepted), then the
   * cart is re-read from the repository and every line is re-priced from live
   * sellable variants. Failures map to stable codes:
   *
   * - empty cart → `CART_EMPTY` (409);
   * - a line whose variant is no longer buyable (inactive/archived/sold out)
   *   → `LINE_UNAVAILABLE` (409);
   * - a line whose live stock no longer covers the quantity →
   *   `STOCK_CHANGED` (409);
   * - lines priced in different currencies → `CURRENCY_MIX` (422).
   *
   * On success the order + addresses + lines are written atomically while
   * inventory is decremented, then the cart is cleared. The returned detail
   * always carries both address snapshots (billing defaults to shipping).
   */
  async placeOrder(
    user: UserRecord,
    request: unknown,
    idempotencyKey: string,
  ): Promise<OrderDetailDto> {
    assertActiveUser(user);
    const parsed = parsePlaceOrderRequest(request);
    const fingerprint = await fingerprintCheckoutRequest(user.id, parsed);

    // The replay check comes before any cart or pricing work. A retry of a
    // checkout that already committed arrives with an empty cart, so reading it
    // first would answer `CART_EMPTY` for a request that in fact succeeded.
    const existing = await this.orderRepository.findByIdempotencyKeyForCustomer(user.id, idempotencyKey);
    if (existing !== null) {
      if (existing.order.idempotencyFingerprint !== fingerprint) {
        // Same key, different request. Returning the first order would hand the
        // shopper merchandise they did not ask for; refusing is the only safe
        // answer.
        throw new AppError(
          ORDER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "This idempotency key was already used for a different checkout.",
          409,
        );
      }
      // A genuine retry: the original order is the answer, and the cart is not
      // cleared again — the first attempt already emptied it, and this call may
      // even be answering for a cart the shopper has since refilled.
      return toOrderDetailDto(existing.order, existing.addresses, existing.items);
    }

    const cart = await this.getCartOrNull(user.id);
    if (cart === null || cart.items.length === 0) {
      throw new AppError(ORDER_ERROR_CODES.CART_EMPTY, "Your cart is empty.", 409);
    }

    const sellables = await this.catalogRepository.listSellableVariantsByIds(
      cart.items.map((item) => item.variantId),
    );
    const sellableById = new Map(sellables.map((sellable) => [sellable.id, sellable]));

    const lines: CreateOrderLineInput[] = [];
    let currency: string | null = null;
    for (const item of cart.items) {
      const sellable = sellableById.get(item.variantId);
      if (sellable === undefined) {
        throw new AppError(
          ORDER_ERROR_CODES.LINE_UNAVAILABLE,
          "An item in your cart is no longer available for purchase.",
          409,
        );
      }
      if (sellable.availableQuantity < item.quantity) {
        throw new AppError(
          ORDER_ERROR_CODES.STOCK_CHANGED,
          "An item in your cart no longer has enough stock.",
          409,
        );
      }
      if (currency !== null && sellable.currency !== currency) {
        throw new AppError(
          ORDER_ERROR_CODES.CURRENCY_MIX,
          "Your cart contains items priced in different currencies.",
          422,
        );
      }
      currency = sellable.currency;
      lines.push({
        variantId: sellable.id,
        storeId: sellable.storeId,
        productName: sellable.productName,
        variantName: sellable.name,
        sku: sellable.sku,
        quantity: item.quantity,
        unitAmountCents: sellable.priceAmountCents,
        lineTotalAmountCents: sellable.priceAmountCents * item.quantity,
        currency: sellable.currency,
      });
    }

    const subtotalAmountCents = lines.reduce(
      (sum, line) => sum + line.lineTotalAmountCents,
      0,
    );
    const shippingAmountCents = 0;
    const discountAmountCents = 0;
    const totalAmountCents = subtotalAmountCents;

    const billingAddress = parsed.billingAddress ?? parsed.shippingAddress;
    const createOrderResult = await this.orderRepository.createOrder({
      customerUserId: user.id,
      idempotencyKey,
      idempotencyFingerprint: fingerprint,
      currency: currency as string,
      subtotalAmountCents,
      shippingAmountCents,
      discountAmountCents,
      totalAmountCents,
      addresses: [
        toCreateOrderAddressInput(parsed.shippingAddress, "shipping"),
        toCreateOrderAddressInput(billingAddress, "billing"),
      ],
      lines,
    });

    if (!createOrderResult.ok) {
      if (createOrderResult.reason === "DUPLICATE_IDEMPOTENCY_KEY") {
        // A concurrent request with this key committed between the read above
        // and this insert, so its order is the one this request asked for.
        return this.resolveConcurrentReplay(user.id, idempotencyKey, fingerprint);
      }
      // A line the service believed buyable ran out of stock (or its variant
      // was removed) in the narrow window before the atomic write. Map the
      // driver-neutral conflict back to the customer-facing code. The
      // idempotency key was rolled back with the write, so the shopper can
      // retry with it once the cart is fixed.
      if (createOrderResult.reason === "INSUFFICIENT_STOCK") {
        throw new AppError(
          ORDER_ERROR_CODES.STOCK_CHANGED,
          "An item in your cart no longer has enough stock.",
          409,
        );
      }
      throw new AppError(
        ORDER_ERROR_CODES.LINE_UNAVAILABLE,
        "An item in your cart is no longer available for purchase.",
        409,
      );
    }

    await this.cartRepository.clearCart(cart.cart.id);
    return toOrderDetailDto(
      createOrderResult.order,
      createOrderResult.addresses,
      createOrderResult.items,
    );
  }

  /**
   * Re-read the order that won the race for an idempotency key and answer with
   * it, or report the conflict.
   *
   * Only reachable when `createOrder` reported `DUPLICATE_IDEMPOTENCY_KEY`, so
   * the winner's row is committed and readable by the time the losing
   * transaction was rejected. If it is somehow not there, the safe answer is
   * still a conflict: the API must never place or return an order it cannot
   * account for.
   */
  private async resolveConcurrentReplay(
    customerUserId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<OrderDetailDto> {
    const winner = await this.orderRepository.findByIdempotencyKeyForCustomer(customerUserId, idempotencyKey);
    if (winner !== null && winner.order.idempotencyFingerprint === fingerprint) {
      return toOrderDetailDto(winner.order, winner.addresses, winner.items);
    }
    throw new AppError(
      ORDER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      "This idempotency key was already used for a different checkout.",
      409,
    );
  }

  /**
   * Keyset-paginated list of the caller's orders, newest first. `limit` is
   * parsed against {@link ORDER_PAGE_LIMITS}; a malformed value is a
   * {@link ValidationError}. Order rows are append-only, so a returned cursor
   * stays valid across subsequent pages.
   */
  async listOrders(user: UserRecord, params: ListOrdersParams | undefined): Promise<OrderListData> {
    assertActiveUser(user);
    const limit = parseOrderListLimit(params?.limit);
    const page = await this.orderRepository.listByCustomer(user.id, {
      limit,
      cursor: params?.cursor || null,
    });
    return {
      items: page.items.map(toOrderSummaryDto),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Resolve one of the caller's orders with its address snapshots and lines.
   * Scoped to the caller: another customer's order id resolves to `null` and
   * surfaces as `ORDER_NOT_FOUND` (404), matching the read contract of every
   * other customer-scoped endpoint.
   */
  async getOrder(user: UserRecord, orderId: string): Promise<OrderDetailDto> {
    assertActiveUser(user);
    if (!isValidId(orderId)) {
      throw new NotFoundError("The order was not found.");
    }
    const record = await this.orderRepository.findByIdForCustomer(user.id, orderId);
    if (record === null) {
      throw new AppError(
        ORDER_ERROR_CODES.ORDER_NOT_FOUND,
        "The order was not found.",
        404,
      );
    }
    return toOrderDetailDto(record.order, record.addresses, record.items);
  }
}