import { describe, expect, it } from "vitest";
import { AppError } from "@zelora/core";
import type { UserRecord } from "@zelora/db/users";
import type { CatalogRepository, SellableVariantRecord } from "@zelora/db/catalog";
import type {
  CartItemRecord,
  CartRecord,
  CartRepository,
  CartWithItemsRecord,
} from "@zelora/db/cart";
import type {
  CreateOrderResult,
  OrderWithDetailsRecord,
  OrderWithItemsRecord,
  OrderRepository,
} from "@zelora/db/orders";
import type { OrderListQuery } from "@zelora/db/orders";
import { OrderService, type OrderServiceDependencies } from "./orders";

/**
 * Service-level tests for the order lifecycle. Both repositories are faked so
 * every decision (identity guard, empty cart, sellability/stock/currency
 * failure modes, server-side re-pricing, atomic-write conflict mapping, cart
 * clearing, list pagination, ownership-scoped read) can be asserted without a
 * database.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");
const ORDER_ID = "00000000-0000-7000-8000-0000000000ab";

let seq = 0;

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  seq += 1;
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    email: `orders-${seq}@example.test`,
    name: "Order Customer",
    role: "customer",
    status: "active",
    passwordHash: "hash",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeVariant(overrides: Partial<SellableVariantRecord> = {}): SellableVariantRecord {
  seq += 1;
  const id = `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`;
  return {
    id,
    name: "Variant",
    sku: null,
    priceAmountCents: 1000,
    currency: "USD",
    productId: id,
    productName: "Product",
    storeId: id,
    availableQuantity: 10,
    ...overrides,
  };
}

function makeAddress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipientName: "Ada Lovelace",
    phone: "+1 555 0100",
    line1: "1 Analytical Way",
    city: "London",
    region: "England",
    postalCode: "SW1A",
    countryCode: "GB",
    ...overrides,
  };
}

class FakeCatalogRepository implements CatalogRepository {
  sellables = new Map<string, SellableVariantRecord>();

  async listSellableVariantsByIds(ids: string[]): Promise<SellableVariantRecord[]> {
    return ids
      .map((id) => this.sellables.get(id))
      .filter((sellable): sellable is SellableVariantRecord => sellable !== undefined);
  }

  async listActiveCategories() {
    return [];
  }

  async listActiveProducts() {
    return { items: [], nextCursor: null };
  }

  async findProductBySlug() {
    return null;
  }

  async findVariantById() {
    return null;
  }

  async findActiveStoreBySlug() {
    return null;
  }

  async listStoreProducts() {
    return { items: [], nextCursor: null };
  }
}

class FakeOrderRepository implements OrderRepository {
  /** Sellable projections shared with the catalog fake, re-read when projecting a created order. */
  sellables = new Map<string, SellableVariantRecord>();
  private detailsByCustomer = new Map<string, Map<string, OrderWithDetailsRecord>>();
  private listImpl:
    | ((customerUserId: string, opts: OrderListQuery) => Promise<{ items: OrderWithItemsRecord[]; nextCursor: string | null }>)
    | undefined = undefined;
  /** Force the atomic write to report a conflict the mapper must translate. */
  forceCreateConflict: "INSUFFICIENT_STOCK" | "VARIANT_NOT_FOUND" | null = null;
  createCalls: unknown[] = [];

  overrideList(list: (customerUserId: string, opts: OrderListQuery) => Promise<{ items: OrderWithItemsRecord[]; nextCursor: string | null }>): void {
    this.listImpl = list;
  }

  setDetail(customerUserId: string, record: OrderWithDetailsRecord): void {
    let byId = this.detailsByCustomer.get(customerUserId);
    if (byId === undefined) {
      byId = new Map();
      this.detailsByCustomer.set(customerUserId, byId);
    }
    byId.set(record.order.id, record);
  }

  async createOrder(input: unknown): Promise<CreateOrderResult> {
    this.createCalls.push(input);
    if (this.forceCreateConflict !== null) {
      return { ok: false, reason: this.forceCreateConflict };
    }
    const call = input as {
      customerUserId: string;
      currency: string;
      subtotalAmountCents: number;
      shippingAmountCents: number;
      discountAmountCents: number;
      totalAmountCents: number;
      addresses: Array<{ kind: "shipping" | "billing"; recipientName: string; line1: string }>;
      lines: Array<{ variantId: string; quantity: number }>;
    };
    const line = call.lines[0] as { variantId: string; quantity: number };
    const variant = this.sellables.get(line.variantId) ?? makeVariant({ id: line.variantId });
    const lineTotal = variant.priceAmountCents * line.quantity;
    const item = {
      id: "item-1",
      orderId: ORDER_ID,
      variantId: variant.id,
      storeId: variant.storeId,
      productName: variant.productName,
      variantName: variant.name,
      sku: variant.sku,
      quantity: line.quantity,
      unitAmountCents: variant.priceAmountCents,
      lineTotalAmountCents: lineTotal,
      currency: variant.currency,
      status: "pending" as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const order = {
      id: ORDER_ID,
      customerUserId: call.customerUserId,
      status: "pending" as const,
      currency: call.currency,
      subtotalAmountCents: call.subtotalAmountCents,
      shippingAmountCents: call.shippingAmountCents,
      discountAmountCents: call.discountAmountCents,
      totalAmountCents: call.totalAmountCents,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const findAddress = (kind: "shipping" | "billing") =>
      call.addresses.find((entry) => entry.kind === kind) ?? {
        kind,
        recipientName: "Ada Lovelace",
        line1: "1 Analytical Way",
      };
    const address = (kind: "shipping" | "billing") => {
      const source = findAddress(kind);
      return {
        id: `address-${kind}`,
        orderId: ORDER_ID,
        kind,
        recipientName: source.recipientName,
        phone: "+1 555 0100",
        line1: source.line1,
        line2: null,
        city: "London",
        region: "England",
        postalCode: "SW1A",
        countryCode: "GB",
        createdAt: NOW,
        updatedAt: NOW,
      };
    };
    return { ok: true, order, addresses: [address("shipping"), address("billing")], items: [item] };
  }

  async findByIdForCustomer(customerUserId: string, orderId: string): Promise<OrderWithDetailsRecord | null> {
    return this.detailsByCustomer.get(customerUserId)?.get(orderId) ?? null;
  }

  async listByCustomer(
    customerUserId: string,
    opts: OrderListQuery,
  ): Promise<{ items: OrderWithItemsRecord[]; nextCursor: string | null }> {
    if (this.listImpl !== undefined) {
      return this.listImpl(customerUserId, opts);
    }
    return { items: [], nextCursor: null };
  }
}

class FakeCartRepository implements CartRepository {
  private carts = new Map<string, CartRecord>();
  private items = new Map<string, CartItemRecord>();
  private cartByUser = new Map<string, string>();
  clearCalls: string[] = [];

  async getCartByUserId(userId: string): Promise<CartWithItemsRecord | null> {
    const cartId = this.cartByUser.get(userId);
    if (cartId === undefined) {
      return null;
    }
    const cart = this.carts.get(cartId);
    if (cart === undefined) {
      return null;
    }
    return {
      cart,
      items: Array.from(this.items.values()).filter((item) => item.cartId === cartId),
    };
  }

  async createCart(userId: string): Promise<{ ok: true; cart: CartRecord } | { ok: false; reason: "CART_EXISTS" }> {
    const id = `cart-${++seq}`;
    const cart: CartRecord = { id, userId, createdAt: NOW, updatedAt: NOW };
    this.carts.set(id, cart);
    this.cartByUser.set(userId, id);
    return { ok: true, cart };
  }

  async addItem(input: { cartId: string; variantId: string; quantity: number }): Promise<{ ok: true; item: CartItemRecord } | { ok: false; reason: "CART_ITEM_EXISTS" }> {
    const item: CartItemRecord = {
      id: `item-${++seq}`,
      cartId: input.cartId,
      variantId: input.variantId,
      quantity: input.quantity,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.items.set(item.id, item);
    return { ok: true, item };
  }

  async updateItemQuantity(cartId: string, itemId: string, quantity: number): Promise<CartItemRecord | null> {
    const item = this.items.get(itemId);
    if (item === undefined || item.cartId !== cartId) {
      return null;
    }
    const updated = { ...item, quantity, updatedAt: NOW };
    this.items.set(itemId, updated);
    return updated;
  }

  async removeItem(cartId: string, itemId: string): Promise<boolean> {
    const item = this.items.get(itemId);
    if (item === undefined || item.cartId !== cartId) {
      return false;
    }
    this.items.delete(itemId);
    return true;
  }

  async clearCart(cartId: string): Promise<number> {
    this.clearCalls.push(cartId);
    let removed = 0;
    for (const [id, item] of this.items) {
      if (item.cartId === cartId) {
        this.items.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  seedCart(userId: string, variantId: string, quantity: number): void {
    let cartId = this.cartByUser.get(userId);
    if (cartId === undefined) {
      cartId = `cart-seed-${++seq}`;
      const cart: CartRecord = { id: cartId, userId, createdAt: NOW, updatedAt: NOW };
      this.carts.set(cartId, cart);
      this.cartByUser.set(userId, cartId);
    }
    const item: CartItemRecord = {
      id: `item-seed-${++seq}`,
      cartId,
      variantId,
      quantity,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.items.set(item.id, item);
  }
}

function buildService(overrides: Partial<OrderServiceDependencies> = {}): {
  service: OrderService;
  cart: FakeCartRepository;
  orders: FakeOrderRepository;
  catalog: FakeCatalogRepository;
} {
  const cart = new FakeCartRepository();
  const orders = new FakeOrderRepository();
  const catalog = new FakeCatalogRepository();
  // Both fakes read from the same sellable projections so the created-order
  // projection reflects the same live prices the service used to re-price.
  orders.sellables = catalog.sellables;
  const service = new OrderService({
    cartRepository: overrides.cartRepository ?? cart,
    catalogRepository: overrides.catalogRepository ?? catalog,
    orderRepository: overrides.orderRepository ?? orders,
  });
  return { service, cart, orders, catalog };
}

async function expectCodeError(promise: Promise<unknown>, code: string, statusCode: number): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code, statusCode });
}

describe("OrderService.placeOrder", () => {
  it("rejects a checkout when the session cart is empty", async () => {
    const { service } = buildService();
    await expectCodeError(service.placeOrder(makeUser(), { shippingAddress: makeAddress() }), "CART_EMPTY", 409);
  });

  it("rejects a line whose variant is not sellable as LINE_UNAVAILABLE", async () => {
    const { service, cart, catalog } = buildService();
    const user = makeUser();
    // The cart references a variant that is not in the sellable result at all
    // (inactive product/taken down/sold out) — only a different variant sells.
    cart.seedCart(user.id, "variant-dead", 1);
    catalog.sellables.set("variant-other", makeVariant({ id: "variant-other" }));
    await expectCodeError(service.placeOrder(user, { shippingAddress: makeAddress() }), "LINE_UNAVAILABLE", 409);
  });

  it("distinguishes STOCK_CHANGED when the line is sellable but stock is short", async () => {
    const { service, cart, catalog } = buildService();
    const user = makeUser();
    catalog.sellables.set("variant-1", makeVariant({ id: "variant-1", availableQuantity: 1 }));
    cart.seedCart(user.id, "variant-1", 5);
    await expectCodeError(service.placeOrder(user, { shippingAddress: makeAddress() }), "STOCK_CHANGED", 409);
  });

  it("rejects CURRENCY_MIX when lines span multiple currencies", async () => {
    const { service, cart, catalog } = buildService();
    const user = makeUser();
    catalog.sellables.set("variant-1", makeVariant({ id: "variant-1" }));
    catalog.sellables.set("variant-2", makeVariant({ id: "variant-2", currency: "EUR" }));
    cart.seedCart(user.id, "variant-1", 1);
    cart.seedCart(user.id, "variant-2", 1);
    await expectCodeError(service.placeOrder(user, { shippingAddress: makeAddress() }), "CURRENCY_MIX", 422);
  });

  it("re-prices lines server-side, persists totals, defaults billing to shipping and clears the cart", async () => {
    const { service, cart, catalog, orders } = buildService();
    const user = makeUser();
    catalog.sellables.set("variant-1", makeVariant({ id: "variant-1", priceAmountCents: 1250, availableQuantity: 10 }));
    cart.seedCart(user.id, "variant-1", 2);

    const data = await service.placeOrder(user, { shippingAddress: makeAddress() });

    expect(data.totalAmountCents).toBe(2500);
    expect(data.subtotalAmountCents).toBe(2500);
    expect(data.itemCount).toBe(1);
    const line = data.items[0]!;
    expect(line.lineTotalAmountCents).toBe(2500);
    expect(line.unitAmountCents).toBe(1250);
    // Billing defaults to shipping, so both kinds are persisted.
    expect(data.addresses.map((address) => address.kind)).toEqual(["shipping", "billing"]);
    expect(cart.clearCalls).toHaveLength(1);
    const call = orders.createCalls[0] as { totalAmountCents: number; lines: Array<{ quantity: number; unitAmountCents: number }> };
    expect(call.totalAmountCents).toBe(2500);
    expect(call.lines).toHaveLength(1);
    expect(call.lines[0]).toMatchObject({ quantity: 2, unitAmountCents: 1250 });
  });

  it("honours an explicit billing address distinct from shipping", async () => {
    const { service, cart, catalog, orders } = buildService();
    const user = makeUser();
    catalog.sellables.set("variant-1", makeVariant({ id: "variant-1" }));
    cart.seedCart(user.id, "variant-1", 1);

    const billing = makeAddress({ recipientName: "Grace Hopper", line1: "7 Navy Yard" });
    const data = await service.placeOrder(user, { shippingAddress: makeAddress(), billingAddress: billing });

    const call = orders.createCalls[0] as { addresses: Array<{ kind: string; recipientName: string; line1: string }> };
    expect(call.addresses).toEqual([
      expect.objectContaining({ kind: "shipping", recipientName: "Ada Lovelace" }),
      expect.objectContaining({ kind: "billing", recipientName: "Grace Hopper", line1: "7 Navy Yard" }),
    ]);
    expect(data.addresses.find((address) => address.kind === "billing")?.recipientName).toBe("Grace Hopper");
  });

  it("maps an atomic INSUFFICIENT_STOCK conflict to STOCK_CHANGED", async () => {
    const { service, cart, catalog, orders } = buildService();
    const user = makeUser();
    catalog.sellables.set("variant-1", makeVariant({ id: "variant-1", availableQuantity: 10 }));
    cart.seedCart(user.id, "variant-1", 2);
    orders.forceCreateConflict = "INSUFFICIENT_STOCK";
    await expectCodeError(service.placeOrder(user, { shippingAddress: makeAddress() }), "STOCK_CHANGED", 409);
  });

  it("maps an atomic VARIANT_NOT_FOUND conflict to LINE_UNAVAILABLE", async () => {
    const { service, cart, catalog, orders } = buildService();
    const user = makeUser();
    catalog.sellables.set("variant-1", makeVariant({ id: "variant-1" }));
    cart.seedCart(user.id, "variant-1", 1);
    orders.forceCreateConflict = "VARIANT_NOT_FOUND";
    await expectCodeError(service.placeOrder(user, { shippingAddress: makeAddress() }), "LINE_UNAVAILABLE", 409);
  });

  it("rejects a checkout from a suspended account", async () => {
    const { service, cart, catalog } = buildService();
    const user = makeUser({ status: "suspended" });
    catalog.sellables.set("variant-1", makeVariant({ id: "variant-1" }));
    cart.seedCart(user.id, "variant-1", 1);
    await expectCodeError(service.placeOrder(user, { shippingAddress: makeAddress() }), "ACCOUNT_SUSPENDED", 403);
  });

  it("rejects an invalid address body with a VALIDATION_ERROR envelope", async () => {
    const { service, cart, catalog } = buildService();
    const user = makeUser();
    catalog.sellables.set("variant-1", makeVariant({ id: "variant-1" }));
    cart.seedCart(user.id, "variant-1", 1);
    await expectCodeError(
      service.placeOrder(user, {
        shippingAddress: { ...makeAddress(), countryCode: "USA" },
      }),
      "VALIDATION_ERROR",
      422,
    );
  });
});

/**
 * Client-price tampering.
 *
 * The checkout body is a hostile input: anyone can hand-write a request. The
 * guarantee under test is that no monetary or catalog field the client sends
 * reaches persistence — totals, currency, line composition and ownership are
 * all derived from the live catalog and the authenticated session's cart.
 */
describe("OrderService.placeOrder ignores client-supplied money and catalog fields", () => {
  /** The live price the seeded sellable variant is actually selling at. */
  const LIVE_PRICE_CENTS = 1_250;
  const LIVE_CURRENCY = "USD";
  const CART_QUANTITY = 2;

  /**
   * A checkout body an attacker would hand-craft: valid addresses, plus every
   * monetary/catalog/ownership field a naive implementation might read straight
   * off the request. Each poisoned value differs from the live truth so a
   * persisted value equal to it is unambiguous evidence of trust.
   */
  function tamperedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      shippingAddress: makeAddress(),
      billingAddress: makeAddress({ recipientName: "Mallory" }),
      // Order-level money, all zero so any acceptance is visible.
      totalAmountCents: 1,
      subtotalAmountCents: 1,
      shippingAmountCents: 999_999,
      discountAmountCents: 999_999,
      currency: "EUR",
      // Ownership and identity.
      customerUserId: "00000000-0000-7000-8000-00000000dead",
      userId: "00000000-0000-7000-8000-00000000dead",
      status: "completed",
      // Line composition and per-line money, under several plausible names.
      items: [
        {
          variantId: "attacker-variant",
          storeId: "attacker-store",
          productName: "Free Shipping",
          variantName: "Free",
          sku: null,
          quantity: 99,
          unitAmountCents: 1,
          lineTotalAmountCents: 1,
          priceAmountCents: 1,
          currency: "EUR",
        },
      ],
      lines: [
        {
          variantId: "attacker-variant",
          quantity: 99,
          unitAmountCents: 1,
          lineTotalAmountCents: 1,
          priceAmountCents: 1,
          currency: "EUR",
        },
      ],
      ...overrides,
    };
  }

  /** Seed one sellable variant holding two units in a two-deep cart. */
  function seededCheckout(): ReturnType<typeof buildService> & { user: ReturnType<typeof makeUser> } {
    const built = buildService();
    const user = makeUser();
    built.catalog.sellables.set(
      "variant-1",
      makeVariant({
        id: "variant-1",
        priceAmountCents: LIVE_PRICE_CENTS,
        currency: LIVE_CURRENCY,
        availableQuantity: 10,
      }),
    );
    built.cart.seedCart(user.id, "variant-1", CART_QUANTITY);
    return { ...built, user };
  }

  it("prices the order from the live catalog, ignoring a client-supplied total", async () => {
    const { service, orders, user } = seededCheckout();

    const data = await service.placeOrder(user, tamperedBody({ totalAmountCents: 1 }));

    // 1 250 x 2 from the catalog, not the 1 cent the client asked for.
    expect(data.totalAmountCents).toBe(LIVE_PRICE_CENTS * CART_QUANTITY);
    expect(data.subtotalAmountCents).toBe(LIVE_PRICE_CENTS * CART_QUANTITY);
    expect(data.shippingAmountCents).toBe(0);
    expect(data.discountAmountCents).toBe(0);
    const persisted = orders.createCalls[0] as { totalAmountCents: number; subtotalAmountCents: number };
    expect(persisted.totalAmountCents).toBe(LIVE_PRICE_CENTS * CART_QUANTITY);
    expect(persisted.subtotalAmountCents).toBe(LIVE_PRICE_CENTS * CART_QUANTITY);
  });

  it("prices every line from the live catalog, ignoring a client-supplied unit price", async () => {
    const { service, orders, user } = seededCheckout();

    const data = await service.placeOrder(user, tamperedBody());

    const line = data.items[0]!;
    expect(line.variantId).toBe("variant-1");
    expect(line.unitAmountCents).toBe(LIVE_PRICE_CENTS);
    expect(line.lineTotalAmountCents).toBe(LIVE_PRICE_CENTS * CART_QUANTITY);
    const persisted = orders.createCalls[0] as {
      lines: Array<{ variantId: string; quantity: number; unitAmountCents: number; lineTotalAmountCents: number }>;
    };
    expect(persisted.lines).toHaveLength(1);
    expect(persisted.lines[0]).toMatchObject({
      variantId: "variant-1",
      quantity: CART_QUANTITY,
      unitAmountCents: LIVE_PRICE_CENTS,
      lineTotalAmountCents: LIVE_PRICE_CENTS * CART_QUANTITY,
    });
  });

  it("takes the currency from the live catalog, ignoring a client-supplied currency", async () => {
    const { service, orders, user } = seededCheckout();

    const data = await service.placeOrder(user, tamperedBody({ currency: "EUR" }));

    expect(data.currency).toBe(LIVE_CURRENCY);
    expect(data.items[0]!.currency).toBe(LIVE_CURRENCY);
    const persisted = orders.createCalls[0] as { currency: string };
    expect(persisted.currency).toBe(LIVE_CURRENCY);
  });

  it("builds the lines from the session cart, ignoring injected items and lines", async () => {
    const { service, orders, user } = seededCheckout();

    const data = await service.placeOrder(user, tamperedBody());

    // The attacker's variant is nowhere in the cart, so it cannot be bought.
    expect(data.items.map((item) => item.variantId)).toEqual(["variant-1"]);
    expect(data.itemCount).toBe(1);
    const persisted = orders.createCalls[0] as { lines: Array<{ variantId: string; storeId: string; productName: string }> };
    expect(persisted.lines).toHaveLength(1);
    expect(persisted.lines[0]!.variantId).toBe("variant-1");
    expect(persisted.lines[0]!.storeId).not.toBe("attacker-store");
    expect(persisted.lines[0]!.productName).not.toBe("Free Shipping");
  });

  it("ignores a client quantity and keeps the cart's own quantity", async () => {
    const { service, orders, user } = seededCheckout();

    await service.placeOrder(user, tamperedBody({ quantity: 99 }));

    const persisted = orders.createCalls[0] as { lines: Array<{ quantity: number }> };
    expect(persisted.lines[0]!.quantity).toBe(CART_QUANTITY);
  });

  it("orders the cart for the session user, ignoring a spoofed owner and status", async () => {
    const { service, orders, user } = seededCheckout();

    const data = await service.placeOrder(user, tamperedBody());

    expect(data.status).toBe("pending");
    const persisted = orders.createCalls[0] as { customerUserId: string };
    expect(persisted.customerUserId).toBe(user.id);
    expect(persisted.customerUserId).not.toBe("00000000-0000-7000-8000-00000000dead");
  });

  it("persists only the validated addresses, discarding every other body key", async () => {
    const { service, orders, user } = seededCheckout();

    await service.placeOrder(user, tamperedBody());

    const persisted = orders.createCalls[0] as {
      addresses: Array<{ kind: string; recipientName: string }>;
    };
    expect(persisted.addresses.map((address) => address.kind)).toEqual(["shipping", "billing"]);
    expect(persisted.addresses[0]!.recipientName).toBe("Ada Lovelace");
    expect(persisted.addresses[1]!.recipientName).toBe("Mallory");
    // No field of the create call was copied wholesale from the request body.
    expect(Object.keys(persisted).sort()).toEqual([
      "addresses",
      "currency",
      "customerUserId",
      "discountAmountCents",
      "lines",
      "shippingAmountCents",
      "subtotalAmountCents",
      "totalAmountCents",
    ]);
  });

  it("still enforces live stock against the cart quantity, not a client quantity", async () => {
    const built = buildService();
    const user = makeUser();
    built.catalog.sellables.set(
      "variant-1",
      makeVariant({ id: "variant-1", priceAmountCents: LIVE_PRICE_CENTS, availableQuantity: 1 }),
    );
    built.cart.seedCart(user.id, "variant-1", 5);
    const { service, orders } = built;

    // A client claiming quantity 1 must not buy 5 units' worth, nor sneak past
    // the stock guard by understating what it wants.
    await expectCodeError(service.placeOrder(user, tamperedBody({ quantity: 1 })), "STOCK_CHANGED", 409);
    expect(orders.createCalls).toHaveLength(0);
  });

  it("refuses a body whose only content is a forged line for a variant the cart lacks", async () => {
    const built = buildService();
    const user = makeUser();
    built.catalog.sellables.set(
      "attacker-variant",
      makeVariant({ id: "attacker-variant", priceAmountCents: 1, availableQuantity: 100 }),
    );
    // A cart that does not contain the attacker's variant at all.
    built.cart.seedCart(user.id, "variant-1", 1);
    const { service, orders } = built;

    await expectCodeError(service.placeOrder(user, tamperedBody()), "LINE_UNAVAILABLE", 409);
    expect(orders.createCalls).toHaveLength(0);
  });
});

describe("OrderService.listOrders", () => {
  it("defaults the page limit and maps records to summary DTOs", async () => {
    const { service, orders } = buildService();
    const user = makeUser();
    const order = {
      id: ORDER_ID,
      customerUserId: user.id,
      status: "pending" as const,
      currency: "USD",
      subtotalAmountCents: 2000,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: 2000,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const item = {
      id: "item-1",
      orderId: ORDER_ID,
      variantId: "variant-1",
      storeId: "store-1",
      productName: "Product",
      variantName: "Variant",
      sku: null,
      quantity: 2,
      unitAmountCents: 1000,
      lineTotalAmountCents: 2000,
      currency: "USD",
      status: "pending" as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    orders.setDetail(user.id, {
      order,
      addresses: [],
      items: [item],
    });
    orders.overrideList(async (customerUserId) => {
      return customerUserId === user.id
        ? { items: [{ order, items: [item] }], nextCursor: null }
        : { items: [], nextCursor: null };
    });
    const page = await service.listOrders(user, undefined);
    expect(page.items).toHaveLength(1);
    const summary = page.items[0] as (typeof page.items)[number];
    expect(summary).toMatchObject({
      id: ORDER_ID,
      totalAmountCents: 2000,
      itemCount: 1,
    });
    // Summary DTOs carry no addresses.
    expect(summary).not.toHaveProperty("addresses");
  });

  it("surfaces a malformed limit as a 422, keeping the default for blank values", async () => {
    const { service } = buildService();
    const user = makeUser();
    await expectCodeError(service.listOrders(user, { limit: "abc" }), "VALIDATION_ERROR", 422);
    const blank = await service.listOrders(user, { limit: "" });
    expect(blank.items).toEqual([]);
  });
});

describe("OrderService.getOrder", () => {
  it("returns the customer-scoped detail with addresses", async () => {
    const { service, orders } = buildService();
    const user = makeUser();
    orders.setDetail(user.id, {
      order: {
        id: ORDER_ID,
        customerUserId: user.id,
        status: "pending",
        currency: "USD",
        subtotalAmountCents: 2000,
        shippingAmountCents: 0,
        discountAmountCents: 0,
        totalAmountCents: 2000,
        createdAt: NOW,
        updatedAt: NOW,
      },
      addresses: [
        {
          id: "a1",
          orderId: ORDER_ID,
          kind: "shipping",
          recipientName: "Ada Lovelace",
          phone: null,
          line1: "1 Analytical Way",
          line2: null,
          city: "London",
          region: null,
          postalCode: null,
          countryCode: "GB",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      items: [],
    });
    const data = await service.getOrder(user, ORDER_ID);
    expect(data.id).toBe(ORDER_ID);
    expect(data.addresses.map((address) => address.kind)).toEqual(["shipping"]);
  });

  it("returns ORDER_NOT_FOUND for another customer's order", async () => {
    const { service, orders } = buildService();
    orders.setDetail(makeUser().id, {
      order: {
        id: ORDER_ID,
        customerUserId: "owner",
        status: "pending",
        currency: "USD",
        subtotalAmountCents: 0,
        shippingAmountCents: 0,
        discountAmountCents: 0,
        totalAmountCents: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      addresses: [],
      items: [],
    });
    const user = makeUser(); // a different customer than the seeded order's owner
    await expectCodeError(service.getOrder(user, ORDER_ID), "ORDER_NOT_FOUND", 404);
  });

  it("treats a malformed order id as not found", async () => {
    const { service } = buildService();
    await expectCodeError(service.getOrder(makeUser(), "nope"), "NOT_FOUND", 404);
  });
});