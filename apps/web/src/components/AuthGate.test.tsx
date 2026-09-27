import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { UserDto, UserRole } from "@zelora/shared";
import type { AuthContextValue, AuthStatus } from "../context/AuthContext";
import { useAuth } from "../context/AuthContext";
import { RequireAdmin, RequireAuth } from "./AuthGate";

/**
 * Route guard tests.
 *
 * `useAuth` is the only seam: the guards are pure functions of the resolved
 * session, and the real provider would only re-test that a `fetch` answered.
 * Everything else — the redirect targets, the loading branch — is the guards'
 * own behaviour and is exercised for real through the router, so a test fails if
 * a guard ever stops rendering its children or starts rendering them too early.
 */

vi.mock("../context/AuthContext", () => ({ useAuth: vi.fn() }));

const EMAIL = "farqas007@gmail.com";

function userWithRole(role: UserRole): UserDto {
  return {
    id: "01955f00-0000-7000-8000-0000000000a1",
    email: EMAIL,
    name: "Farqas",
    role,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Present the guards with a resolved session, as the provider would. */
function givenSession(status: AuthStatus, role: UserRole | null = null): void {
  vi.mocked(useAuth).mockReturnValue({
    status,
    user: role === null ? null : userWithRole(role),
  } as unknown as AuthContextValue);
}

/** Mount the admin route behind a guard, with the two redirect targets. */
function renderAdminRoute(): void {
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <p>Admin seller management</p>
            </RequireAdmin>
          }
        />
        <Route path="/dashboard" element={<p>Dashboard</p>} />
        <Route path="/login" element={<p>Sign in</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Mount a seller-only route behind the existing `RequireAuth` guard. */
function renderSellerRoute(): void {
  render(
    <MemoryRouter initialEntries={["/seller/products"]}>
      <Routes>
        <Route
          path="/seller/products"
          element={
            <RequireAuth>
              <p>Seller products</p>
            </RequireAuth>
          }
        />
        <Route path="/dashboard" element={<p>Dashboard</p>} />
        <Route path="/login" element={<p>Sign in</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("RequireAdmin", () => {
  it("renders the admin page for an authenticated administrator", () => {
    givenSession("authenticated", "admin");

    renderAdminRoute();

    expect(screen.getByText("Admin seller management")).toBeDefined();
  });

  it("sends a signed-out visitor to the sign-in page", () => {
    givenSession("signed-out");

    renderAdminRoute();

    expect(screen.getByText("Sign in")).toBeDefined();
    expect(screen.queryByText("Admin seller management")).toBeNull();
  });

  it("waits for the session instead of redirecting while it is loading", () => {
    givenSession("loading");

    renderAdminRoute();

    expect(screen.getByText("Checking session…")).toBeDefined();
    expect(screen.queryByText("Admin seller management")).toBeNull();
  });

  it("sends a customer away from the admin page", () => {
    givenSession("authenticated", "customer");

    renderAdminRoute();

    expect(screen.getByText("Dashboard")).toBeDefined();
    expect(screen.queryByText("Admin seller management")).toBeNull();
  });

  it("sends a seller away from the admin page", () => {
    // Seller tooling is not admin tooling: an approved seller is still refused.
    givenSession("authenticated", "seller");

    renderAdminRoute();

    expect(screen.getByText("Dashboard")).toBeDefined();
    expect(screen.queryByText("Admin seller management")).toBeNull();
  });

  it("refuses an authenticated session that carries no user", () => {
    // Defence in depth: an authenticated-but-empty session is not an admin.
    givenSession("authenticated", null);

    renderAdminRoute();

    expect(screen.queryByText("Admin seller management")).toBeNull();
  });
});

describe("RequireAuth", () => {
  it("still renders a protected page for any authenticated role", () => {
    givenSession("authenticated", "customer");

    renderSellerRoute();

    expect(screen.getByText("Seller products")).toBeDefined();
  });

  it("still sends a signed-out visitor to the sign-in page", () => {
    givenSession("signed-out");

    renderSellerRoute();

    expect(screen.getByText("Sign in")).toBeDefined();
  });
});
