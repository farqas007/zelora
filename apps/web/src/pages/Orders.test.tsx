import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ApiEnvelope, ListOrdersEnvelope, OrderSummaryDto, UserDto } from "@zelora/shared";
import { ApiFailureError, type ZeloraApi } from "../lib/api/client";
import type { AuthContextValue } from "../context/AuthContext";
import { useAuth } from "../context/AuthContext";
import type { CartContextValue } from "../context/CartContext";
import { useCart } from "../context/CartContext";
import { OrdersPage } from "./Orders";

/**
 * Page tests for the customer's order history.
 *
 * Two things are worth pinning down here. The list is keyset-paginated, so the
 * cursor the API hands back has to be sent back unchanged — a page that re-sent
 * a stale cursor would loop on the same rows. And the page only ever asks for
 * its own orders: the request is a bare `GET /api/orders` with no user id in
 * it, because scoping happens server-side against the session.
 */

vi.mock("../context/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../context/CartContext", () => ({ useCart: vi.fn() }));

const FIRST_PAGE_CURSOR = "1772345678901:01955f00-0000-7000-8000-0000000000c9";

function order(overrides: Partial<OrderSummaryDto> = {}): OrderSummaryDto {
  return {
    id: "01955f00-0000-7000-8000-0000000000c9",
    status: "pending",
    currency: "USD",
    subtotalAmountCents: 2_500,
    shippingAmountCents: 0,
    discountAmountCents: 0,
    totalAmountCents: 2_500,
    itemCount: 2,
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-01T10:00:00.000Z",
    items: [],
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
  listOrders?: Outcome<ListOrdersEnvelope>;
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
    listOrders: record<ListOrdersEnvelope>(
      "listOrders",
      ok({ items: [order()], nextCursor: null }),
    ),
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

function renderPage(): void {
  render(
    <MemoryRouter>
      <OrdersPage />
    </MemoryRouter>,
  );
}

/** Calls to `listOrders`, as the query objects the page sent them. */
function listOrdersCalls(calls: readonly RecordedCall[]): unknown[] {
  return calls.filter((call) => call.method === "listOrders").map((call) => call.args[0]);
}

/**
 * Rows of the order list itself. Scoped deliberately: the shared header also
 * renders `<li>` elements for its account menu, so a page-wide listitem query
 * would count chrome as orders.
 */
function orderRows(): HTMLElement[] {
  const list = document.querySelector("ul.order-list");
  if (list === null) {
    return [];
  }
  return within(list as HTMLElement).queryAllByRole("listitem");
}

const SUITE = { timeout: 30_000 };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("OrdersPage", SUITE, () => {
  it("asks for the first page by size alone, never naming a user", async () => {
    // Ownership is enforced from the session, so a user id on the wire would
    // be a parameter the page has no business sending.
    const calls = givenOrders();

    renderPage();

    await screen.findByRole("link", { name: "Order 01955F00" });
    expect(listOrdersCalls(calls)).toEqual([{ limit: 10 }]);
  });

  it("gives each order a row with its short id, total, item count and status", async () => {
    givenOrders({
      listOrders: ok({
        items: [
          order({ id: "01955f00-0000-7000-8000-0000000000c9", totalAmountCents: 2_500, itemCount: 2 }),
          order({
            id: "01955f11-0000-7000-8000-0000000000ca",
            status: "cancelled",
            totalAmountCents: 4_999,
            itemCount: 1,
          }),
        ],
        nextCursor: null,
      }),
    });

    renderPage();

    await screen.findByRole("link", { name: "Order 01955F00" });
    const rows = orderRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "Order 01955F00" }).getAttribute("href")).toBe(
      "/orders/01955f00-0000-7000-8000-0000000000c9",
    );
    expect(rows[0]!.textContent).toContain("$25.00");
    expect(rows[0]!.textContent).toContain("2 items");
    expect(rows[0]!.textContent).toContain("pending");
    expect(rows[1]!.textContent).toContain("$49.99");
    expect(rows[1]!.textContent).toContain("1 item");
    expect(rows[1]!.textContent).toContain("cancelled");
  });

  it("appends the next page behind the cursor the API returned", async () => {
    const calls = givenOrders({
      listOrders: (request: unknown) => {
        const { cursor } = request as { cursor?: string };
        return cursor === undefined
          ? ok({ items: [order()], nextCursor: FIRST_PAGE_CURSOR })
          : ok({
              items: [order({ id: "01955f11-0000-7000-8000-0000000000ca", totalAmountCents: 100 })],
              nextCursor: null,
            });
      },
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    await screen.findByRole("link", { name: "Order 01955F00" });
    await waitFor(() => expect(orderRows()).toHaveLength(2));
    expect(listOrdersCalls(calls)).toEqual([
      { limit: 10 },
      { limit: 10, cursor: FIRST_PAGE_CURSOR },
    ]);
    // The control disappears once the API stops handing out a cursor, so a
    // shopper cannot page past the end of their own history.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps the rows it already has when the next page fails", async () => {
    givenOrders({
      listOrders: (request: unknown) => {
        const { cursor } = request as { cursor?: string };
        return cursor === undefined
          ? ok({ items: [order()], nextCursor: FIRST_PAGE_CURSOR })
          : { ok: false, error: { code: "VALIDATION_ERROR", message: "That cursor is no longer valid." } };
      },
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(orderRows()).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Order 01955F00" })).toBeDefined();
  });

  it("invites a first-time shopper to the catalog when there are no orders", async () => {
    givenOrders({ listOrders: ok({ items: [], nextCursor: null }) });

    renderPage();

    expect(await screen.findByRole("heading", { name: "No orders yet" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("explains a dropped session in the shopper's own words", async () => {
    givenOrders({
      listOrders: () =>
        Promise.reject(
          new ApiFailureError({ code: "SESSION_EXPIRED", message: "raw server wording" }),
        ),
    });

    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Your session has expired. Please sign in again.");
    expect(orderRows()).toHaveLength(0);
  });
});
