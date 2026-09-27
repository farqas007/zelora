import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type {
  AdminPendingSellersEnvelope,
  ApiEnvelope,
  PendingSellerDto,
  SellerActivationEnvelope,
  SellerProfileDto,
  SellerRejectionEnvelope,
  StoreDto,
  UserDto,
  UserRole,
} from "@zelora/shared";
import { createApiClient, type ZeloraApi } from "../lib/api/client";
import type { AuthContextValue, AuthStatus } from "../context/AuthContext";
import { useAuth } from "../context/AuthContext";
import { AdminSellersPage } from "./AdminSellers";

/**
 * Page tests for the admin seller review queue.
 *
 * The API is injected through the auth context the page already reads, so these
 * drive the real component against a recording double: the page's contract with
 * the client is the thing under test, and stubbing the module out would test
 * nothing. The one thing a double cannot prove — the paths, the method and the
 * CSRF header the new client methods actually send — is asserted separately
 * against the real client with `fetch` stubbed, as the image-manager suite does.
 */

vi.mock("../context/AuthContext", () => ({ useAuth: vi.fn() }));

const USER_ID = "01955f00-0000-7000-8000-0000000000b1";
const PROFILE_ID = "01955f00-0000-7000-8000-0000000000b2";
const STORE_ID = "01955f00-0000-7000-8000-0000000000b3";

const OTHER_USER_ID = "01955f00-0000-7000-8000-0000000000c1";
const OTHER_PROFILE_ID = "01955f00-0000-7000-8000-0000000000c2";
const OTHER_STORE_ID = "01955f00-0000-7000-8000-0000000000c3";

/** One application, using only fields the admin DTOs actually carry. */
function pendingSeller(overrides: Partial<PendingSellerDto> = {}): PendingSellerDto {
  return {
    sellerProfile: {
      id: PROFILE_ID,
      userId: USER_ID,
      slug: "farqas-tech",
      displayName: "Farqas Tech",
      status: "pending",
      createdAt: "2026-02-01T10:00:00.000Z",
    },
    user: {
      id: USER_ID,
      email: "farqas007@gmail.com",
      name: "Farqas",
      status: "active",
      createdAt: "2026-01-20T08:00:00.000Z",
    },
    store: {
      id: STORE_ID,
      name: "Farqas Tech Store",
      slug: "farqas-tech-store",
      description: "Desk setups and gadgets.",
      status: "draft",
      createdAt: "2026-02-01T10:00:00.000Z",
    },
    ...overrides,
  };
}

function secondPendingSeller(): PendingSellerDto {
  return {
    sellerProfile: {
      id: OTHER_PROFILE_ID,
      userId: OTHER_USER_ID,
      slug: "lantern-supply",
      displayName: "Lantern Supply",
      status: "pending",
      createdAt: "2026-02-03T12:00:00.000Z",
    },
    user: {
      id: OTHER_USER_ID,
      email: "lantern@example.com",
      name: "Lantern",
      status: "active",
      createdAt: "2026-01-25T09:00:00.000Z",
    },
    store: {
      id: OTHER_STORE_ID,
      name: "Lantern Supply Co",
      slug: "lantern-supply-co",
      description: null,
      status: "draft",
      createdAt: "2026-02-03T12:00:00.000Z",
    },
  };
}

/** Wrap a list in the success envelope the client returns. */
function ok<T>(data: T): ApiEnvelope<T> {
  return { ok: true, data };
}

/** A failure envelope, shaped as the API sends it. */
function failure(code: string, message: string): ApiEnvelope<never> {
  return { ok: false, error: { code, message } };
}

/** The active profile the activation endpoint returns. */
const ACTIVATED_PROFILE: SellerProfileDto = {
  id: PROFILE_ID,
  userId: USER_ID,
  slug: "farqas-tech",
  displayName: "Farqas Tech",
  status: "active",
};

