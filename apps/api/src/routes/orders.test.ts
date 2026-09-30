import { beforeEach, describe, expect, it } from "vitest";
import { PBKDF2PasswordHasher, type AppConfig, type PasswordHasher } from "@zelora/core";
import type { AuthSessionRecord, AuthSessionRepository, CreateAuthSessionInput } from "@zelora/db/auth";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { UserRecord, UserRepository, CreateAdminResult, CreateUserInput } from "@zelora/db/users";
import type { SellerRepository } from "@zelora/db/seller";
import type { CatalogRepository, SellableVariantRecord } from "@zelora/db/catalog";
import type { ProductRepository } from "@zelora/db/products";
import type { CartRepository, CartRecord, CartItemRecord, CartWithItemsRecord, CreateCartResult, AddCartItemInput, AddCartItemResult } from "@zelora/db/cart";
import type {
  CreateOrderAddressInput,
  CreateOrderConflictReason,
  CreateOrderInput,
  CreateOrderLineInput,
  CreateOrderResult,
  OrderAddressRecord,
  OrderItemRecord,
  OrderListPage,
  OrderRecord,
  OrderRepository,
  OrderWithDetailsRecord,
} from "@zelora/db/orders";
import { createId } from "@zelora/db/ids";
import type {
  ApiFailure,
  AuthUserResponse,
  OrderDetailDto,
  OrderListData,
} from "@zelora/shared";
import { createApp } from "../app";
import type { Clock } from "../services/clock";
import type { ClientIpResolver } from "../services/client-ip";
import { MemoryWindowRateLimiter } from "../services/rate-limit";

/**
 * End-to-end route tests for the customer order surface through the real
 * composed app (auth middleware + CSRF + handler + service + rate limiter),
 * with the cart, catalog and order repositories faked at the composition
 * boundary. These prove the routes are session-auth + CSRF protected, hit the
 * dedicated `order-place` IP budget before the handler, scope every read to
 * the caller, and return the shared order envelopes.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");

/**
 * The client-generated idempotency key every checkout POST carries by default.
 *
 * Each test gets a fresh repository fake, so one shared value is enough; the
 * header-contract tests pass `idempotencyKey` explicitly to vary it.
 */
const CHECKOUT_KEY = "checkout-key-0001";

class FakeClock implements Clock {
  now(): Date {
    return new Date(NOW.getTime());
  }
}

class FakeUserRepository implements UserRepository {
  private users: Map<string, UserRecord> = new Map();
  private usersByEmail: Map<string, UserRecord> = new Map();
  private nextId = 1;

