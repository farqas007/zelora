import { describe, expect, it } from "vitest";
import { AppError } from "@zelora/core";
import type { UserRecord } from "@zelora/db/users";
import type { CatalogRepository, CatalogVariantRecord } from "@zelora/db/catalog";
import type {
  AddCartItemResult,
  CartItemRecord,
  CartRecord,
  CartRepository,
  CartWithItemsRecord,
  CreateCartResult,
} from "@zelora/db/cart";
import { CART_ITEM_QUANTITY_LIMITS } from "@zelora/shared";
import { createId } from "@zelora/db/ids";
import { CartService } from "./cart";

/**
 * Service-level tests for the shopping cart. Both repositories are faked so
 * every decision (identity guard, variant existence, lazy create, increment
 * vs. insert, cap, ownership scope, DTO projection) can be asserted without a
 * database.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");

let userSeq = 0;
let cartSeq = 0;

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  userSeq += 1;
  return {
    id: `00000000-0000-7000-8000-${String(userSeq).padStart(12, "0")}`,
    email: `cart-${userSeq}@example.test`,
    name: "Cart Customer",
    role: "customer",
    status: "active",
    passwordHash: "hash",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class FakeCartRepository implements CartRepository {
  private carts: Map<string, CartRecord> = new Map();
  private items: Map<string, CartItemRecord> = new Map();
  private cartByUser: Map<string, string> = new Map();

  addItemCalls: Array<{ cartId: string; variantId: string; quantity: number }> = [];
  /** Simulate the transactional race where a duplicate insert loses the UNIQUE. */
  forceAddItemConflict = false;

  async getCartByUserId(userId: string): Promise<CartWithItemsRecord | null> {
    const cartId = this.cartByUser.get(userId);
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
    const existing = this.cartByUser.get(userId);
    if (existing !== undefined) {
      return { ok: false, reason: "CART_EXISTS" };
    }
    const id = `cart-${cartSeq++}`;
    const cart: CartRecord = { id, userId, createdAt: NOW, updatedAt: NOW };
    this.carts.set(id, cart);
    this.cartByUser.set(userId, id);
    return { ok: true, cart };
  }

  async addItem(input: { cartId: string; variantId: string; quantity: number }): Promise<AddCartItemResult> {
    this.addItemCalls.push(input);
    if (this.forceAddItemConflict) {
      return { ok: false, reason: "CART_ITEM_EXISTS" };
    }
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
    const updated = { ...item, quantity, updatedAt: new Date() };
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
}

function setup(): { service: CartService; cartRepository: FakeCartRepository; catalogRepository: FakeCatalogRepository } {
  const cartRepository = new FakeCartRepository();
  const catalogRepository = new FakeCatalogRepository();
  const service = new CartService({ cartRepository, catalogRepository });
  return { service, cartRepository, catalogRepository };
}

