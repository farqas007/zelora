import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type {
  ApiEnvelope,
  CartDto,
  CatalogProductDetailDto,
  CatalogProductSummaryDto,
  UserDto,
} from "@zelora/shared";
import type { ZeloraApi } from "../lib/api/client";
import type { AuthContextValue } from "../context/AuthContext";
import { useAuth } from "../context/AuthContext";
import type { CartContextValue, CartStatus } from "../context/CartContext";
import { useCart } from "../context/CartContext";
import { CartPage } from "./Cart";

/**
 * Page tests for the cart.
 *
 * The cart API returns variant ids and quantities and nothing else — no price,
 * no name. Everything the page shows about a line therefore comes from the
 * public catalog, and the subtotal it offers is a *preview*: the order's money
 * is recomputed server-side at checkout. These tests pin that distinction, plus
 * the two controls that change money-adjacent state (quantity, clear).
 *
 * The catalog join is exercised for real, not mocked out, so the page is
 * tested against the same two calls it makes in the browser.
 */

vi.mock("../context/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../context/CartContext", () => ({ useCart: vi.fn() }));

const TRAILER_VARIANT = "01955f00-0000-7000-8000-0000000000e1";
const TENT_VARIANT = "01955f00-0000-7000-8000-0000000000e2";
const TRAILER_ITEM = "01955f00-0000-7000-8000-0000000000e3";
const TENT_ITEM = "01955f00-0000-7000-8000-0000000000e4";

function product(overrides: Partial<CatalogProductDetailDto> = {}): CatalogProductDetailDto {
  return {
    id: "01955f00-0000-7000-8000-0000000000e5",
    slug: "box-trailer",
    name: "Box Trailer",
    description: null,
    store: { id: "01955f00-0000-7000-8000-0000000000e6", slug: "farqas-tech", name: "Farqas Tech" },
    category: null,
    variants: [
      {
        id: TRAILER_VARIANT,
        name: "12ft Box Trailer",
        sku: "TRAILER-12",
        priceAmountCents: 1_250,
        compareAtAmountCents: null,
        currency: "USD",
      },
    ],
    images: [],
    ...overrides,
  };
}

const TRAILER = product();
const TENT = product({
  id: "01955f00-0000-7000-8000-0000000000e7",
  slug: "ridge-tent",
  name: "Ridge Tent",
  store: { id: "01955f00-0000-7000-8000-0000000000e8", slug: "lantern-supply", name: "Lantern Supply" },
  variants: [
    {
      id: TENT_VARIANT,
      name: "2-person",
      sku: null,
      priceAmountCents: 8_000,
      compareAtAmountCents: null,
      currency: "USD",
    },
  ],
});

/** The two products the lookup pages through, in summary and detail form. */
const CATALOG: CatalogProductDetailDto[] = [TRAILER, TENT];

function summaryOf(detail: CatalogProductDetailDto): CatalogProductSummaryDto {
  return {
    id: detail.id,
    slug: detail.slug,
    name: detail.name,
    description: detail.description,
    store: detail.store,
    category: detail.category,
    priceAmountCents: detail.variants[0]?.priceAmountCents ?? null,
    compareAtAmountCents: null,
    currency: "USD",
    image: null,
  };
}

