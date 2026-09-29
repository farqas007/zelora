import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ApiEnvelope, GetOrderEnvelope, OrderDetailDto, UserDto } from "@zelora/shared";
import { ApiClientError, type ZeloraApi } from "../lib/api/client";
import type { AuthContextValue } from "../context/AuthContext";
import { useAuth } from "../context/AuthContext";
import type { CartContextValue } from "../context/CartContext";
import { useCart } from "../context/CartContext";
import { OrderDetailPage } from "./OrderDetail";

/**
 * Page tests for a single order.
 *
 * The endpoint is scoped to the caller, so the page's job is to be honest
 * about what happens when the id in the URL is not the caller's: the response
 * is a not-found envelope and the page has to show the not-found state, never
 * another customer's data and never a raw server string. The id comes from the
 * route and nowhere else, so the request is asserted against the URL the
 * router was pointed at.
 */

vi.mock("../context/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../context/CartContext", () => ({ useCart: vi.fn() }));

const ORDER_ID = "01955f00-0000-7000-8000-0000000000c9";

function detail(overrides: Partial<OrderDetailDto> = {}): OrderDetailDto {
  return {
    id: ORDER_ID,
    status: "pending",
    currency: "USD",
    subtotalAmountCents: 2_500,
    shippingAmountCents: 500,
    discountAmountCents: 0,
    totalAmountCents: 3_000,
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
    addresses: [
      {
        kind: "shipping",
        recipientName: "Ada Lovelace",
        phone: "+44 20 7946 0958",
        line1: "1 Analytical Engine Parade",
        line2: null,
        city: "London",
        region: "Greater London",
        postalCode: "SW1A 1AA",
        countryCode: "GB",
      },
      {
        kind: "billing",
        recipientName: "Charles Babbage",
        phone: null,
        line1: "221B Billing Street",
        line2: null,
        city: "Cambridge",
        region: null,
        postalCode: null,
        countryCode: "GB",
      },
    ],
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

type Outcome<R> = R | Promise<R> | ((...args: unknown[]) => R | Promise<R>);

interface StubOptions {
  getOrder?: Outcome<GetOrderEnvelope>;
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
    getOrder: record<GetOrderEnvelope>("getOrder", ok(detail())),
  } as unknown as ZeloraApi;

  return { api, calls };
}

function givenOrders(options: StubOptions = {}): RecordedCall[] {
  const { api, calls } = createApiStub(options);
  vi.mocked(useAuth).mockReturnValue({
    api,
    status: "authenticated",
    user: shopper(),
    csrfToken: "csrf-token",
  } as unknown as AuthContextValue);
  vi.mocked(useCart).mockReturnValue({ itemCount: 0 } as unknown as CartContextValue);
  return calls;
}

/** Render the page at a given route, so `useParams` has something to read. */
function renderAt(route: string): void {
  render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/orders/:orderId" element={<OrderDetailPage />} />
        <Route path="/orders" element={<OrderDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const SUITE = { timeout: 30_000 };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("OrderDetailPage", SUITE, () => {
  it("reads the order named in the route and nothing else", async () => {
    const calls = givenOrders();

    renderAt(`/orders/${ORDER_ID}`);

    await screen.findByRole("region", { name: "Order" });
    expect(calls).toEqual([{ method: "getOrder", args: [ORDER_ID] }]);
  });

  it("shows the saved totals, the lines and both address snapshots", async () => {
    givenOrders();

    renderAt(`/orders/${ORDER_ID}`);

    const section = await screen.findByRole("region", { name: "Order" });
    expect(within(section).getByRole("heading", { name: "Order 01955F00" })).toBeDefined();
    expect(section.textContent).toContain("Subtotal $25.00");
    expect(section.textContent).toContain("Shipping $5.00");
    expect(section.textContent).toContain("Total $30.00");

    // The line keeps the name and price it had at checkout, which is the whole
    // point of snapshotting them: a later price change must not rewrite history.
    const line = within(section).getByRole("listitem");
    expect(line.textContent).toContain("Box Trailer · 12ft Box Trailer");
    expect(line.textContent).toContain("2 × $12.50");
    expect(line.textContent).toContain("$25.00");

    const shipping = within(section).getByRole("heading", { name: "Shipping address" })
      .parentElement as HTMLElement;
    expect(shipping.textContent).toContain("Ada Lovelace");
    expect(shipping.textContent).toContain("1 Analytical Engine Parade");
    expect(shipping.textContent).toContain("London");
    expect(shipping.textContent).toContain("SW1A 1AA");
    expect(shipping.textContent).toContain("GB");

    const billing = within(section).getByRole("heading", { name: "Billing address" })
      .parentElement as HTMLElement;
    expect(billing.textContent).toContain("Charles Babbage");
    expect(billing.textContent).toContain("221B Billing Street");
  });

  it("shows a not-found state when the id is not the caller's", async () => {
    // Another customer's order id is answered with a not-found envelope, so
    // this is the shape a customer probing other ids gets to see.
    givenOrders({
      getOrder: { ok: false, error: { code: "ORDER_NOT_FOUND", message: "Order not found." } },
    });

    renderAt("/orders/01955f00-0000-7000-8000-000000009999");

    expect(await screen.findByRole("heading", { name: "Order not found" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Order" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to my orders" }).getAttribute("href")).toBe(
      "/orders",
    );
  });

  it("never asks for an order when the route carries no id", async () => {
    const calls = givenOrders();

    renderAt("/orders");

    expect(await screen.findByRole("heading", { name: "Order not found" })).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("turns a transport fault into copy the shopper can act on", async () => {
    givenOrders({
      getOrder: () => Promise.reject(new ApiClientError("Unable to reach the Zelora API.", undefined)),
    });

    renderAt(`/orders/${ORDER_ID}`);

    const notFound = await screen.findByRole("heading", { name: "Order not found" });
    expect(notFound.parentElement?.textContent).toContain(
      "Unable to reach the server. Please check your connection and try again.",
    );
  });
});