async function expectCodeError(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code} to be thrown`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    expect(appError.statusCode).toBe(status);
  }
}

describe("CartService", () => {
  describe("getCart", () => {
    it("creates a cart lazily and returns it empty", async () => {
      const { service } = setup();
      const user = makeUser();

      const cart = await service.getCart(user);

      expect(cart.id).toMatch(/^cart-/);
      expect(cart.items).toEqual([]);
    });

    it("returns the existing cart and its items", async () => {
      const { service, catalogRepository } = setup();
      const user = makeUser();
      catalogRepository.seedVariant("v1");
      await service.addItem(user, { variantId: "v1", quantity: 2 });

      const cart = await service.getCart(user);

      expect(cart.id).toMatch(/^cart-/);
      expect(cart.items).toHaveLength(1);
      expect(cart.items[0]).toMatchObject({ variantId: "v1", quantity: 2 });
      expect(Object.keys(cart.items[0]!).sort()).toEqual(["id", "quantity", "variantId"]);
    });

    it("rejects suspended and deleted accounts", async () => {
      const { service } = setup();
      await expectCodeError(service.getCart(makeUser({ status: "suspended" })), "ACCOUNT_SUSPENDED", 403);
      await expectCodeError(service.getCart(makeUser({ status: "deleted" })), "ACCOUNT_DELETED", 403);
    });
  });

  describe("addItem", () => {
    it("adds a new variant and reports created", async () => {
      const { service, catalogRepository } = setup();
      const user = makeUser();
      catalogRepository.seedVariant("v1");

const result = await service.addItem(user, { variantId: "v1", quantity: 3 });

      expect(result.created).toBe(true);
      expect(result.data.items).toMatchObject([{ id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), variantId: "v1", quantity: 3 }]);
    });

    it("rejects an unknown variant with VARIANT_NOT_FOUND", async () => {
      const { service } = setup();
      const user = makeUser();
      await expectCodeError(service.addItem(user, { variantId: "missing", quantity: 1 }), "VARIANT_NOT_FOUND", 404);
    });

    it("increments an existing item instead of duplicating", async () => {
      const { service, cartRepository, catalogRepository } = setup();
      const user = makeUser();
      catalogRepository.seedVariant("v1");
      await service.addItem(user, { variantId: "v1", quantity: 2 });

      const result = await service.addItem(user, { variantId: "v1", quantity: 3 });

      expect(result.created).toBe(false);
      expect(result.data.items).toHaveLength(1);
      expect(result.data.items[0]).toMatchObject({ variantId: "v1", quantity: 5 });
      // The silent increment must not have issued another raw insert.
      expect(cartRepository.addItemCalls).toHaveLength(1);
    });

    it("caps the incremented quantity at the shared limit", async () => {
      const { service, catalogRepository } = setup();
      const user = makeUser();
      catalogRepository.seedVariant("v1");
      await service.addItem(user, { variantId: "v1", quantity: CART_ITEM_QUANTITY_LIMITS.max - 1 });

      const result = await service.addItem(user, { variantId: "v1", quantity: 5 });

      expect(result.data.items[0]!.quantity).toBe(CART_ITEM_QUANTITY_LIMITS.max);
    });

    it("absorbs a duplicate-insert race by incrementing the winner's row", async () => {
      const { service, cartRepository, catalogRepository } = setup();
      const user = makeUser();
      catalogRepository.seedVariant("v1");
      // First call inserts the row (conflict flag off)...
      await service.addItem(user, { variantId: "v1", quantity: 1 });
      // ...second call loses the UNIQUE race (conflict flag on), forcing the
      // repository's CART_ITEM_EXISTS result.
      cartRepository.forceAddItemConflict = true;

      const result = await service.addItem(user, { variantId: "v1", quantity: 4 });

      expect(result.created).toBe(false);
      expect(result.data.items).toHaveLength(1);
      expect(result.data.items[0]).toMatchObject({ variantId: "v1", quantity: 5 });
    });

    it("rejects out-of-range quantities with per-field validation errors", async () => {
      const { service, catalogRepository } = setup();
      const user = makeUser();
      catalogRepository.seedVariant("v1");

      for (const [body, expected] of [
        [{ variantId: "v1", quantity: 0 }, "Quantity must be between 1 and 99."],
        [{ variantId: "v1", quantity: 100 }, "Quantity must be between 1 and 99."],
        [{ variantId: "v1", quantity: "3" }, "Quantity must be a whole number."],
        [{ variantId: "v1" }, "Quantity is required."],
        [{ variantId: "", quantity: 1 }, "Variant id is required."],
        [{ quantity: 1 }, "Variant id is required."],
      ] as Array<[Record<string, unknown>, string]>) {
        try {
          await service.addItem(user, body);
          throw new Error("expected VALIDATION_ERROR to be thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(AppError);
          const appError = error as AppError;
          expect(appError.code).toBe("VALIDATION_ERROR");
          expect(appError.statusCode).toBe(422);
          expect(Object.values(appError.fields ?? {}).flat()).toContain(expected);
        }
      }
    });
  });

  describe("updateItemQuantity", () => {
    it("overwrites the quantity of an item in the caller's cart", async () => {
      const { service, catalogRepository } = setup();
      const user = makeUser();
      catalogRepository.seedVariant("v1");
      const { data } = await service.addItem(user, { variantId: "v1", quantity: 1 });
      const itemId = data.items[0]!.id;

      const cart = await service.updateItemQuantity(user, itemId, { quantity: 9 });

      expect(cart.items[0]).toMatchObject({ id: itemId, variantId: "v1", quantity: 9 });
    });

    it("raises CART_ITEM_NOT_FOUND for an item outside the caller's cart", async () => {
      const { service, catalogRepository } = setup();
      const owner = makeUser();
      const outsider = makeUser();
      catalogRepository.seedVariant("v1");
      const { data } = await service.addItem(owner, { variantId: "v1", quantity: 1 });
      const itemId = data.items[0]!.id;

      await expectCodeError(service.updateItemQuantity(outsider, itemId, { quantity: 5 }), "CART_ITEM_NOT_FOUND", 404);
    });

    it("raises NOT_FOUND for a malformed (non-UUIDv7) item id", async () => {
      const { service } = setup();
      const user = makeUser();
      await expectCodeError(service.updateItemQuantity(user, "not-an-id", { quantity: 2 }), "NOT_FOUND", 404);
    });

    it("raises CART_ITEM_NOT_FOUND for a well-formed id with no matching item", async () => {
      const { service } = setup();
      const user = makeUser();
      await expectCodeError(
        service.updateItemQuantity(user, "00000000-0000-7000-8000-000000000099", { quantity: 2 }),
        "CART_ITEM_NOT_FOUND",
        404,
      );
    });
  });

  describe("removeItem", () => {
    it("removes an item from the caller's cart", async () => {
      const { service, catalogRepository } = setup();
      const user = makeUser();
      catalogRepository.seedVariant("v1");
      const { data } = await service.addItem(user, { variantId: "v1", quantity: 1 });
      const itemId = data.items[0]!.id;

      const cart = await service.removeItem(user, itemId);

      expect(cart.items).toEqual([]);
    });

    it("raises CART_ITEM_NOT_FOUND for an item outside the caller's cart", async () => {
      const { service, catalogRepository } = setup();
      const owner = makeUser();
      const outsider = makeUser();
      catalogRepository.seedVariant("v1");
      const { data } = await service.addItem(owner, { variantId: "v1", quantity: 1 });

      await expectCodeError(service.removeItem(outsider, data.items[0]!.id), "CART_ITEM_NOT_FOUND", 404);
    });
  });

  describe("clearCart", () => {
    it("empties the cart but keeps its id", async () => {
      const { service, catalogRepository } = setup();
      const user = makeUser();
      catalogRepository.seedVariant("v1");
      const before = await service.getCart(user);
      await service.addItem(user, { variantId: "v1", quantity: 2 });

      const cart = await service.clearCart(user);

      expect(cart.id).toBe(before.id);
      expect(cart.items).toEqual([]);

      const again = await service.getCart(user);
      expect(again.id).toBe(before.id);
    });
  });
});