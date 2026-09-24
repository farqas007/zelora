import { AUTH_ERROR_CODES, CART_ERROR_CODES, CART_ITEM_QUANTITY_LIMITS, type CartDto } from "@zelora/shared";
import { AppError, NotFoundError } from "@zelora/core";
import { isValidId } from "@zelora/db/ids";
import type { UserRecord } from "@zelora/db/users";
import type { CatalogRepository } from "@zelora/db/catalog";
import type { CartRepository, CartWithItemsRecord } from "@zelora/db/cart";
import { parseAddCartItemRequest, parseUpdateCartItemRequest } from "./validation";

/**
 * Shopping cart for an authenticated session.
 *
 * Every method takes the authenticated {@link UserRecord} and owns only two
 * data dependencies: the cart repository (rows/items) and the catalog
 * repository (to confirm a requested variant actually exists). Identity
 * always comes from the session — nothing from the request body is trusted,
 * and item mutations operate exclusively on the caller's own cart.
 *
 * The cart row is created lazily on first read, so `GET /api/cart` never
 * errors for a new customer. Adding an already-present variant increments its
 * quantity (capped at {@link CART_ITEM_QUANTITY_LIMITS.max}) instead of
 * inserting a duplicate; the repository's driver-neutral conflict results
 * absorb the concurrent-request races.
 *
 * Money is deliberately absent: items reference variants by id only, and
 * totals are derived from live variant prices at checkout.
 *
 * Edge-compatible: database contracts are imported as types only and all
 * repository I/O goes through the injected async ports.
 */

export interface CartServiceDependencies {
  cartRepository: CartRepository;
  catalogRepository: CatalogRepository;
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

function toCartDto(cart: CartWithItemsRecord): CartDto {
  return {
    id: cart.cart.id,
    items: cart.items.map((item) => ({
      id: item.id,
      variantId: item.variantId,
      quantity: item.quantity,
    })),
  };
}

export class CartService {
  private readonly cartRepository: CartRepository;
  private readonly catalogRepository: CatalogRepository;

  constructor(dependencies: CartServiceDependencies) {
    this.cartRepository = dependencies.cartRepository;
    this.catalogRepository = dependencies.catalogRepository;
  }

  /**
   * Resolve the caller's cart, creating the row when the caller has none.
   * A bare cart (empty items) is a legitimate response for a new customer.
   */
  async getCart(user: UserRecord): Promise<CartDto> {
    assertActiveUser(user);
    return this.getCartDto(user.id);
  }

  /**
   * Add a variant to the caller's cart. When the variant is already present
   * its quantity is incremented (never duplicated) and `created` is `false`;
   * when a genuinely new row is inserted `created` is `true`, so the route
   * can signal `201`/`200` respectively. An unknown variant raises
   * `VARIANT_NOT_FOUND`.
   */
  async addItem(
    user: UserRecord,
    request: unknown,
  ): Promise<{ data: CartDto; created: boolean }> {
    assertActiveUser(user);
    const parsed = parseAddCartItemRequest(request);

    const variant = await this.catalogRepository.findVariantById(parsed.variantId);
    if (variant === null) {
      throw new AppError(
        CART_ERROR_CODES.VARIANT_NOT_FOUND,
        "The requested variant was not found.",
        404,
      );
    }

    const { cart, items } = await this.getOrCreateCart(user.id);
    const existing = items.find((item) => item.variantId === parsed.variantId);

    if (existing !== undefined) {
      const quantity = clampQuantity(existing.quantity + parsed.quantity);
      await this.cartRepository.updateItemQuantity(cart.id, existing.id, quantity);
      return { data: await this.getCartDto(user.id), created: false };
    }

    const result = await this.cartRepository.addItem({
      cartId: cart.id,
      variantId: parsed.variantId,
      quantity: parsed.quantity,
    });

    // The variant was absent a moment ago, so a `CART_ITEM_EXISTS` conflict can
    // only be a concurrent insert racing us. Absorb it by incrementing the
    // winner's row; the outcome is identical to the non-racy increment path.
    if (!result.ok) {
      const current = await this.getOrCreateCart(user.id);
      const racing = current.items.find((item) => item.variantId === parsed.variantId);
      if (racing === undefined) {
        throw new AppError(
          "INTERNAL_ERROR",
          "The cart item could not be resolved.",
          500,
        );
      }
      const quantity = clampQuantity(racing.quantity + parsed.quantity);
      await this.cartRepository.updateItemQuantity(current.cart.id, racing.id, quantity);
      return { data: toCartDto(current), created: false };
    }

    return { data: await this.getCartDto(user.id), created: true };
  }