const ACTIVATED_STORE: StoreDto = {
  id: STORE_ID,
  name: "Farqas Tech Store",
  slug: "farqas-tech-store",
  description: "Desk setups and gadgets.",
  status: "active",
};

/** The rejected profile the rejection endpoint returns. */
const REJECTED_PROFILE: SellerProfileDto = { ...ACTIVATED_PROFILE, status: "rejected" };

/**
 * A recording API double.
 *
 * Overrides are supplied as an *outcome* — a value, a promise, or a function of
 * the call arguments — rather than as a replacement function, so a test can both
 * control what an endpoint returns and assert on the calls that were made.
 */
interface StubOptions {
  listPendingSellers?: Outcome<AdminPendingSellersEnvelope>;
  activateSeller?: Outcome<SellerActivationEnvelope>;
  rejectSeller?: Outcome<SellerRejectionEnvelope>;
}

/** What an overridden method should resolve to. A function may also reject. */
type Outcome<R> = R | Promise<R> | ((...args: unknown[]) => R | Promise<R>);

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
    listPendingSellers: record<AdminPendingSellersEnvelope>(
      "listPendingSellers",
      ok({ items: [], nextCursor: null }),
    ),
    activateSeller: record<SellerActivationEnvelope>(
      "activateSeller",
      ok({ sellerProfile: ACTIVATED_PROFILE, store: ACTIVATED_STORE }),
    ),
    rejectSeller: record<SellerRejectionEnvelope>(
      "rejectSeller",
      ok(REJECTED_PROFILE),
    ),
  } as unknown as ZeloraApi;

  return { api, calls };
}

/** Methods that were called, in order, by name only. */
function methodNames(calls: readonly RecordedCall[]): string[] {
  return calls.map((call) => call.method);
}

/** Calls of one kind, in order. */
function callsTo(calls: readonly RecordedCall[], method: string): RecordedCall[] {
  return calls.filter((call) => call.method === method);
}

/** A promise plus its resolver, for holding a request open mid-assertion. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {
    throw new Error("resolve called before it was assigned");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function adminUser(): UserDto {
  return {
    id: "01955f00-0000-7000-8000-0000000000a1",
    email: "admin@zelora.test",
    name: "Zelora Admin",
    role: "admin",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Present the page with a session, as the auth provider would. */
function givenSession(
  api: ZeloraApi,
  { status = "authenticated", role = "admin" }: { status?: AuthStatus; role?: UserRole } = {},
): void {
  vi.mocked(useAuth).mockReturnValue({
    api,
    status,
    user: role === null ? null : { ...adminUser(), role },
  } as unknown as AuthContextValue);
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <AdminSellersPage />
    </MemoryRouter>,
  );
}