  async create(input: {
    email: string;
    name: string;
    passwordHash: string;
    role?: UserRecord["role"];
  }): Promise<UserRecord> {
    const record: UserRecord = {
      id: `user-${this.nextId++}`,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? "customer",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.users.set(record.id, record);
    this.usersByEmail.set(record.email, record);
    return record;
  }

  async createAdmin(input: CreateUserInput): Promise<CreateAdminResult> {
    return { ok: true, user: await this.create(input) };
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.usersByEmail.get(email) ?? null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  setUser(record: UserRecord): void {
    this.users.set(record.id, record);
    this.usersByEmail.set(record.email, record);
  }
}

class FakeAuthSessionRepository implements AuthSessionRepository {
  private sessions: Map<string, AuthSessionRecord> = new Map();
  private nextId = 1;

  async create(input: CreateAuthSessionInput): Promise<AuthSessionRecord> {
    const record: AuthSessionRecord = {
      id: `session-${this.nextId++}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      csrfToken: input.csrfToken,
      expiresAt: input.expiresAt,
      createdAt: NOW,
      lastUsedAt: null,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    for (const session of this.sessions.values()) {
      if (session.tokenHash === tokenHash) {
        return session;
      }
    }
    return null;
  }

  async deleteById(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async deleteAllForUser(userId: string): Promise<number> {
    let count = 0;
    for (const [id, session] of Array.from(this.sessions.entries())) {
      if (session.userId === userId) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  async updateLastUsedAt(id: string, _lastUsedAt: Date): Promise<boolean> {
    return this.sessions.has(id);
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    let count = 0;
    for (const [id, session] of Array.from(this.sessions.entries())) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  getSessionsForUser(userId: string): AuthSessionRecord[] {
    return Array.from(this.sessions.values()).filter((session) => session.userId === userId);
  }
}

class FakeCartRepository implements CartRepository {
  private cartsByUser: Map<string, string> = new Map();
  private carts: Map<string, CartRecord> = new Map();
  private items: Map<string, CartItemRecord> = new Map();
  private cartSeq = 0;

  async seedCart(userId: string, lines: Array<{ variantId: string; quantity: number }>): Promise<void> {
    const result = await this.createCart(userId);
    if (!result.ok) {
      throw new Error("seed cart already exists");
    }
    for (const line of lines) {
      const added = await this.addItem({
        cartId: result.cart.id,
        variantId: line.variantId,
        quantity: line.quantity,
      });
      if (!added.ok) {
        throw new Error("seed cart item conflict");
      }
    }
  }

  async getCartByUserId(userId: string): Promise<CartWithItemsRecord | null> {
    const cartId = this.cartsByUser.get(userId);
    if (cartId === undefined) {
      return null;
    }
    const cart = this.carts.get(cartId);
    if (cart === undefined) {
      return null;
    }
    const items = Array.from(this.items.values())
      .filter((item) => item.cartId === cartId)
      .sort((a, b) => (a.createdAt > b.createdAt ? 1 : a.id > b.id ? 1 : -1));
    return { cart, items };
  }

  async createCart(userId: string): Promise<CreateCartResult> {
    const existing = this.cartsByUser.get(userId);
    if (existing !== undefined) {
      return { ok: false, reason: "CART_EXISTS" };
    }
    const id = `cart-${++this.cartSeq}`;
    const cart: CartRecord = { id, userId, createdAt: NOW, updatedAt: NOW };
    this.carts.set(id, cart);
    this.cartsByUser.set(userId, id);
    return { ok: true, cart };
  }

  async addItem(input: AddCartItemInput): Promise<AddCartItemResult> {
    const duplicate = Array.from(this.items.values()).some(
      (item) => item.cartId === input.cartId && item.variantId === input.variantId,
    );
    if (duplicate) {
      return { ok: false, reason: "CART_ITEM_EXISTS" };
    }
    const item: CartItemRecord = {
      id: createId(),
      cartId: input.cartId,
      variantId: input.variantId,
      quantity: input.quantity,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.items.set(item.id, item);
    return { ok: true as const, item };
  }

  async updateItemQuantity(cartId: string, itemId: string, quantity: number): Promise<CartItemRecord | null> {
    const item = this.items.get(itemId);
    if (item === undefined || item.cartId !== cartId) {
      return null;
    }
    const updated: CartItemRecord = { ...item, quantity, updatedAt: NOW };
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
    let removed = 0;
    for (const [id, item] of Array.from(this.items.entries())) {
      if (item.cartId === cartId) {
        this.items.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

class FakeCatalogRepository implements CatalogRepository {
  private sellableVariants: Map<string, SellableVariantRecord> = new Map();

  seedSellable(overrides: Partial<SellableVariantRecord> & { id: string }): SellableVariantRecord {
    const { id, ...rest } = overrides;
    const record: SellableVariantRecord = {
      id,
      name: "12ft Box Trailer",
      sku: "TRAILER-12",
      priceAmountCents: 1_250,
      currency: "USD",
      productId: "p-1",
      productName: "Box Trailer",
      storeId: "s-1",
      availableQuantity: 10,
      ...rest,
    };
    this.sellableVariants.set(record.id, record);
    return record;
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

  async listSellableVariantsByIds(ids: string[]): Promise<SellableVariantRecord[]> {
    return ids
      .map((id) => this.sellableVariants.get(id))
      .filter((record): record is SellableVariantRecord =>
        record !== undefined && record.availableQuantity > 0,
      );
  }

  async findActiveStoreBySlug() {
    return null;
  }

  async listStoreProducts() {
    return { items: [], nextCursor: null };
  }
}

class FakeOrderRepository implements OrderRepository {
  private orders: Map<string, OrderWithDetailsRecord> = new Map();
  private ordersByKey: Map<string, OrderWithDetailsRecord> = new Map();
  private recordsByUser: Map<string, OrderWithDetailsRecord[]> = new Map();

  createCalls: CreateOrderInput[] = [];
  forceConflict: CreateOrderConflictReason | null = null;
  /**
   * Stands in for the cart emptying the real order repository performs inside
   * the same transaction/batch as the order write: it runs on commit only, so a
   * conflict above leaves the cart exactly as the shopper left it.
   */
  onCommit: ((clearCartId: string | null) => Promise<void>) | null = null;

  seed(
    customerUserId: string,
    opts: { itemCount?: number; createdAt?: Date; totalAmountCents?: number } = {},
  ): string {
    const createdAt = opts.createdAt ?? NOW;
    const id = createId();
    const items: OrderItemRecord[] = Array.from({ length: opts.itemCount ?? 1 }, () => ({
      id: createId(),
      orderId: id,
      variantId: createId(),
      storeId: "s-1",
      productName: "Box Trailer",
      variantName: "12ft Box Trailer",
      sku: "TRAILER-12",
      quantity: 2,
      unitAmountCents: 1_250,
      lineTotalAmountCents: 2_500,
      currency: "USD",
      status: "confirmed",
      createdAt,
      updatedAt: createdAt,
    }));
    const order: OrderRecord = {
      id,
      customerUserId,
      // Seeded rows stand in for orders placed earlier; they are only ever
      // read back, never replayed, so the key is a stand-in value.
      idempotencyKey: `seeded-${id}`,
      idempotencyFingerprint: "a".repeat(64),
      status: "pending",
      currency: "USD",
      subtotalAmountCents: opts.totalAmountCents ?? 2_500,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: opts.totalAmountCents ?? 2_500,
      createdAt,
      updatedAt: createdAt,
    };
    const addresses: OrderAddressRecord[] = [
      {
        id: createId(),
        orderId: id,
        kind: "shipping",
        recipientName: "Ada Lovelace",
        phone: "+44 20 7946 0958",
        line1: "1 Analytical Engine Parade",
        line2: null,
        city: "London",
        region: "Greater London",
        postalCode: "SW1A 1AA",
        countryCode: "GB",
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: createId(),
        orderId: id,
        kind: "billing",
        recipientName: "Ada Lovelace",
        phone: "+44 20 7946 0958",
        line1: "1 Analytical Engine Parade",
        line2: null,
        city: "London",
        region: "Greater London",
        postalCode: "SW1A 1AA",
        countryCode: "GB",
        createdAt,
        updatedAt: createdAt,
      },
    ];
    const record: OrderWithDetailsRecord = { order, addresses, items };
    this.orders.set(record.order.id, record);
    const list = this.recordsByUser.get(customerUserId) ?? [];
    list.push(record);
    this.recordsByUser.set(customerUserId, list);
    return record.order.id;
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    this.createCalls.push(input);
    if (this.forceConflict !== null) {
      return { ok: false, reason: this.forceConflict };
    }
    const id = createId();
    const createdAt = NOW;
    const order: OrderRecord = {
      id,
      customerUserId: input.customerUserId,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: input.idempotencyFingerprint,
      status: "pending",
      currency: input.currency,
      subtotalAmountCents: input.subtotalAmountCents,
      shippingAmountCents: input.shippingAmountCents,
      discountAmountCents: input.discountAmountCents,
      totalAmountCents: input.totalAmountCents,
      createdAt,
      updatedAt: createdAt,
    };
    const addresses: OrderAddressRecord[] = input.addresses.map((address) =>
      toAddressRecord(address, id, createdAt),
    );
    const items: OrderItemRecord[] = input.lines.map((line) =>
      toItemRecord(line, id, createdAt),
    );
    const record: OrderWithDetailsRecord = { order, addresses, items };
    this.orders.set(record.order.id, record);
    // Mirrors the schema's unique (customer_user_id, idempotency_key) index: the
    // key is what a retry looks the order up by.
    this.ordersByKey.set(`${input.customerUserId}\u0000${input.idempotencyKey}`, record);
    const list = this.recordsByUser.get(input.customerUserId) ?? [];
    list.push(record);
    this.recordsByUser.set(input.customerUserId, list);
    await this.onCommit?.(input.clearCartId);
    return { ok: true, order, addresses, items };
  }

  async findByIdempotencyKeyForCustomer(
    customerUserId: string,
    idempotencyKey: string,
  ): Promise<OrderWithDetailsRecord | null> {
    return this.ordersByKey.get(`${customerUserId}\u0000${idempotencyKey}`) ?? null;
  }

  async findByIdForCustomer(customerUserId: string, orderId: string): Promise<OrderWithDetailsRecord | null> {
    const record = this.orders.get(orderId);
    if (record === undefined || record.order.customerUserId !== customerUserId) {
      return null;
    }
    return record;
  }

  async listByCustomer(customerUserId: string, opts: { limit: number; cursor: string | null }): Promise<OrderListPage> {
    const list = this.recordsByUser.get(customerUserId) ?? [];
    const sorted = [...list].sort((a, b) => {
      if (a.order.createdAt < b.order.createdAt) return 1;
      if (a.order.createdAt > b.order.createdAt) return -1;
      if (a.order.id < b.order.id) return 1;
      if (a.order.id > b.order.id) return -1;
      return 0;
    });
    let start = 0;
    if (opts.cursor !== null) {
      const found = sorted.findIndex(
        (record) => encodeCursor(record.order) === opts.cursor,
      );
      start = found >= 0 ? found + 1 : sorted.length;
    }
    const page = sorted.slice(start, start + opts.limit);
    const hasMore = start + opts.limit < sorted.length;
    return {
      items: page.map((record) => ({ order: record.order, items: record.items })),
      nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.order) : null,
    };
  }
}

function encodeCursor(order: OrderRecord): string {
  return `${order.createdAt.getTime()}:${order.id}`;
}

function toAddressRecord(address: CreateOrderAddressInput, orderId: string, createdAt: Date): OrderAddressRecord {
  return {
    id: createId(),
    orderId,
    kind: address.kind,
    recipientName: address.recipientName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    createdAt,
    updatedAt: createdAt,
  };
}

function toItemRecord(line: CreateOrderLineInput, orderId: string, createdAt: Date): OrderItemRecord {
  return {
    id: createId(),
    orderId,
    variantId: line.variantId,
    storeId: line.storeId,
    productName: line.productName,
    variantName: line.variantName,
    sku: line.sku,
    quantity: line.quantity,
    unitAmountCents: line.unitAmountCents,
    lineTotalAmountCents: line.lineTotalAmountCents,
    currency: line.currency,
    status: "confirmed",
    createdAt,
    updatedAt: createdAt,
  };
}

const inert = (): never => {
  throw new Error("unexpected dependency call");
};

describe("orders routes", () => {
  const baseConfig: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3001,
    appVersion: "0.1.0",
    corsOrigin: "http://localhost:5173",
    sessionCookieName: "zelora_session",
    sessionTtlSeconds: 2_592_000,
    sessionCookieSecure: false,
    pbkdf2Iterations: 1_000,
    rateLimitEnabled: true,
    rateLimitTrustProxy: false,
    rateLimitLoginIpMax: 20,
    rateLimitLoginIpWindowSeconds: 900,
    rateLimitLoginEmailMax: 10,
    rateLimitLoginEmailWindowSeconds: 900,
    rateLimitRegisterIpMax: 10,
    rateLimitRegisterIpWindowSeconds: 3_600,
    rateLimitSellerOnboardingIpMax: 10,
    rateLimitSellerOnboardingIpWindowSeconds: 3_600,
    rateLimitProductCreateIpMax: 30,
    rateLimitProductCreateIpWindowSeconds: 3_600,
    rateLimitOrderPlaceIpMax: 20,
    rateLimitOrderPlaceIpWindowSeconds: 3_600,
    sessionLastUsedThrottleSeconds: 300,
    sessionPurgeIntervalSeconds: 3_600,
    adminBootstrapSecret: null,
    mediaPublicBaseUrl: null,
    mediaLocalRoot: ".data/media",
  };

  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let cartRepository: FakeCartRepository;
  let catalogRepository: FakeCatalogRepository;
  let orderRepository: FakeOrderRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();
    cartRepository = new FakeCartRepository();
    catalogRepository = new FakeCatalogRepository();
    orderRepository = new FakeOrderRepository();
    orderRepository.onCommit = async (clearCartId) => {
      if (clearCartId !== null) {
        await cartRepository.clearCart(clearCartId);
      }
    };
    app = createApp({
      config: baseConfig,
      userRepository,
      sessionRepository,
      sellerRepository: {
        findByUserId: inert,
        findByProfileSlug: inert,
        findStoreBySlug: inert,
        findStoreBySellerProfileId: inert,
        createOnboarding: inert,
        activateSeller: inert,
        listPendingProfiles: inert,
        rejectSeller: inert,
      } satisfies SellerRepository,
      catalogRepository,
      productRepository: {
        listByStore: inert,
        findByStoreAndId: inert,
        listImagesByProduct: inert,
        findByStoreAndSlug: inert,
        createProduct: inert,
        createVariant: inert,
        setInventory: inert,
        publishProduct: inert,
        addProductImages: inert,
        countImagesByProduct: inert,
        deleteProductImage: inert,
        setPrimaryProductImage: inert,
        reorderProductImages: inert,
      } satisfies ProductRepository,
      cartRepository,
      orderRepository,
      auditLogRepository: {
        create: inert,
        listByAction: inert,
      } satisfies AuditLogRepository,
      passwordHasher: new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations) as PasswordHasher,
      clock: new FakeClock(),
    });
  });

  /**
   * Checkout requires an `Idempotency-Key`, so every POST here carries one by
   * default; `opts.headers` can still override it to test the header contract.
   */
  function method(
    method: "GET" | "POST",
    path: string,
    opts: { cookie?: string; csrfToken?: string; body?: unknown; headers?: Record<string, string>; idempotencyKey?: string | null } = {},
  ): Promise<Response> {
    const idempotencyKey = opts.idempotencyKey === undefined ? CHECKOUT_KEY : opts.idempotencyKey;
    return app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(idempotencyKey === null ? {} : { "Idempotency-Key": idempotencyKey }),
        ...(opts.cookie === undefined ? {} : { Cookie: opts.cookie }),
        ...(opts.csrfToken === undefined ? {} : { "X-Zelora-CSRF": opts.csrfToken }),
        ...(opts.headers ?? {}),
      },
      body: method === "POST" ? JSON.stringify(opts.body) : undefined,
    }) as Promise<Response>;
  }

  function extractSessionCookie(response: Response): string {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie === null) {
      throw new Error("expected a set-cookie header");
    }
    return setCookie.split(";")[0] ?? "";
  }

  async function registerSession(
    email = "orders@example.com",
  ): Promise<{ cookie: string; csrfToken: string; userId: string }> {
    const response = await method("POST", "/api/auth/register", {
      body: { email, password: "password123", name: "Order Customer" },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: AuthUserResponse };
    return {
      cookie: extractSessionCookie(response),
      csrfToken: body.data.session.csrfToken,
      userId: body.data.user.id,
    };
  }

  async function expectFailure(response: Response, code: string, status: number): Promise<ApiFailure> {
    expect(response.status).toBe(status);
    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(code);
    return body;
  }

  const validShipping = {
    recipientName: "Ada Lovelace",
    phone: "+44 20 7946 0958",
    line1: "1 Analytical Engine Parade",
    line2: "Floor 2",
    city: "London",
    region: "Greater London",
    postalCode: "SW1A 1AA",
    countryCode: "GB",
  };

  const validBilling = {
    recipientName: "Ada Lovelace",
    phone: "+44 20 7946 0958",
    line1: "221B Billing Street",
    city: "Cambridge",
    countryCode: "GB",
  };

  it("A: reads and writes without a session return 401 and nothing is created", async () => {
    catalogRepository.seedSellable({ id: "variant-1" });
    await cartRepository.seedCart("any-user", [{ variantId: "variant-1", quantity: 1 }]);

    const reads = await Promise.all([
      method("GET", "/api/orders"),
      method("GET", "/api/orders/some-order"),
    ]);
    for (const response of reads) {
      await expectFailure(response, "SESSION_EXPIRED", 401);
    }

    const write = await method("POST", "/api/orders", {
      body: { shippingAddress: validShipping },
    });
    await expectFailure(write, "SESSION_EXPIRED", 401);
    expect(orderRepository.createCalls).toHaveLength(0);
  });

  it("B: POST /api/orders without CSRF is rejected with 403 and nothing is created", async () => {
    const { cookie } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1" });
    await cartRepository.seedCart("user-1", [{ variantId: "variant-1", quantity: 1 }]);

    const response = await method("POST", "/api/orders", {
      cookie,
      body: { shippingAddress: validShipping },
    });

    await expectFailure(response, "CSRF_FAILED", 403);
    expect(orderRepository.createCalls).toHaveLength(0);
  });

  it("B: a valid checkout re-prices the cart, writes both address snapshots, and clears the cart", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1" });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 2 }]);

    const response = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: OrderDetailDto };
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      status: "pending",
      currency: "USD",
      subtotalAmountCents: 2_500,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: 2_500,
      itemCount: 1,
    });
    expect(body.data.items).toMatchObject([{
      variantId: "variant-1",
      storeId: "s-1",
      productName: "Box Trailer",
      variantName: "12ft Box Trailer",
      quantity: 2,
      unitAmountCents: 1_250,
      lineTotalAmountCents: 2_500,
      currency: "USD",
      status: "confirmed",
    }]);
    expect(body.data.addresses.map((address) => address.kind)).toEqual(["shipping", "billing"]);
    expect(body.data.addresses[0]).toMatchObject(validShipping);
    expect(body.data.addresses[1]).toMatchObject(validShipping);

    const cart = await cartRepository.getCartByUserId(userId);
    expect(cart).not.toBeNull();
    expect(cart!.items).toHaveLength(0);
  });

  it("B: an explicit billing address is snapshotted distinctly from shipping", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1" });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 1 }]);

    const response = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping, billingAddress: validBilling },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: OrderDetailDto };
    expect(body.data.addresses[0]).toMatchObject(validShipping);
    expect(body.data.addresses[1]).toMatchObject(validBilling);
    expect(orderRepository.createCalls[0]!.addresses.map((address) => address.kind)).toEqual([
      "shipping",
      "billing",
    ]);
  });

  it("B: an empty cart is refused with 409 CART_EMPTY", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    await cartRepository.seedCart(userId, []);

    const response = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping },
    });

    await expectFailure(response, "CART_EMPTY", 409);
    expect(orderRepository.createCalls).toHaveLength(0);
  });

  it("B: a cart line whose variant is not sellable is refused with 409 LINE_UNAVAILABLE", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    await cartRepository.seedCart(userId, [{ variantId: "gone-variant", quantity: 1 }]);

    const response = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping },
    });

    await expectFailure(response, "LINE_UNAVAILABLE", 409);
  });

  it("B: insufficient live stock is refused with 409 STOCK_CHANGED", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1", priceAmountCents: 1_000, availableQuantity: 1 });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 5 }]);

    const response = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping },
    });

    await expectFailure(response, "STOCK_CHANGED", 409);
  });

  it("B: a repository conflict maps to the customer-facing code on a 409", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1", availableQuantity: 100 });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 1 }]);
    orderRepository.forceConflict = "INSUFFICIENT_STOCK";

    const response = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping },
    });

    await expectFailure(response, "STOCK_CHANGED", 409);
  });

  it("B: a failed checkout leaves the cart intact and no order behind", async () => {
    // Z-05: the cart is emptied by the same write that creates the order, so a
    // refused checkout is a no-op on the shopper's cart as well as on the
    // database. Emptied outside that write, a conflict would still leave the
    // cart here — the shopper would see it gone and unable to retry.
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1", availableQuantity: 100 });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 2 }]);
    orderRepository.forceConflict = "INSUFFICIENT_STOCK";

    const response = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping },
    });

    await expectFailure(response, "STOCK_CHANGED", 409);
    const cart = await cartRepository.getCartByUserId(userId);
    expect(cart!.items).toMatchObject([{ variantId: "variant-1", quantity: 2 }]);

    // The same key is still usable: the retry is a real checkout that empties
    // the cart exactly once.
    orderRepository.forceConflict = null;
    const retry = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping },
    });
    expect(retry.status).toBe(201);
    expect((await cartRepository.getCartByUserId(userId))!.items).toHaveLength(0);
    expect(orderRepository.createCalls).toHaveLength(2);
  });

  it("B: an invalid address is refused with a 422 validation envelope naming the field", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 1 }]);

    const response = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: {
        shippingAddress: { ...validShipping, countryCode: "GBR" },
      },
    });

    const body = await expectFailure(response, "VALIDATION_ERROR", 422);
    expect(body.error.fields?.["shippingAddress.countryCode"]).toBeDefined();
  });

  it("C: GET /api/orders lists only the caller's orders, newest first, without addresses", async () => {
    const { cookie, userId } = await registerSession();
    const other = await registerSession("other@example.com");
    orderRepository.seed(userId, { createdAt: new Date("2026-01-03T00:00:00.000Z"), itemCount: 2 });
    orderRepository.seed(userId, { createdAt: new Date("2026-01-02T00:00:00.000Z"), itemCount: 1 });
    orderRepository.seed(other.userId, { createdAt: new Date("2026-01-04T00:00:00.000Z") });

    const response = await method("GET", "/api/orders", { cookie });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: OrderListData };
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.nextCursor).toBeNull();
    expect(body.data.items[0]!.itemCount).toBe(2);
    expect(body.data.items[1]!.itemCount).toBe(1);
    expect(body.data.items[0]!.id).not.toBe(body.data.items[1]!.id);

    const leaked = await method("GET", "/api/orders", { cookie });
    const raw = await leaked.text();
    expect(raw).not.toContain('"addresses"');
  });

  it("C: a malformed list limit is refused with 422 and the default page limit applies when absent", async () => {
    const { cookie, userId } = await registerSession();
    orderRepository.seed(userId, {});

    const malformed = await method("GET", "/api/orders?limit=abc", { cookie });
    await expectFailure(malformed, "VALIDATION_ERROR", 422);

    const defaulted = await method("GET", "/api/orders", { cookie });
    expect(defaulted.status).toBe(200);
    const body = (await defaulted.json()) as { ok: true; data: OrderListData };
    expect(body.data.items).toHaveLength(1);
  });

  it("C: a keyset cursor continues to the next page, newest first", async () => {
    const { cookie, userId } = await registerSession();
    const newest = orderRepository.seed(userId, {
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      totalAmountCents: 3_000,
    });
    const oldest = orderRepository.seed(userId, {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      totalAmountCents: 1_500,
    });

    const first = await method("GET", "/api/orders?limit=1", { cookie });
    const firstBody = (await first.json()) as { ok: true; data: OrderListData };
    expect(firstBody.data.items).toHaveLength(1);
    expect(firstBody.data.items[0]!.id).toBe(newest);
    expect(firstBody.data.nextCursor).not.toBeNull();

    const second = await method("GET", `/api/orders?limit=1&cursor=${firstBody.data.nextCursor}`, { cookie });
    const secondBody = (await second.json()) as { ok: true; data: OrderListData };
    expect(secondBody.data.items).toHaveLength(1);
    expect(secondBody.data.items[0]!.id).toBe(oldest);
    expect(secondBody.data.nextCursor).toBeNull();
  });

  it("D: GET /api/orders/:orderId returns the caller's order detail with addresses", async () => {
    const { cookie, userId } = await registerSession();
    const orderId = orderRepository.seed(userId, { itemCount: 1 });

    const response = await method("GET", `/api/orders/${orderId}`, { cookie });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: OrderDetailDto };
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe(orderId);
    expect(body.data.itemCount).toBe(1);
    expect(body.data.addresses.map((address) => address.kind)).toEqual(["shipping", "billing"]);
  });

  it("D: another customer's order id surfaces as 404 ORDER_NOT_FOUND", async () => {
    const { userId } = await registerSession();
    const other = await registerSession("other@example.com");
    const orderId = orderRepository.seed(userId, {});

    const response = await method("GET", `/api/orders/${orderId}`, { cookie: other.cookie });

    await expectFailure(response, "ORDER_NOT_FOUND", 404);
  });

  it("D: a malformed order id surfaces as 404 NOT_FOUND", async () => {
    const { cookie } = await registerSession();

    const response = await method("GET", "/api/orders/not-an-id", { cookie });

    await expectFailure(response, "NOT_FOUND", 404);
  });

  it("E: checkout consumes the per-IP order-place budget and 429s the next request", async () => {
    const limiter = new MemoryWindowRateLimiter(new FakeClock());
    const headerIpResolver: ClientIpResolver = {
      resolve: (c) => c.req.header("X-Test-IP"),
    };
    const limitedApp = createApp({
      config: { ...baseConfig, rateLimitOrderPlaceIpMax: 2 },
      userRepository,
      sessionRepository,
      sellerRepository: {
        findByUserId: inert,
        findByProfileSlug: inert,
        findStoreBySlug: inert,
        findStoreBySellerProfileId: inert,
        createOnboarding: inert,
        activateSeller: inert,
        listPendingProfiles: inert,
        rejectSeller: inert,
      } satisfies SellerRepository,
      catalogRepository,
      productRepository: {
        listByStore: inert,
        findByStoreAndId: inert,
        listImagesByProduct: inert,
        findByStoreAndSlug: inert,
        createProduct: inert,
        createVariant: inert,
        setInventory: inert,
        publishProduct: inert,
        addProductImages: inert,
        countImagesByProduct: inert,
        deleteProductImage: inert,
        setPrimaryProductImage: inert,
        reorderProductImages: inert,
      } satisfies ProductRepository,
      cartRepository,
      orderRepository,
      auditLogRepository: {
        create: inert,
        listByAction: inert,
      } satisfies AuditLogRepository,
      passwordHasher: new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations) as PasswordHasher,
      clock: new FakeClock(),
      rateLimiter: limiter,
      clientIpResolver: headerIpResolver,
    });

    const register = await limitedApp.request("/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-IP": "203.0.113.50",
      },
      body: JSON.stringify({
        email: "limited@example.com",
        password: "password123",
        name: "Limited Customer",
      }),
    });
    const registerBody = (await register.json()) as { ok: true; data: AuthUserResponse };
    const cookie = extractSessionCookie(register);
    const csrfToken = registerBody.data.session.csrfToken;

    let rateLimitAttempt = 0;
    const post = (): Promise<Response> =>
      limitedApp.request("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Test-IP": "203.0.113.50",
          // A distinct key per attempt: the rate-limit budget, not idempotency,
          // is what must stop the third of these.
          "Idempotency-Key": `rate-limit-key-${rateLimitAttempt++}`,
          Cookie: cookie,
          "X-Zelora-CSRF": csrfToken,
        },
        body: JSON.stringify({ shippingAddress: validShipping }),
      }) as Promise<Response>;

    expect((await post()).status).not.toBe(429);
    expect((await post()).status).not.toBe(429);
    const blocked = await post();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("3600");
    const body = (await blocked.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.details).toEqual({ retryAfterSeconds: 3600, scope: "ip" });
  });

  it("B: a tampered checkout body cannot influence the persisted totals, lines, currency or owner", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1", priceAmountCents: 1_250, currency: "USD" });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 2 }]);

    // Every extra key is a lie: a zero total, a foreign currency, an injected
    // line for a variant the cart does not own, a spoofed owner/status.
    const response = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: {
        shippingAddress: validShipping,
        totalAmountCents: 1,
        subtotalAmountCents: 1,
        shippingAmountCents: 999_999,
        discountAmountCents: 999_999,
        currency: "EUR",
        customerUserId: "00000000-0000-7000-8000-00000000dead",
        status: "completed",
        items: [
          {
            variantId: "attacker-variant",
            quantity: 99,
            unitAmountCents: 1,
            lineTotalAmountCents: 1,
            priceAmountCents: 1,
            currency: "EUR",
          },
        ],
      },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; data: OrderDetailDto };
    expect(body.data).toMatchObject({
      status: "pending",
      currency: "USD",
      subtotalAmountCents: 2_500,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      totalAmountCents: 2_500,
      itemCount: 1,
    });
    expect(body.data.items).toMatchObject([{
      variantId: "variant-1",
      quantity: 2,
      unitAmountCents: 1_250,
      lineTotalAmountCents: 2_500,
      currency: "USD",
    }]);

    const persisted = orderRepository.createCalls[0]!;
    expect(persisted.customerUserId).toBe(userId);
    expect(persisted.currency).toBe("USD");
    expect(persisted.totalAmountCents).toBe(2_500);
    expect(persisted.subtotalAmountCents).toBe(2_500);
    expect(persisted.shippingAmountCents).toBe(0);
    expect(persisted.discountAmountCents).toBe(0);
    expect(persisted.lines).toHaveLength(1);
    expect(persisted.lines[0]).toMatchObject({
      variantId: "variant-1",
      quantity: 2,
      unitAmountCents: 1_250,
      lineTotalAmountCents: 2_500,
      currency: "USD",
    });
    expect(persisted.addresses.map((address) => address.kind)).toEqual(["shipping", "billing"]);
  });

/**
 * The `Idempotency-Key` header contract.
 *
 * Checkout is a money-moving write that browsers and proxies retry on their own,
 * so the header is what makes a repeat safe. These tests pin the wire behaviour:
 * the key is required, it is validated, it reaches the write, and a repeat or a
 * reuse of it produces the documented answer.
 */
describe("POST /api/orders Idempotency-Key contract", () => {
  it("rejects a checkout with no Idempotency-Key as a 422 and creates nothing", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1" });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 1 }]);

    const response = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      idempotencyKey: null,
      body: { shippingAddress: validShipping },
    });

    // Refusing is the only safe answer: an order placed without a key cannot be
    // recognised as a retry, so the client's next attempt would double-charge.
    const failure = await expectFailure(response, "VALIDATION_ERROR", 422);
    expect(failure.error.fields?.idempotencyKey).toBeDefined();
    expect(orderRepository.createCalls).toHaveLength(0);
    const cart = await cartRepository.getCartByUserId(userId);
    expect(cart?.items).toHaveLength(1);
  });

  it("rejects keys that are too short or carry characters outside the allowed set", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1" });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 1 }]);

    // A NUL byte is deliberately absent here: the fetch layer rejects it before
    // any handler runs, so the pattern test in the validator is where it belongs.
    for (const key of ["short", "a".repeat(65), "has space here", "has/slash/here"]) {
      const response = await method("POST", "/api/orders", {
        cookie,
        csrfToken,
        idempotencyKey: key,
        body: { shippingAddress: validShipping },
      });
      const failure = await expectFailure(response, "VALIDATION_ERROR", 422);
      expect(failure.error.fields?.idempotencyKey).toBeDefined();
    }
    expect(orderRepository.createCalls).toHaveLength(0);
  });

  it("persists the caller's key and a server-computed fingerprint with the order", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1" });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 2 }]);

    await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      idempotencyKey: "order-attempt-2f9c",
      body: { shippingAddress: validShipping },
    });

    const persisted = orderRepository.createCalls[0]!;
    expect(persisted.idempotencyKey).toBe("order-attempt-2f9c");
    expect(persisted.idempotencyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers a repeat of the same request with the original order and one write", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1" });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 2 }]);

    const first = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping },
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: OrderDetailDto };

    // The retry arrives after the first attempt committed and emptied the cart,
    // which is exactly the situation that produces a double charge without a key.
    const retry = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping },
    });

    expect(retry.status).toBe(201);
    const retryBody = (await retry.json()) as { data: OrderDetailDto };
    expect(retryBody.data.id).toBe(firstBody.data.id);
    expect(orderRepository.createCalls).toHaveLength(1);
  });

  it("answers a reused key carrying a different request with a 409 conflict", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedSellable({ id: "variant-1" });
    await cartRepository.seedCart(userId, [{ variantId: "variant-1", quantity: 2 }]);

    await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: validShipping },
    });

    const reused = await method("POST", "/api/orders", {
      cookie,
      csrfToken,
      body: { shippingAddress: { ...validShipping, line1: "99 Different Road" } },
    });

    await expectFailure(reused, "IDEMPOTENCY_CONFLICT", 409);
    expect(orderRepository.createCalls).toHaveLength(1);
  });

  it("advertises the header in CORS so a browser client can send it", async () => {
    const response = await app.request("/api/orders", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-csrf,idempotency-key",
      },
    });

    // Without this the browser strips the key before the request leaves the page,
    // and every checkout fails validation in production only.
    const allowed = response.headers.get("access-control-allow-headers") ?? "";
    expect(allowed.toLowerCase()).toContain("idempotency-key");
  });
});
});
