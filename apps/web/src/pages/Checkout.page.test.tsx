import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type {
  ApiEnvelope,
  CatalogProductDetailDto,
  CatalogProductSummaryDto,
  CatalogVariantDto,
  CartDto,
  OrderDetailDto,
  PlaceOrderEnvelope,
  UserDto,
} from "@zelora/shared";
import type { ZeloraApi } from "../lib/api/client";
import type { AuthContextValue } from "../context/AuthContext";
import { useAuth } from "../context/AuthContext";
import type { CartContextValue } from "../context/CartContext";
import { useCart } from "../context/CartContext";
import { CheckoutPage } from "./Checkout";

/**
 * Component tests for the checkout page.
 *
 * The page already trusts nothing the shopper types: it sends a body of
 * addresses only, and the money shown in the summary is derived from the same
 * public catalog lookup the cart uses rather than from anything held in state.
 * These drive the real component against a recording API double, so what is
 * under test is the page's contract with the client — which endpoints it
 * reaches for, what it puts in the request, and what it does with the answers.
 *
 * `Checkout.test.ts` already covers the exported pure helpers
 * (`toAddressRequest`, `AddressForm`); nothing here re-tests those.
 */

vi.mock("../context/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../context/CartContext", () => ({ useCart: vi.fn() }));

const VARIANT_ID = "01955f00-0000-7000-8000-0000000000e1";
const CART_ITEM_ID = "01955f00-0000-7000-8000-0000000000e2";
const ORDER_ID = "01955f00-0000-7000-8000-0000000000e3";

function variant(overrides: Partial<CatalogVariantDto> = {}): CatalogVariantDto {
  return {
    id: VARIANT_ID,
    name: "12ft Box Trailer",
    sku: "TRAILER-12",
    priceAmountCents: 1_250,
    compareAtAmountCents: null,
    currency: "USD",
    ...overrides,
  };
}

/** The one product the cart's variant belongs to, in both catalog projections. */
const PRODUCT: CatalogProductDetailDto = {
  id: "01955f00-0000-7000-8000-0000000000e4",
  slug: "box-trailer",
  name: "Box Trailer",
  description: "A trailer for moving boxes.",
  store: { id: "01955f00-0000-7000-8000-0000000000e5", slug: "farqas-tech", name: "Farqas Tech" },
  category: null,
  variants: [variant()],
  images: [],
};

const PRODUCT_SUMMARY: CatalogProductSummaryDto = {
  id: PRODUCT.id,
  slug: PRODUCT.slug,
  name: PRODUCT.name,
  description: PRODUCT.description,
  store: PRODUCT.store,
  category: null,
  priceAmountCents: 1_250,
  compareAtAmountCents: null,
  currency: "USD",
  image: null,
};

/** The order the API returns for a successful checkout. */
const PLACED_ORDER: OrderDetailDto = {
  id: ORDER_ID,
  status: "pending",
  currency: "USD",
  subtotalAmountCents: 2_500,
  shippingAmountCents: 0,
  discountAmountCents: 0,
  totalAmountCents: 2_500,
  itemCount: 1,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  items: [
    {
      id: "01955f00-0000-7000-8000-0000000000e6",
      variantId: VARIANT_ID,
      storeId: PRODUCT.store.id,
      productName: "Box Trailer",
      variantName: "12ft Box Trailer",
      quantity: 2,
      unitAmountCents: 1_250,
      lineTotalAmountCents: 2_500,
      currency: "USD",
      status: "confirmed",
    },
  ],
  addresses: [
    {
      kind: "shipping",
      recipientName: "Ada Lovelace",
      phone: null,
      line1: "1 Analytical Engine Parade",
      line2: null,
      city: "London",
      region: null,
      postalCode: "SW1A 1AA",
      countryCode: "GB",
    },
  ],
};

