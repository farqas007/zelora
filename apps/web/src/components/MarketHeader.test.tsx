import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ApiEnvelope, CatalogCategoryDto, UserDto } from "@zelora/shared";
import type { ZeloraApi } from "../lib/api/client";
import type { AuthContextValue, AuthStatus } from "../context/AuthContext";
import { useAuth } from "../context/AuthContext";
import type { CartContextValue } from "../context/CartContext";
import { useCart } from "../context/CartContext";
import { MarketHeader } from "./MarketHeader";

/**
 * Structural tests for the marketplace header.
 *
 * The regression these guard against is layout, not logic: the category chips
 * used to render as a sibling `<nav>` *after* the sticky `<header>`, so they
 * scrolled away independently of the header and reappeared on scroll-up.
 * `position: sticky` only inherits through the DOM, so the fix — and its
 * verification — is a matter of where the chips are rendered. Only the two
 * data hooks are stubbed; routing is the real `MemoryRouter` so the rendered
 * links stay honest.
 */

vi.mock("../context/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../context/CartContext", () => ({ useCart: vi.fn() }));

const CATEGORIES: CatalogCategoryDto[] = [
  { id: "cat-audio", slug: "audio", name: "Audio" },
  { id: "cat-gaming", slug: "gaming", name: "Gaming" },
  { id: "cat-home", slug: "home-living", name: "Home & Living" },
];

