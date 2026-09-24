import { beforeEach, describe, expect, it } from "vitest";
import { PBKDF2PasswordHasher, type AppConfig, type PasswordHasher } from "@zelora/core";
import type { AuthSessionRecord, AuthSessionRepository, CreateAuthSessionInput } from "@zelora/db/auth";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { UserRecord, UserRepository, CreateAdminResult, CreateUserInput } from "@zelora/db/users";
import type { SellerRepository } from "@zelora/db/seller";
import type { CatalogRepository, CatalogVariantRecord } from "@zelora/db/catalog";
import type { ProductRepository } from "@zelora/db/products";
import type {
  AddCartItemInput,
  AddCartItemResult,
  CartItemRecord,
  CartRecord,
  CartRepository,
  CartWithItemsRecord,
  CreateCartResult,
} from "@zelora/db/cart";
import { createId } from "@zelora/db/ids";
import type { ApiFailure, AuthUserResponse } from "@zelora/shared";
import { createApp } from "../app";
import type { Clock } from "../services/clock";

/**
 * End-to-end route tests for the cart through the real composed app (auth
 * middleware + CSRF + handler + service), with the cart and catalog
 * repositories faked at the composition boundary. These prove the routes are
 * session-auth + CSRF protected, respect ownership, and return the shared
 * {@link CartEnvelope} after every operation.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");

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

  addItemCalls: Array<{ cartId: string; variantId: string; quantity: number }> = [];

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
    this.addItemCalls.push(input);
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
    return { ok: true, item };
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
  private variants: Map<string, CatalogVariantRecord> = new Map();

  seedVariant(id: string): void {
    this.variants.set(id, {
      id,
      name: "Variant",
      sku: null,
      priceAmountCents: 1_000,
      compareAtAmountCents: null,
      currency: "USD",
    });
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

  async findVariantById(id: string): Promise<CatalogVariantRecord | null> {
    return this.variants.get(id) ?? null;
  }

  async findActiveStoreBySlug() {
    return null;
  }

  async listStoreProducts() {
    return { items: [], nextCursor: null };
  }
}

const inert = (): never => {
  throw new Error("unexpected dependency call");
};

describe("cart routes", () => {
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
    sessionLastUsedThrottleSeconds: 300,
    sessionPurgeIntervalSeconds: 3_600,
    adminBootstrapSecret: null,
  };

  let userRepository: FakeUserRepository;
  let sessionRepository: FakeAuthSessionRepository;
  let cartRepository: FakeCartRepository;
  let catalogRepository: FakeCatalogRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    userRepository = new FakeUserRepository();
    sessionRepository = new FakeAuthSessionRepository();
    cartRepository = new FakeCartRepository();
    catalogRepository = new FakeCatalogRepository();
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
        findByStoreAndSlug: inert,
        createProduct: inert,
      } satisfies ProductRepository,
      cartRepository,
      auditLogRepository: {
        create: inert,
        listByAction: inert,
      } satisfies AuditLogRepository,
      passwordHasher: new PBKDF2PasswordHasher(baseConfig.pbkdf2Iterations) as PasswordHasher,
      clock: new FakeClock(),
    });
  });

  async function requestAs(
    app_0: ReturnType<typeof createApp>,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    return await app_0.request(path, init);
  }

  function method(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { cookie?: string; csrfToken?: string; body?: unknown } = {},
  ): Promise<Response> {
    return requestAs(app, path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.cookie === undefined ? {} : { Cookie: opts.cookie }),
        ...(opts.csrfToken === undefined ? {} : { "X-Zelora-CSRF": opts.csrfToken }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  function extractSessionCookie(response: Response): string {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie === null) {
      throw new Error("expected a set-cookie header");
    }
    return setCookie.split(";")[0] ?? "";
  }

  async function registerSession(
    email = "cart@example.com",
  ): Promise<{ cookie: string; csrfToken: string; userId: string }> {
    const response = await method("POST", "/api/auth/register", {
      body: { email, password: "password123", name: "Cart Customer" },
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

  it("A: unauthenticated reads return 401 and nothing is created", async () => {
    const response = await method("GET", "/api/cart");

    await expectFailure(response, "SESSION_EXPIRED", 401);
    expect(cartRepository.addItemCalls).toHaveLength(0);
  });

  it("B: GET /api/cart lazily creates an empty cart for an authenticated customer", async () => {
    const { cookie } = await registerSession();

    const response = await method("GET", "/api/cart", { cookie });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: { id: string; items: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.items).toEqual([]);
    expect(body.data.id).toMatch(/^cart-/);

    // A second read is stable: the same cart id, still empty.
    const again = await method("GET", "/api/cart", { cookie });
    const againBody = (await again.json()) as { ok: true; data: { id: string; items: unknown[] } };
    expect(againBody.data.id).toBe(body.data.id);
  });

  it("C: mutations without a session are rejected with 401", async () => {
    for (const [method_, path, body] of [
      ["POST", "/api/cart/items", { variantId: "v1", quantity: 1 }],
      ["PATCH", "/api/cart/items/some-id", { quantity: 2 }],
      ["DELETE", "/api/cart/items/some-id", undefined],
      ["DELETE", "/api/cart", undefined],
    ] as Array<["POST" | "PATCH" | "DELETE", string, unknown]>) {
      const response = await method(method_, path, { body });
      await expectFailure(response, "SESSION_EXPIRED", 401);
    }
  });

  it("C: valid CSRF adds a variant and returns 201 with the new line", async () => {
    const { cookie, csrfToken, userId } = await registerSession();
    catalogRepository.seedVariant("variant-1");

    const response = await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "variant-1", quantity: 2 },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: true;
      data: { id: string; items: Array<{ id: string; variantId: string; quantity: number }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]!).toMatchObject({ variantId: "variant-1", quantity: 2 });
    expect(cartRepository.addItemCalls).toEqual([
      { cartId: expect.stringMatching(/^cart-/), variantId: "variant-1", quantity: 2 },
    ]);
    expect(userId).toBeDefined();
  });

  it("C: the cart envelope leaks no internal row columns", async () => {
    const { cookie, csrfToken } = await registerSession();
    catalogRepository.seedVariant("variant-1");

    const response = await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "variant-1", quantity: 1 },
    });

    const raw = await response.text();
    expect(raw).not.toContain("user_id");
    expect(raw).not.toContain("cart_id");
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("csrfToken");
  });

  it("C: missing or wrong CSRF on a mutation returns 403 and nothing changes", async () => {
    const { cookie } = await registerSession();
    catalogRepository.seedVariant("variant-1");

    const missing = await method("POST", "/api/cart/items", {
      cookie,
      body: { variantId: "variant-1", quantity: 1 },
    });
    await expectFailure(missing, "CSRF_FAILED", 403);

    const wrong = await method("POST", "/api/cart/items", {
      cookie,
      csrfToken: "wrong-token",
      body: { variantId: "variant-1", quantity: 1 },
    });
    await expectFailure(wrong, "CSRF_FAILED", 403);

    expect(cartRepository.addItemCalls).toHaveLength(0);
  });

  it("C: adding an already-present variant increments instead of duplicating (200)", async () => {
    const { cookie, csrfToken } = await registerSession();
    catalogRepository.seedVariant("variant-1");
    await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "variant-1", quantity: 2 },
    });

    const response = await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "variant-1", quantity: 3 },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: true;
      data: { items: Array<{ variantId: string; quantity: number }> };
    };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({ variantId: "variant-1", quantity: 5 });
    // The second add raced the UNIQUE and was absorbed as an increment: no new row.
    expect(cartRepository.addItemCalls).toHaveLength(1);
  });

  it("C: adding an unknown variant returns 404 VARIANT_NOT_FOUND", async () => {
    const { cookie, csrfToken } = await registerSession();

    const response = await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "missing-variant", quantity: 1 },
    });

    await expectFailure(response, "VARIANT_NOT_FOUND", 404);
  });

  it("C: malformed add bodies return a 422 validation envelope", async () => {
    const { cookie, csrfToken } = await registerSession();

    for (const [body, field] of [
      [{ variantId: "variant-1", quantity: 0 }, "quantity"],
      [{ variantId: "variant-1", quantity: 100 }, "quantity"],
      [{ variantId: "variant-1", quantity: "3" }, "quantity"],
      [{ quantity: 1 }, "variantId"],
      [{ variantId: "", quantity: 1 }, "variantId"],
    ] as Array<[Record<string, unknown>, string]>) {
      const response = await method("POST", "/api/cart/items", { cookie, csrfToken, body });
      const failure = await expectFailure(response, "VALIDATION_ERROR", 422);
      expect(failure.error.fields?.[field]).toBeDefined();
    }
    expect(cartRepository.addItemCalls).toHaveLength(0);
  });

  it("D: PATCH overwrites the quantity of the caller's own item", async () => {
    const { cookie, csrfToken } = await registerSession();
    catalogRepository.seedVariant("v1");
    const created = await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "v1", quantity: 1 },
    });
    const cart = (await created.json()) as { ok: true; data: { items: Array<{ id: string }> } };
    const itemId = cart.data.items[0]!.id;

    const response = await method("PATCH", `/api/cart/items/${itemId}`, {
      cookie,
      csrfToken,
      body: { quantity: 9 },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: true;
      data: { items: Array<{ id: string; quantity: number }> };
    };
    expect(body.data.items).toEqual([expect.objectContaining({ id: itemId, quantity: 9 })]);
  });

  it("D: PATCH for an item in another user's cart returns 404 CART_ITEM_NOT_FOUND", async () => {
    const owner = await registerSession("owner@example.com");
    const outsider = await registerSession("outsider@example.com");
    catalogRepository.seedVariant("v1");
    const created = await method("POST", "/api/cart/items", {
      cookie: owner.cookie,
      csrfToken: owner.csrfToken,
      body: { variantId: "v1", quantity: 1 },
    });
    const cart = (await created.json()) as { ok: true; data: { items: Array<{ id: string }> } };
    const itemId = cart.data.items[0]!.id;

    const response = await method("PATCH", `/api/cart/items/${itemId}`, {
      cookie: outsider.cookie,
      csrfToken: outsider.csrfToken,
      body: { quantity: 5 },
    });

    await expectFailure(response, "CART_ITEM_NOT_FOUND", 404);
  });

  it("D: PATCH for a malformed or missing item id returns 404", async () => {
    const { cookie, csrfToken } = await registerSession();

    const malformed = await method("PATCH", "/api/cart/items/not-an-id", {
      cookie,
      csrfToken,
      body: { quantity: 2 },
    });
    await expectFailure(malformed, "NOT_FOUND", 404);

    const missing = await method("PATCH", "/api/cart/items/00000000-0000-7000-8000-000000000000", {
      cookie,
      csrfToken,
      body: { quantity: 2 },
    });
    await expectFailure(missing, "CART_ITEM_NOT_FOUND", 404);
  });

  it("E: DELETE removes an item from the caller's cart", async () => {
    const { cookie, csrfToken } = await registerSession();
    catalogRepository.seedVariant("v1");
    const created = await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "v1", quantity: 1 },
    });
    const cart = (await created.json()) as { ok: true; data: { items: Array<{ id: string }> } };
    const itemId = cart.data.items[0]!.id;

    const response = await method("DELETE", `/api/cart/items/${itemId}`, { cookie, csrfToken });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: { items: unknown[] } };
    expect(body.data.items).toEqual([]);

    // Deleting again reports the item as already gone.
    const again = await method("DELETE", `/api/cart/items/${itemId}`, { cookie, csrfToken });
    await expectFailure(again, "CART_ITEM_NOT_FOUND", 404);
  });

  it("E: DELETE of another user's item returns 404", async () => {
    const owner = await registerSession("owner2@example.com");
    const outsider = await registerSession("outsider2@example.com");
    catalogRepository.seedVariant("v1");
    const created = await method("POST", "/api/cart/items", {
      cookie: owner.cookie,
      csrfToken: owner.csrfToken,
      body: { variantId: "v1", quantity: 1 },
    });
    const cart = (await created.json()) as { ok: true; data: { items: Array<{ id: string }> } };
    const itemId = cart.data.items[0]!.id;

    const response = await method("DELETE", `/api/cart/items/${itemId}`, {
      cookie: outsider.cookie,
      csrfToken: outsider.csrfToken,
    });

    await expectFailure(response, "CART_ITEM_NOT_FOUND", 404);
  });

  it("F: DELETE /api/cart clears every line but keeps the cart id", async () => {
    const { cookie, csrfToken } = await registerSession();
    catalogRepository.seedVariant("v1");
    catalogRepository.seedVariant("v2");
    await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "v1", quantity: 1 },
    });
    await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "v2", quantity: 2 },
    });
    const before = await method("GET", "/api/cart", { cookie });
    const beforeBody = (await before.json()) as { ok: true; data: { id: string; items: unknown[] } };
    expect(beforeBody.data.items).toHaveLength(2);

    const response = await method("DELETE", "/api/cart", { cookie, csrfToken });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: { id: string; items: unknown[] } };
    expect(body.data.id).toBe(beforeBody.data.id);
    expect(body.data.items).toEqual([]);
  });

  it("G: incremented quantity is capped at the shared maximum", async () => {
    const { cookie, csrfToken } = await registerSession();
    catalogRepository.seedVariant("v1");
    await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "v1", quantity: 60 },
    });

    const response = await method("POST", "/api/cart/items", {
      cookie,
      csrfToken,
      body: { variantId: "v1", quantity: 60 },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: true;
      data: { items: Array<{ quantity: number }> };
    };
    expect(body.data.items[0]!.quantity).toBe(99);
  });
});