function shopper(): UserDto {
  return {
    id: "01955f00-0000-7000-8000-0000000000a1",
    email: "shopper@zelora.test",
    name: "Ada",
    role: "customer",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function ok<T>(data: T): ApiEnvelope<T> {
  return { ok: true, data };
}

interface CartStub {
  updateItemQuantity: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
  clearCart: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
}

function givenCart(
  cart: CartDto | null,
  status: CartStatus = "ready",
  error: string | null = null,
): CartStub {
  const api = {
    // The header's own category chips; irrelevant here but it renders.
    listCatalogCategories: (): Promise<ApiEnvelope<never[]>> => Promise.resolve(ok([])),
    // The catalog join: one page of summaries, then a detail per product.
    listCatalogProducts: (): Promise<ApiEnvelope<{ items: CatalogProductSummaryDto[]; nextCursor: null }>> =>
      Promise.resolve(ok({ items: CATALOG.map(summaryOf), nextCursor: null })),
    getCatalogProductBySlug: (slug: string): Promise<ApiEnvelope<CatalogProductDetailDto>> =>
      Promise.resolve(ok(CATALOG.find((entry) => entry.slug === slug) ?? TRAILER)),
  } as unknown as ZeloraApi;

  vi.mocked(useAuth).mockReturnValue({
    api,
    status: "authenticated",
    user: shopper(),
    csrfToken: "csrf-token",
  } as unknown as AuthContextValue);

  const stub: CartStub = {
    updateItemQuantity: vi.fn(() => Promise.resolve()),
    removeItem: vi.fn(() => Promise.resolve()),
    clearCart: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
  };
  vi.mocked(useCart).mockReturnValue({
    cart,
    itemCount: cart?.items.reduce((total, item) => total + item.quantity, 0) ?? 0,
    status,
    error,
    ...stub,
  } as unknown as CartContextValue);

  return stub;
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <CartPage />
    </MemoryRouter>,
  );
}

/** The subtotal and the call to action share one block. */
function cartSummary(): HTMLElement {
  return screen.getByRole("link", { name: "Checkout" }).parentElement as HTMLElement;
}

/**
 * Wait for the catalog join to land. Until it does, a line has no product
 * name, so the quantity controls are named "this item" rather than the product
 * the test wants to address them by.
 */
async function whenCatalogResolved(): Promise<void> {
  await screen.findByRole("link", { name: "Box Trailer" }, { timeout: 15_000 });
}

function twoLineCart(): CartDto {
  return {
    id: "01955f00-0000-7000-8000-0000000000e9",
    items: [
      { id: TRAILER_ITEM, variantId: TRAILER_VARIANT, quantity: 2 },
      { id: TENT_ITEM, variantId: TENT_VARIANT, quantity: 1 },
    ],
  };
}

const SUITE = { timeout: 30_000 };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("CartPage", SUITE, () => {
  it("previews a subtotal from live catalog prices times quantities", async () => {
    givenCart(twoLineCart());

    renderPage();

    // 2 × $12.50 + 1 × $80.00. The number comes from the catalog, never from
    // the line, because the line does not carry a price to trust.
    const summary = await waitFor(
      () => {
        const block = cartSummary();
        expect(block.textContent).toContain("Subtotal $105.00");
        return block;
      },
      { timeout: 15_000 },
    );
    expect(summary.textContent).toContain("3 items");
  });

  it("offers no subtotal at all when a line cannot be matched to the catalog", async () => {
    givenCart({
      id: "01955f00-0000-7000-8000-0000000000e9",
      items: [{ id: TRAILER_ITEM, variantId: "01955f00-0000-7000-8000-00000000dead", quantity: 1 }],
    });

    renderPage();

    // A deactivated product leaves the cart unable to price itself. Guessing
    // would be worse than saying so, so the page says the price is confirmed
    // later and keeps the checkout link.
    expect(await screen.findByText("Prices confirm at checkout.")).toBeDefined();
    expect(cartSummary().textContent).not.toContain("Subtotal");
    expect(screen.getByText("Unavailable item")).toBeDefined();
  });

  it("sends a shopper with something in the cart to checkout", () => {
    givenCart(twoLineCart());

    renderPage();

    expect(screen.getByRole("link", { name: "Checkout" }).getAttribute("href")).toBe("/checkout");
    expect(screen.getByRole("heading", { name: "Your cart" })).toBeDefined();
  });

  it("steps a quantity by one through the shared cart state", async () => {
    const cart = givenCart(twoLineCart());

    renderPage();
    await whenCatalogResolved();
    fireEvent.click(screen.getAllByRole("button", { name: "Increase quantity" })[0]!);

    await waitFor(() => expect(cart.updateItemQuantity).toHaveBeenCalledWith(TRAILER_ITEM, 3));
  });

  it("clamps a typed quantity to the bound the page advertises", async () => {
    const cart = givenCart(twoLineCart());

    renderPage();
    await whenCatalogResolved();
    const input = screen.getAllByRole("spinbutton", { name: "Quantity of Box Trailer" })[0]!;
    // The bound is read off the control rather than restated in the request,
    // so the assertion is that the page clamps to *its own* advertised limit
    // instead of forwarding whatever was typed. 99 is the API's documented
    // `CART_ITEM_QUANTITY_LIMITS.max`, so anything else here would be a bug.
    const advertisedMax = Number(input.getAttribute("max"));
    expect(advertisedMax).toBe(99);

    fireEvent.change(input, { target: { value: "1000" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(cart.updateItemQuantity).toHaveBeenCalledWith(TRAILER_ITEM, advertisedMax),
    );
  });

  it("makes clearing the whole cart a deliberate two-step", async () => {
    const cart = givenCart(twoLineCart());

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Clear cart" }));

    // Nothing has been cleared yet: the confirmation is a gate, not a notice.
    expect(screen.getByText("Clear all items?")).toBeDefined();
    expect(cart.clearCart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Yes, clear" }));
    await waitFor(() => expect(cart.clearCart).toHaveBeenCalledTimes(1));
  });

  it("invites a signed-out visitor to sign in instead of showing an error", () => {
    givenCart(null, "signed-out");

    renderPage();

    // Scoped to the cart's own panel: the shared header carries a "Sign in"
    // link of its own, and this assertion is about the one beside the copy.
    const panel = screen.getByRole("heading", { name: "Sign in to view your cart" })
      .parentElement as HTMLElement;
    expect(within(panel).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/login",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the empty state once the last item is gone", () => {
    givenCart({ id: "01955f00-0000-7000-8000-0000000000e9", items: [] });

    renderPage();

    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Checkout" })).toBeNull();
  });
});
