import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ApiEnvelope, OrderDetailDto, UserDto } from "@zelora/shared";
import type { ZeloraApi } from "../lib/api/client";
import type { AuthContextValue } from "../context/AuthContext";
import { useAuth } from "../context/AuthContext";
import type { CartContextValue } from "../context/CartContext";
import { useCart } from "../context/CartContext";
import { OrderConfirmationPage } from "./OrderConfirmation";

/**
 * Page tests for the post-checkout confirmation.
 *
 * The order arrives in router state because `POST /api/orders` just returned it,
 * so this page must render without a refetch — the confirmation appears
 * instantly instead of flashing a spinner. The same design dictates the other
 * behaviour worth pinning: a reload or a direct link loses that state, and the
 * page then has to point at the order history rather than invent an order.
 */

vi.mock("../context/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../context/CartContext", () => ({ useCart: vi.fn() }));

const ORDER_ID = "01955f00-0000-7000-8000-0000000000c9";

function order(overrides: Partial<OrderDetailDto> = {}): OrderDetailDto {
  return {
    id: ORDER_ID,
    status: "pending",
    currency: "USD",
    subtotalAmountCents: 2_500,
    shippingAmountCents: 0,
    discountAmountCents: 0,
    totalAmountCents: 2_500,
    itemCount: 2,
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-01T10:00:00.000Z",
    items: [
      {
        id: "01955f00-0000-7000-8000-0000000000d1",
        variantId: "01955f00-0000-7000-8000-0000000000d2",
        storeId: "01955f00-0000-7000-8000-0000000000d3",
        productName: "Box Trailer",
        variantName: "12ft Box Trailer",
        quantity: 2,
        unitAmountCents: 1_250,
        lineTotalAmountCents: 2_500,
        currency: "USD",
        status: "confirmed",
      },
    ],
    addresses: [],
    ...overrides,
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

const calledMethods: string[] = [];

/** Only the header's category chips are reachable from this page. */
function givenSession(): void {
  const api = {
    listCatalogCategories: (): Promise<ApiEnvelope<never[]>> => {
      calledMethods.push("listCatalogCategories");
      return Promise.resolve(ok([]));
    },
  } as unknown as ZeloraApi;

  vi.mocked(useAuth).mockReturnValue({
    api,
    status: "authenticated",
    user: shopper(),
    csrfToken: "csrf-token",
  } as unknown as AuthContextValue);
  vi.mocked(useCart).mockReturnValue({ itemCount: 0 } as unknown as CartContextValue);
}

/** Render the page the way checkout hands it over, and the way a reload does. */
function renderConfirmation(state: { order: OrderDetailDto } | undefined): void {
  render(
    <MemoryRouter
      initialEntries={[{ pathname: "/checkout/confirmation", state }]}
    >
      <OrderConfirmationPage />
    </MemoryRouter>,
  );
}

const SUITE = { timeout: 30_000 };

afterEach(() => {
  cleanup();
  calledMethods.length = 0;
  vi.resetAllMocks();
});

describe("OrderConfirmationPage", SUITE, () => {
  it("shows the order checkout just placed without asking the API for it again", () => {
    givenSession();

    renderConfirmation({ order: order() });

    // The confirmation is the return value of the checkout call, so a second
    // round trip here would only add latency to a page the shopper is waiting
    // on. Nothing but the header's chips may be requested.
    expect(screen.getByRole("region", { name: "Order confirmation" })).toBeDefined();
    expect(calledMethods).toEqual(["listCatalogCategories"]);
  });

  it("shows the total and the line exactly as the order recorded them", () => {
    givenSession();

    renderConfirmation({ order: order() });

    const section = screen.getByRole("region", { name: "Order confirmation" });
    expect(within(section).getByRole("heading", { name: "Order 01955F00" })).toBeDefined();
    expect(section.textContent).toContain("Subtotal $25.00");
    expect(section.textContent).toContain("Total $25.00");
    expect(section.textContent).toContain("2 items");
    expect(within(section).getByRole("listitem").textContent).toContain(
      "Box Trailer · 12ft Box Trailer",
    );
    expect(screen.getByText("pending")).toBeDefined();
  });

  it("sends the shopper on to their history or back to the catalog", () => {
    givenSession();

    renderConfirmation({ order: order() });

    expect(screen.getByRole("link", { name: "View all orders" }).getAttribute("href")).toBe(
      "/orders",
    );
    expect(screen.getByRole("link", { name: "Continue shopping" }).getAttribute("href")).toBe(
      "/catalog",
    );
  });

  it("points at the order history when a reload has lost the placed order", () => {
    // A refresh or a bookmark lands here with no router state. The order
    // already exists server-side, so the honest answer is the history page,
    // not a fake summary and not a silent blank screen.
    givenSession();

    renderConfirmation(undefined);

    expect(screen.getByRole("heading", { name: "Nothing to show here yet" })).toBeDefined();
    expect(screen.getByRole("link", { name: "View my orders" }).getAttribute("href")).toBe(
      "/orders",
    );
    expect(screen.queryByRole("region", { name: "Order confirmation" })).toBeNull();
  });
});