  /**
   * Overwrite an item's quantity. Only quantity may change — an item's
   * variant is fixed; to swap variants the client removes and re-adds. A
   * patch for an item that is not in the caller's cart (or never existed)
   * raises `CART_ITEM_NOT_FOUND`.
   */
  async updateItemQuantity(
    user: UserRecord,
    itemId: string,
    request: unknown,
  ): Promise<CartDto> {
    assertActiveUser(user);
    this.assertItemAddressable(itemId);
    const parsed = parseUpdateCartItemRequest(request);

    const { cart } = await this.getOrCreateCart(user.id);
    const updated = await this.cartRepository.updateItemQuantity(
      cart.id,
      itemId,
      parsed.quantity,
    );
    if (updated === null) {
      throw new AppError(
        CART_ERROR_CODES.CART_ITEM_NOT_FOUND,
        "The cart item was not found.",
        404,
      );
    }
    return this.getCartDto(user.id);
  }

  /**
   * Remove an item from the caller's cart. The cart row is preserved.
   * A delete for an item that is not in the caller's cart raises
   * `CART_ITEM_NOT_FOUND`, matching the read/update contract.
   */
  async removeItem(user: UserRecord, itemId: string): Promise<CartDto> {
    assertActiveUser(user);
    this.assertItemAddressable(itemId);

    const { cart } = await this.getOrCreateCart(user.id);
    const removed = await this.cartRepository.removeItem(cart.id, itemId);
    if (!removed) {
      throw new AppError(
        CART_ERROR_CODES.CART_ITEM_NOT_FOUND,
        "The cart item was not found.",
        404,
      );
    }
    return this.getCartDto(user.id);
  }

  /**
   * Empty the caller's cart. The cart row itself is kept so the id stays
   * stable across checkouts.
   */
  async clearCart(user: UserRecord): Promise<CartDto> {
    assertActiveUser(user);
    const { cart } = await this.getOrCreateCart(user.id);
    await this.cartRepository.clearCart(cart.id);
    return this.getCartDto(user.id);
  }

  /**
   * Resolve the caller's cart with a lazy create. The repository's
   * `CART_EXISTS` result absorbs the get-or-create race: whichever request
   * wins the insert, both leave with a real row to operate on.
   */
  private async getOrCreateCart(userId: string): Promise<CartWithItemsRecord> {
    const existing = await this.cartRepository.getCartByUserId(userId);
    if (existing !== null) {
      return existing;
    }
    const result = await this.cartRepository.createCart(userId);
    if (result.ok) {
      return { cart: result.cart, items: [] };
    }
    const created = await this.cartRepository.getCartByUserId(userId);
    if (created === null) {
      throw new AppError("INTERNAL_ERROR", "The cart could not be created.", 500);
    }
    return created;
  }

  /** Resolve the cart DTO, lazily creating the row when the caller has none. */
  private async getCartDto(userId: string): Promise<CartDto> {
    return toCartDto(await this.getOrCreateCart(userId));
  }

  /** Reject non-UUIDv7 item ids as addressable-never matches → 404. */
  private assertItemAddressable(itemId: string): void {
    if (!isValidId(itemId)) {
      throw new NotFoundError("The cart item was not found.");
    }
  }
}

function clampQuantity(quantity: number): number {
  return Math.min(quantity, CART_ITEM_QUANTITY_LIMITS.max);
}