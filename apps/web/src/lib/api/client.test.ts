import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, CSRF_HEADER } from "./client";
import type { ZeloraApi } from "./client";

/**
 * Transport-level tests for the order and cart methods of the real client.
 *
 * The pages inject a `ZeloraApi` double, so a double can never prove what a
 * method actually puts on the wire: the path, the method, the query string and
 * the CSRF header. These run the real client with `fetch` stubbed and assert
 * exactly that, and nothing more. The doubles stay free to answer with any
 * envelope, which is the point — the shapes are the pages' concern, the wiring
 * is the client's.
 */

const BASE_URL = "http://localhost:3001";
const CSRF_TOKEN = "csrf-token";

/** A client whose token provider always returns `token`. */
function client(token: string | null = CSRF_TOKEN): ZeloraApi {
  return createApiClient({ baseUrl: BASE_URL, getCsrfToken: () => token });
}

/**
 * Replace `fetch` with a stub that answers every call with `payload`, and
 * return the stub so a test can read back the request it captured.
 */
function stubFetch(payload: unknown = { ok: true, data: null }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The first request the stub captured, as the parts under test. */
function firstRequest(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
} {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body as string | undefined,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("orders client", () => {
  it("sends no query string at all when no paging options are given", async () => {
    // An empty `?` would be a different URL to the API's router, and a
    // `cursor=` of "" is a *different value* from an absent cursor, so the
    // client has to omit both rather than send them empty.
    const fetchMock = stubFetch();

    await client().listOrders();

    expect(firstRequest(fetchMock).url).toBe(`${BASE_URL}/api/orders`);
  });

  it("sends the limit and the opaque cursor verbatim", async () => {
    // The cursor is a keyset value containing colons and a millisecond
    // timestamp. It is a query parameter, not a path segment, so it is
    // URL-encoded as a parameter and must survive the round trip unchanged.
    const fetchMock = stubFetch();

    await client().listOrders({ limit: 10, cursor: "1772345678901:01955f00-0000-7000-8000-0000000000c9" });

    const { url } = firstRequest(fetchMock);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/orders");
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect(parsed.searchParams.get("cursor")).toBe("1772345678901:01955f00-0000-7000-8000-0000000000c9");
  });

  it("omits an empty cursor rather than sending a blank one", async () => {
    const fetchMock = stubFetch();

    await client().listOrders({ limit: 25, cursor: "" });

    const { url } = firstRequest(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/orders?limit=25`);
  });

  it("reads an order by id without encoding the path segment unnecessarily", async () => {
    const fetchMock = stubFetch();

    await client().getOrder("01955f00-0000-7000-8000-0000000000c9");

    const { url, method } = firstRequest(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/orders/01955f00-0000-7000-8000-0000000000c9`);
    expect(method).toBe("GET");
  });

  it("percent-encodes an order id so a hostile id cannot escape the path", async () => {
    // Ownership is enforced server-side, so this is about routing integrity:
    // an id containing a slash must not address a different resource.
    const fetchMock = stubFetch();

    await client().getOrder("../../admin/sellers");

    expect(firstRequest(fetchMock).url).toBe(
      `${BASE_URL}/api/orders/..%2F..%2Fadmin%2Fsellers`,
    );
  });

  it("posts the checkout body under the CSRF header", async () => {
    // Placing an order changes server state, so it is the one order call that
    // must carry the synchronizer token.
    const fetchMock = stubFetch();
    const shippingAddress = {
      recipientName: "Ada Lovelace",
      phone: "+44 20 7946 0958",
      line1: "1 Analytical Engine Parade",
      city: "London",
      region: "Greater London",
      postalCode: "SW1A 1AA",
      countryCode: "GB",
    };

    await client().placeOrder({ shippingAddress });

    const { url, method, headers, body } = firstRequest(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/orders`);
    expect(method).toBe("POST");
    expect(headers[CSRF_HEADER]).toBe(CSRF_TOKEN);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(body!)).toEqual({ shippingAddress });
  });

  it("sends the CSRF token only on the mutating order call", async () => {
    const fetchMock = stubFetch();

    await client().getOrder("01955f00-0000-7000-8000-0000000000c9");

    expect(firstRequest(fetchMock).headers[CSRF_HEADER]).toBeUndefined();
  });

  it("omits the CSRF header when there is no session token to send", async () => {
    // The header is better absent than empty: the API's CSRF guard rejects a
    // present-but-blank token the same as a missing one, but a blank one reads
    // as a client that thought it had a session.
    const fetchMock = stubFetch();

    await client(null).placeOrder({
      shippingAddress: {
        recipientName: "Ada Lovelace",
        line1: "1 Analytical Engine Parade",
        city: "London",
        postalCode: "SW1A 1AA",
        countryCode: "GB",
      },
    });

    expect(CSRF_HEADER in firstRequest(fetchMock).headers).toBe(false);
  });
});

describe("cart client", () => {
  it("patches a quantity at the item's own path, CSRF-protected", async () => {
    const fetchMock = stubFetch();

    await client().updateCartItemQuantity("01955f00-0000-7000-8000-0000000000d1", { quantity: 3 });

    const { url, method, headers, body } = firstRequest(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/cart/items/01955f00-0000-7000-8000-0000000000d1`);
    expect(method).toBe("PATCH");
    expect(headers[CSRF_HEADER]).toBe(CSRF_TOKEN);
    expect(JSON.parse(body!)).toEqual({ quantity: 3 });
  });

  it("removes an item with DELETE and no request body", async () => {
    const fetchMock = stubFetch();

    await client().removeCartItem("01955f00-0000-7000-8000-0000000000d1");

    const { url, method, body } = firstRequest(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/cart/items/01955f00-0000-7000-8000-0000000000d1`);
    expect(method).toBe("DELETE");
    expect(body).toBeUndefined();
  });

  it("always asks for the cookie to ride along, so the session is sent", async () => {
    // The session is HttpOnly and therefore invisible to this module; the only
    // way it reaches the API is `credentials: "include"` on every call.
    const fetchMock = stubFetch();

    await client().getCart();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("include");
  });
});