function cartWith(quantity: number): CartDto {
  return { id: "01955f00-0000-7000-8000-0000000000e7", items: [{ id: CART_ITEM_ID, variantId: VARIANT_ID, quantity }] };
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

/** What an overridden method resolves to; a function lets a test reject. */
type Outcome<R> = R | Promise<R> | ((...args: unknown[]) => R | Promise<R>);

interface StubOptions {
  placeOrder?: Outcome<PlaceOrderEnvelope>;
}

interface RecordedCall {
  method: string;
  args: unknown[];
}

function createApiStub(options: StubOptions = {}): { api: ZeloraApi; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  function record<R>(method: string, fallback: R): (...args: unknown[]) => Promise<R> {
    return (...args: unknown[]): Promise<R> => {
      calls.push({ method, args });
      const override = options[method as keyof StubOptions];
      if (override === undefined) {
        return Promise.resolve(fallback);
      }
      if (typeof override === "function") {
        return Promise.resolve((override as (...a: unknown[]) => R | Promise<R>)(...args));
      }
      return Promise.resolve(override as R);
    };
  }

  const api = {
    // The header's own category chips; irrelevant here but it renders.
    listCatalogCategories: (): Promise<ApiEnvelope<never[]>> => Promise.resolve(ok([])),
    listCatalogProducts: (): Promise<ApiEnvelope<{ items: CatalogProductSummaryDto[]; nextCursor: null }>> =>
      Promise.resolve(ok({ items: [PRODUCT_SUMMARY], nextCursor: null })),
    getCatalogProductBySlug: (): Promise<ApiEnvelope<CatalogProductDetailDto>> =>
      Promise.resolve(ok(PRODUCT)),
    placeOrder: record<PlaceOrderEnvelope>("placeOrder", ok(PLACED_ORDER)),
  } as unknown as ZeloraApi;

  return { api, calls };
}

/**
 * Wire the contexts the page reads. `refresh` is spied on because the page must
 * re-read the cart after a successful checkout — the order's lines are the
 * catalog's now, so the cart is empty and has to be re-fetched to say so.
 */
function givenPage(options: { cart: CartDto | null } & StubOptions = { cart: cartWith(2) }): {
  calls: RecordedCall[];
  refresh: ReturnType<typeof vi.fn>;
} {
  const { api, calls } = createApiStub(options);
  const refresh = vi.fn(() => Promise.resolve());

  vi.mocked(useAuth).mockReturnValue({
    api,
    status: "authenticated",
    user: shopper(),
    csrfToken: "csrf-token",
  } as unknown as AuthContextValue);
  vi.mocked(useCart).mockReturnValue({
    cart: options.cart,
    // The real context sums quantities, not lines; mirror it so the summary's
    // "2 items" is the same number the header badge would show.
    itemCount: options.cart?.items.reduce((total, item) => total + item.quantity, 0) ?? 0,
    status: "ready",
    error: null,
    refresh,
  } as unknown as CartContextValue);

  return { calls, refresh };
}

/** Reports what the confirmation route received, so navigation is observable. */
function ConfirmationProbe() {
  const location = useLocation();
  const order = (location.state as { order?: OrderDetailDto } | null)?.order;
  return <p>reached confirmation for {order?.id ?? "nothing"}</p>;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/checkout"]}>
      <Routes>
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="/checkout/confirmation" element={<ConfirmationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Fill only the fields the server requires, leaving every optional one blank. */
function fillRequiredShippingAddress(): void {
  fireEvent.change(screen.getByLabelText("Recipient name"), { target: { value: "  Ada Lovelace  " } });
  fireEvent.change(screen.getByLabelText("Address line 1"), {
    target: { value: "1 Analytical Engine Parade" },
  });
  fireEvent.change(screen.getByLabelText("City"), { target: { value: "London" } });
  fireEvent.change(screen.getByLabelText("Country code"), { target: { value: "gb" } });
}

function placeOrderButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Place order" }) as HTMLButtonElement;
}

/** The button stays disabled until the catalog-priced summary has resolved. */
async function whenSubmittable(): Promise<HTMLButtonElement> {
  const button = placeOrderButton();
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

/**
 * The suite is given room to breathe: these tests drive the real page, chrome
 * included, and a loaded CI box spends seconds in jsdom setup and transform
 * before the first assertion runs. A generous per-suite timeout keeps a slow
 * machine from failing a test that is simply waiting on a render.
 */
const SUITE = { timeout: 30_000 };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("CheckoutPage", SUITE, () => {
  it("prices the summary from the catalog, not from anything the shopper sent", async () => {
    givenPage();

    renderPage();

    // The cart carries only a variant id and a quantity, so the page has to
    // join it against the live catalog before it can show a number at all.
    expect(await screen.findByText("$25.00")).toBeDefined();
    const summary = screen.getByRole("complementary", { name: "Order summary" });
    expect(summary.textContent).toContain("2 items");
    expect(summary.textContent).toContain("Subtotal $25.00");
    expect(summary.textContent).toContain("Shipping and discounts are calculated at checkout.");
  });

  it("offers the shipping form instead of one when there is nothing to check out", () => {
    givenPage({ cart: { id: "cart-empty", items: [] } });

    renderPage();

    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Place order" })).toBeNull();
    expect(screen.queryByLabelText("Recipient name")).toBeNull();
  });

  it("sends a body of trimmed addresses and nothing else", async () => {
    const { calls } = givenPage();

    renderPage();
    const button = await whenSubmittable();
    fillRequiredShippingAddress();
    fireEvent.click(button);

    await waitFor(() => expect(calls.filter((call) => call.method === "placeOrder")).toHaveLength(1));
    expect(calls.find((call) => call.method === "placeOrder")?.args[0]).toEqual({
      shippingAddress: {
        recipientName: "Ada Lovelace",
        line1: "1 Analytical Engine Parade",
        city: "London",
        countryCode: "GB",
      },
    });
  });

  it("never puts a total, a currency or a line in the checkout body", async () => {
    // The server re-prices from the catalog and rebuilds the lines from the
    // session cart. A body carrying any of these would be trusting the client
    // with money, so their absence is the contract, not an implementation note.
    const { calls } = givenPage();

    renderPage();
    const button = await whenSubmittable();
    fillRequiredShippingAddress();
    fireEvent.click(button);

    await waitFor(() => expect(calls.filter((call) => call.method === "placeOrder")).toHaveLength(1));
    const body = calls.find((call) => call.method === "placeOrder")?.args[0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["shippingAddress"]);
  });

  it("sends both addresses once the shopper fills in a separate billing one", async () => {
    const { calls } = givenPage();

    renderPage();
    const button = await whenSubmittable();
    fillRequiredShippingAddress();
    fireEvent.click(screen.getByLabelText("Billing address differs from shipping"));
    const billing = screen.getByRole("group", { name: "Billing address" });
    fireEvent.change(within(billing).getByLabelText("Recipient name"), { target: { value: "Charles Babbage" } });
    fireEvent.change(within(billing).getByLabelText("Address line 1"), {
      target: { value: "221B Billing Street" },
    });
    fireEvent.change(within(billing).getByLabelText("City"), { target: { value: "Cambridge" } });
    fireEvent.change(within(billing).getByLabelText("Country code"), { target: { value: "GB" } });
    fireEvent.click(button);

    await waitFor(() => expect(calls.filter((call) => call.method === "placeOrder")).toHaveLength(1));
    const body = calls.find((call) => call.method === "placeOrder")?.args[0] as {
      shippingAddress: Record<string, unknown>;
      billingAddress: Record<string, unknown>;
    };
    expect(body.billingAddress).toEqual({
      recipientName: "Charles Babbage",
      line1: "221B Billing Street",
      city: "Cambridge",
      countryCode: "GB",
    });
  });

  it("holds back a billing address the shopper opened but never finished", async () => {
    // Opting into a second address adds a second set of required fields, and
    // they are validated exactly as the shipping ones are. Sending a half
    // filled billing address would only be rejected by the server.
    const { calls } = givenPage();

    renderPage();
    const button = await whenSubmittable();
    fillRequiredShippingAddress();
    fireEvent.click(screen.getByLabelText("Billing address differs from shipping"));
    fireEvent.click(button);

    expect(await screen.findByText("Please fix the highlighted fields and try again.")).toBeDefined();
    expect(calls.filter((call) => call.method === "placeOrder")).toHaveLength(0);
  });

  it("re-reads the cart and carries the placed order to the confirmation page", async () => {
    const { calls, refresh } = givenPage();

    renderPage();
    const button = await whenSubmittable();
    fillRequiredShippingAddress();
    fireEvent.click(button);

    expect(await screen.findByText(`reached confirmation for ${ORDER_ID}`)).toBeDefined();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls.find((call) => call.method === "placeOrder")).toBeDefined();
  });

  it("refuses to submit an address the shopper has not finished", async () => {
    const { calls } = givenPage();

    renderPage();
    const button = await whenSubmittable();
    fireEvent.click(button);

    expect(await screen.findByText("Please fix the highlighted fields and try again.")).toBeDefined();
    expect(screen.getByText("Recipient name is required.")).toBeDefined();
    expect(screen.getByText("City is required.")).toBeDefined();
    expect(calls.filter((call) => call.method === "placeOrder")).toHaveLength(0);
  });

  it("shows the server's field errors against the fields they name", async () => {
    givenPage({
      cart: cartWith(2),
      placeOrder: {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed.",
          fields: { "shippingAddress.countryCode": ["Country code must be a 2-letter code, e.g. US."] },
        },
      },
    });

    renderPage();
    const button = await whenSubmittable();
    fillRequiredShippingAddress();
    fireEvent.click(button);

    const error = await screen.findByText("Country code must be a 2-letter code, e.g. US.");
    expect(error.id).toBe("shippingAddress-countryCode-error");
    expect(document.getElementById("shippingAddress-countryCode")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("explains a stock conflict in the shopper's terms and stays on the form", async () => {
    // A 409 is the API's way of saying the cart is stale; the shopper has to be
    // told which situation it is so they can go fix the right thing.
    givenPage({
      cart: cartWith(2),
      placeOrder: {
        ok: false,
        error: { code: "STOCK_CHANGED", message: "raw server wording" },
      },
    });

    renderPage();
    const button = await whenSubmittable();
    fillRequiredShippingAddress();
    fireEvent.click(button);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "An item in your cart no longer has enough stock. Please review it and try again.",
    );
    expect(screen.queryByText(/reached confirmation/)).toBeNull();
    expect(screen.getByRole("button", { name: "Place order" })).toBeDefined();
  });
});