/** The card for one application, reached through its display name. */
async function applicationCard(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { level: 3, name });
  const card = heading.closest("li");
  if (card === null) {
    throw new Error("expected the application heading to sit inside its list item");
  }
  return card;
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("AdminSellersPage", () => {
  describe("identifying the page", () => {
    it("names itself as admin seller management", () => {
      const { api } = createApiStub();
      givenSession(api);

      renderPage();

      expect(
        screen.getByRole("heading", { level: 1, name: "Admin · Seller Management" }),
      ).toBeDefined();
      expect(
        screen.getByRole("heading", { level: 2, name: "Pending seller applications" }),
      ).toBeDefined();
    });

    it("states the empty queue rather than showing a blank page", async () => {
      const { api } = createApiStub();
      givenSession(api);

      renderPage();

      expect(
        await screen.findByText("There are no pending seller applications."),
      ).toBeDefined();
    });
  });

  describe("rendering the pending queue", () => {
    it("shows a loading state before the queue arrives", () => {
      const gate = deferred<AdminPendingSellersEnvelope>();
      const { api } = createApiStub({ listPendingSellers: () => gate.promise });
      givenSession(api);

      renderPage();

      expect(screen.getByText("Loading pending sellers…")).toBeDefined();
      expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
      gate.resolve(ok({ items: [], nextCursor: null }));
    });

    it("renders each application with the profile, owner and store the API returned", async () => {
      const { api } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
      });
      givenSession(api);

      renderPage();

      const card = await applicationCard("Farqas Tech");
      expect(within(card).getByText("/farqas-tech")).toBeDefined();
      expect(within(card).getByText("Farqas · farqas007@gmail.com")).toBeDefined();
      expect(within(card).getByText("Farqas Tech Store /farqas-tech-store")).toBeDefined();
      expect(within(card).getByText("draft")).toBeDefined();
      expect(within(card).getByText("pending")).toBeDefined();
      expect(within(card).getByText("Desk setups and gadgets.")).toBeDefined();
    });

    it("renders every application in the order the server sent", async () => {
      const { api } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller(), secondPendingSeller()], nextCursor: null }),
      });
      givenSession(api);

      renderPage();

      await applicationCard("Lantern Supply");
      const headings = screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent);
      expect(headings).toEqual(["Farqas Tech", "Lantern Supply"]);
    });

    it("offers an Activate and a Reject action for every application", async () => {
      const { api } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
      });
      givenSession(api);

      renderPage();

      await applicationCard("Farqas Tech");
      expect(
        screen.getByRole("button", { name: "Activate Farqas Tech" }),
      ).toBeDefined();
      expect(screen.getByRole("button", { name: "Reject Farqas Tech" })).toBeDefined();
    });

    it("omits the description row when the store has none", async () => {
      const { api } = createApiStub({
        listPendingSellers: ok({ items: [secondPendingSeller()], nextCursor: null }),
      });
      givenSession(api);

      renderPage();

      const card = await applicationCard("Lantern Supply");
      expect(within(card).getByText("draft")).toBeDefined();
      expect(screen.queryByText("No description added.")).toBeNull();
    });

    it("reports a queue that could not be loaded", async () => {
      const { api } = createApiStub({
        listPendingSellers: failure("UNAUTHENTICATED", "Your session has expired."),
      });
      givenSession(api);

      renderPage();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Your session has expired.");
      expect(screen.queryByRole("button", { name: /Activate|Reject/ })).toBeNull();
    });
  });

  describe("activating a seller", () => {
    it("addresses the decision to the owning user id, not the profile id", async () => {
      const { api, calls } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Activate Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Activate Farqas Tech" }));

      await waitFor(() => expect(callsTo(calls, "activateSeller")).toHaveLength(1));
      expect(callsTo(calls, "activateSeller")[0]!.args).toEqual([USER_ID]);
    });

    it("re-reads the queue after activating", async () => {
      const { api, calls } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Activate Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Activate Farqas Tech" }));

      await waitFor(() => expect(methodNames(calls)).toEqual([
        "listPendingSellers",
        "activateSeller",
        "listPendingSellers",
      ]));
    });

    it("drops the activated seller from the queue once the server re-reads", async () => {
      const { api } = createApiStub({
        listPendingSellers: vi
          .fn()
          .mockResolvedValueOnce(ok({ items: [pendingSeller()], nextCursor: null }))
          .mockResolvedValueOnce(ok({ items: [], nextCursor: null })),
        activateSeller: ok({ sellerProfile: ACTIVATED_PROFILE, store: ACTIVATED_STORE }),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Activate Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Activate Farqas Tech" }));

      await waitFor(() =>
        expect(screen.getByText("There are no pending seller applications.")).toBeDefined(),
      );
      expect(screen.queryByRole("button", { name: "Activate Farqas Tech" })).toBeNull();
    });

    it("confirms the activation", async () => {
      const { api } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Activate Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Activate Farqas Tech" }));

      expect(await screen.findByText("Activated Farqas Tech.")).toBeDefined();
    });

    it("reports a refused activation and leaves the queue untouched", async () => {
      const { api, calls } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
        activateSeller: failure("SELLER_ACTIVATION_BLOCKED", "This seller cannot be activated."),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Activate Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Activate Farqas Tech" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("This seller cannot be activated.");
      expect(screen.getByRole("button", { name: "Activate Farqas Tech" })).toBeDefined();
      // No re-read: the server never accepted the decision.
      expect(callsTo(calls, "listPendingSellers")).toHaveLength(1);
    });
  });

  describe("rejecting a seller", () => {
    it("addresses the decision to the owning user id, not the profile id", async () => {
      const { api, calls } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Reject Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Reject Farqas Tech" }));

      await waitFor(() => expect(callsTo(calls, "rejectSeller")).toHaveLength(1));
      expect(callsTo(calls, "rejectSeller")[0]!.args).toEqual([USER_ID]);
    });

    it("re-reads the queue after rejecting", async () => {
      const { api, calls } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Reject Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Reject Farqas Tech" }));

      await waitFor(() => expect(methodNames(calls)).toEqual([
        "listPendingSellers",
        "rejectSeller",
        "listPendingSellers",
      ]));
    });

    it("confirms the rejection", async () => {
      const { api } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Reject Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Reject Farqas Tech" }));

      expect(await screen.findByText("Rejected Farqas Tech.")).toBeDefined();
    });

    it("reports a blocked rejection", async () => {
      const { api } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
        rejectSeller: failure("SELLER_REJECTION_BLOCKED", "This seller profile cannot be rejected."),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Reject Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Reject Farqas Tech" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("cannot be rejected");
      expect(screen.getByRole("button", { name: "Reject Farqas Tech" })).toBeDefined();
    });

    it("keeps a decision on one application from affecting another", async () => {
      const gate = deferred<SellerRejectionEnvelope>();
      const { api, calls } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller(), secondPendingSeller()], nextCursor: null }),
        rejectSeller: () => gate.promise,
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Reject Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Reject Farqas Tech" }));
      await waitFor(() => expect(methodNames(calls)).toContain("rejectSeller"));

      fireEvent.click(screen.getByRole("button", { name: "Activate Lantern Supply" }));

      expect(methodNames(calls)).toEqual(["listPendingSellers", "rejectSeller"]);
      gate.resolve(ok(REJECTED_PROFILE));
      await waitFor(() => expect(methodNames(calls)).toEqual([
        "listPendingSellers",
        "rejectSeller",
        "listPendingSellers",
      ]));
    });
  });

  describe("while a decision is processing", () => {
    it("disables every decision control", async () => {
      const gate = deferred<SellerActivationEnvelope>();
      const { api } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller(), secondPendingSeller()], nextCursor: null }),
        activateSeller: () => gate.promise,
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Activate Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Activate Farqas Tech" }));

      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: "Activate Farqas Tech" }) as HTMLButtonElement).disabled,
        ).toBe(true),
      );
      for (const control of screen.getAllByRole("button")) {
        expect((control as HTMLButtonElement).disabled).toBe(true);
      }
      gate.resolve(ok({ sellerProfile: ACTIVATED_PROFILE, store: ACTIVATED_STORE }));
    });

    it("marks the running control as busy", async () => {
      const gate = deferred<SellerActivationEnvelope>();
      const { api } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
        activateSeller: () => gate.promise,
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Activate Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Activate Farqas Tech" }));

      await waitFor(() => expect(screen.getAllByText("Activating…")).toHaveLength(1));
      expect(screen.getByRole("button", { name: "Reject Farqas Tech" })).toBeDefined();
      gate.resolve(ok({ sellerProfile: ACTIVATED_PROFILE, store: ACTIVATED_STORE }));
      await waitFor(() => expect(screen.queryByText("Activating…")).toBeNull());
    });

    it("ignores a second submission while one is already running", async () => {
      const gate = deferred<SellerActivationEnvelope>();
      const { api, calls } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
        activateSeller: () => gate.promise,
      });
      givenSession(api);
      renderPage();
      const activate = await screen.findByRole("button", { name: "Activate Farqas Tech" });

      fireEvent.click(activate);
      // The control is disabled, but a fast double click can still land.
      fireEvent.click(activate);
      fireEvent.click(activate);

      await waitFor(() => expect(callsTo(calls, "activateSeller")).toHaveLength(1));
      expect(callsTo(calls, "listPendingSellers")).toHaveLength(1);
      gate.resolve(ok({ sellerProfile: ACTIVATED_PROFILE, store: ACTIVATED_STORE }));
      await waitFor(() => expect(callsTo(calls, "listPendingSellers")).toHaveLength(2));
      expect(callsTo(calls, "activateSeller")).toHaveLength(1);
    });
  });

  describe("honest reporting when the refresh fails", () => {
    it("does not claim success when the decision landed but the queue could not be re-read", async () => {
      const { api } = createApiStub({
        listPendingSellers: vi
          .fn()
          .mockResolvedValueOnce(ok({ items: [pendingSeller()], nextCursor: null }))
          .mockResolvedValueOnce(failure("INTERNAL_ERROR", "Something went wrong.")),
        activateSeller: ok({ sellerProfile: ACTIVATED_PROFILE, store: ACTIVATED_STORE }),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Activate Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Activate Farqas Tech" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("could not be refreshed");
      expect(screen.queryByText("Activated Farqas Tech.")).toBeNull();
      // The stale row is kept rather than guessed at.
      expect(screen.getByRole("button", { name: "Activate Farqas Tech" })).toBeDefined();
    });

    it("reports a transport failure without leaking a raw message", async () => {
      const { api } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
        activateSeller: () => Promise.reject(new Error("socket hangup")),
      });
      givenSession(api);
      renderPage();
      await screen.findByRole("button", { name: "Activate Farqas Tech" });

      fireEvent.click(screen.getByRole("button", { name: "Activate Farqas Tech" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Something went wrong");
      expect(alert.textContent).not.toContain("socket hangup");
    });
  });

  describe("non-admin access", () => {
    it("loads nothing and renders no applications for a non-admin user", async () => {
      const { api, calls } = createApiStub({
        listPendingSellers: ok({ items: [pendingSeller()], nextCursor: null }),
      });
      givenSession(api, { role: "customer" });

      renderPage();

      await waitFor(() => expect(methodNames(calls)).toEqual([]));
      expect(screen.queryByText("Farqas Tech")).toBeNull();
      expect(screen.queryByRole("button", { name: /Activate|Reject/ })).toBeNull();
    });
  });
});

describe("the admin client methods", () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("reads the queue with a GET carrying no CSRF header", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(jsonResponse(ok({ items: [], nextCursor: null }))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient({ getCsrfToken: () => "csrf-token" });

    await api.listPendingSellers({ limit: 20, cursor: "c1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3001/api/admin/sellers/pending?limit=20&cursor=c1");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-Zelora-CSRF"]).toBeUndefined();
  });

  it("omits the query string entirely when nothing is passed", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(jsonResponse(ok({ items: [], nextCursor: null }))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient({ getCsrfToken: () => "csrf-token" });

    await api.listPendingSellers();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3001/api/admin/sellers/pending");
  });

  it("posts a decision to the encoded user id with the CSRF token", async () => {
    const fetchMock = vi.fn((url: string, _init: RequestInit) =>
      Promise.resolve(
        jsonResponse(
          url.includes("/activate")
            ? ok({ sellerProfile: ACTIVATED_PROFILE, store: ACTIVATED_STORE })
            : ok(REJECTED_PROFILE),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient({ getCsrfToken: () => "csrf-token" });

    await api.activateSeller(USER_ID);
    await api.rejectSeller(USER_ID);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3001/api/admin/sellers/${USER_ID}/activate`,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://localhost:3001/api/admin/sellers/${USER_ID}/reject`,
    );
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
      expect((init.headers as Record<string, string>)["X-Zelora-CSRF"]).toBe("csrf-token");
    }
  });
});