function marketUser(): UserDto {
  return {
    id: "01955f00-0000-7000-8000-0000000000a1",
    email: "shopper@zelora.test",
    name: "Farqas",
    role: "customer",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Serve the given categories from the catalog endpoint the header calls. */
function givenCategories(categories: CatalogCategoryDto[] | "error"): ZeloraApi {
  const api = {
    listCatalogCategories: (): Promise<ApiEnvelope<CatalogCategoryDto[]>> =>
      categories === "error"
        ? Promise.reject(new Error("catalog unreachable"))
        : Promise.resolve({ ok: true, data: categories }),
  } as unknown as ZeloraApi;

  vi.mocked(useAuth).mockReturnValue({
    api,
    status: "signed-out",
    user: null,
  } as unknown as AuthContextValue);

  return api;
}

function givenSession(
  api: ZeloraApi,
  status: AuthStatus = "authenticated",
  user: UserDto | null = null,
): void {
  vi.mocked(useAuth).mockReturnValue({
    api,
    status,
    user: status === "authenticated" ? (user ?? marketUser()) : null,
  } as unknown as AuthContextValue);
}

function givenCart(itemCount = 0): void {
  vi.mocked(useCart).mockReturnValue({ itemCount } as unknown as CartContextValue);
}

/** The one sticky header element every part of the chrome must live inside. */
function marketHeader(): HTMLElement {
  const header = document.querySelector("header.market-header");
  if (header === null) {
    throw new Error("expected the marketplace header to be rendered");
  }
  return header as HTMLElement;
}

async function renderHeader(): Promise<HTMLElement> {
  render(
    <MemoryRouter>
      <MarketHeader />
    </MemoryRouter>,
  );
  return marketHeader();
}

/** Wait for the chips the header fetches on mount. */
async function findCategoryNav(): Promise<HTMLElement> {
  const nav = await screen.findByRole("navigation", { name: "Categories" });
  return nav as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("MarketHeader", () => {
  describe("header structure", () => {
    it("renders the category navigation inside the sticky marketplace header", async () => {
      givenCategories(CATEGORIES);
      givenCart();

      const header = await renderHeader();
      const nav = await findCategoryNav();

      // The chip nav used to be a sibling of <header>, which is what made it
      // scroll away on its own. It must now be inside the header subtree.
      expect(header.contains(nav)).toBe(true);
      expect(nav.closest("header.market-header")).toBe(header);
    });

    it("keeps the logo, category chips, search and account actions in one header row", async () => {
      givenCategories(CATEGORIES);
      givenCart();

      const header = await renderHeader();
      const nav = await findCategoryNav();

      // One shared flex row, ordered [Logo] [Categories] [Search] [Account] [Cart].
      const row = header.querySelector(".market-header-inner");
      if (row === null) {
        throw new Error("expected the header to contain its layout row");
      }
      expect(
        Array.from(row.children).map((child) => child.className.split(" ").at(0)),
      ).toEqual(["brand", "categories", "header-search", "header-actions"]);

      const logo = within(header).getByRole("img", { name: "Zelora" });
      const search = within(header).getByRole("search");
      const actions = within(header).getByRole("link", { name: "Cart" });

      // The brand is leftmost, and every part sits inside the same row.
      expect(row.firstElementChild?.contains(logo)).toBe(true);
      expect(row.contains(nav)).toBe(true);
      expect(row.contains(search)).toBe(true);
      expect(row.lastElementChild?.contains(actions)).toBe(true);
      expect(search.contains(screen.getByRole("searchbox", { name: "Search products" }))).toBe(
        true,
      );
    });

    it("renders a link per category, pointing at that category's catalog page", async () => {
      givenCategories(CATEGORIES);
      givenCart();

      const header = await renderHeader();
      const nav = await findCategoryNav();

      for (const category of CATEGORIES) {
        const link = within(nav).getByRole("link", { name: category.name });
        expect(link.getAttribute("href")).toBe(`/catalog?category=${category.slug}`);
      }
      expect(within(header).getAllByRole("link")).toHaveLength(
        CATEGORIES.length + 4, // brand + category chips + Sign in + Create account + Cart
      );
    });

    it("does not claim the homepage section's `categories` id", async () => {
      givenCategories(CATEGORIES);
      givenCart();

      const header = await renderHeader();
      await findCategoryNav();

      // `id="categories"` belongs to the homepage "Popular categories" section
      // (App.tsx). The header nav is reached by its accessible name instead, so
      // the two can never collide into a duplicate id in the same document.
      expect(header.querySelector("#categories")).toBeNull();
      expect(document.querySelectorAll("nav#categories")).toHaveLength(0);
    });
  });

  describe("existing behaviour preserved", () => {
    it("omits the category nav entirely when the catalog is empty", async () => {
      givenCategories([]);
      givenCart();

      const header = await renderHeader();

      await vi.waitFor(() => {
        expect(screen.queryByRole("navigation", { name: "Categories" })).toBeNull();
      });
      expect(within(header).getByRole("img", { name: "Zelora" })).toBeDefined();
    });

    it("omits the category nav when the catalog request fails", async () => {
      givenCategories("error");
      givenCart();

      const header = await renderHeader();

      await vi.waitFor(() => {
        expect(screen.queryByRole("navigation", { name: "Categories" })).toBeNull();
      });
      expect(within(header).getByRole("search")).toBeDefined();
    });

    it("still shows the sign-in and cart actions for a signed-out shopper", async () => {
      givenCategories(CATEGORIES);
      givenCart();

      const header = await renderHeader();
      await findCategoryNav();

      expect(within(header).getByRole("link", { name: "Sign in" })).toBeDefined();
      expect(within(header).getByRole("link", { name: "Create account" })).toBeDefined();
      expect(within(header).getByRole("link", { name: "Cart" })).toBeDefined();
      expect(screen.queryByRole("link", { name: /Farqas/ })).toBeNull();
    });

    it("still shows the signed-in account and the live cart badge", async () => {
      const api = givenCategories(CATEGORIES);
      givenSession(api, "authenticated");
      givenCart(3);

      const header = await renderHeader();
      await findCategoryNav();

      expect(within(header).getByRole("link", { name: /Farqas/ })).toBeDefined();
      expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
      expect(screen.getByLabelText("3 items in cart")).toBeDefined();
    });

    it("shows the orders link for an authenticated shopper, pointing at order history", async () => {
      const api = givenCategories(CATEGORIES);
      givenSession(api, "authenticated");
      givenCart();

      const header = await renderHeader();
      await findCategoryNav();

      const orders = within(header).getByRole("link", { name: "Orders" });
      expect(orders.getAttribute("href")).toBe("/orders");
      expect(within(header).getAllByRole("link")).toContain(orders);
    });

    it("hides the orders link for a signed-out shopper", async () => {
      givenCategories(CATEGORIES);
      givenCart();

      await renderHeader();
      await findCategoryNav();

      expect(screen.queryByRole("link", { name: "Orders" })).toBeNull();
    });
  });
});
