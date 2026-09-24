import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { CatalogCategoryDto } from "@zelora/shared";
import { useAuth } from "../context/AuthContext";
import { useCart } from "../context/CartContext";

/**
 * Storefront chrome: brand, search, account actions and the quick category
 * chips. The nav chips are live links pulled from the public catalog API and
 * hidden entirely while the catalog is empty or unreachable, so a storefront
 * without categories never renders dead navigation. The cart link carries a
 * live item-count badge fed by {@link useCart}; the count reflects every
 * add/update/remove/clear across the marketplace.
 */
export function MarketHeader() {
  const { api, status, user } = useAuth();
  const { itemCount } = useCart();
  const navigate = useNavigate();
  const [categories, setCategories] = useState<CatalogCategoryDto[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadCategories(): Promise<void> {
      try {
        const envelope = await api.listCatalogCategories();
        if (!cancelled && envelope.ok) {
          setCategories(envelope.data);
        }
      } catch {
        // The grid still works without the chips; just show no nav.
      }
    }

    void loadCategories();
    return () => {
      cancelled = true;
    };
  }, [api]);

  function onSearchSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    navigate("/catalog");
  }

  return (
    <>
      <header className="market-header">
        <div className="market-header-inner">
          <Link className="brand" to="/">
            <img
              className="brand-logo"
              src="/assets/zelora-logo.svg"
              alt="Zelora"
              width="132"
              height="34"
            />
          </Link>

          <form className="header-search" role="search" onSubmit={onSearchSubmit}>
            <label className="sr-only" htmlFor="market-search">
              Search products
            </label>
            <input
              id="market-search"
              className="search-input"
              type="search"
              placeholder="Search products"
              aria-label="Search products"
            />
            <button type="submit" className="search-button">
              <SearchIcon />
              <span>Search</span>
            </button>
          </form>

          <div className="header-actions">
            {status === "loading" && <span className="muted">Account…</span>}
            {status === "signed-out" && (
              <>
                <Link className="header-link" to="/login">
                  Sign in
                </Link>
                <Link className="btn btn-primary btn-sm" to="/register">
                  Create account
                </Link>
              </>
            )}
            {status === "authenticated" && user !== null && (
              <Link className="account-link" to="/dashboard">
                <UserIcon />
                <span className="account-name">{user.name}</span>
              </Link>
            )}
            <Link className="btn btn-sm cart-button" to="/cart">
              <CartIcon />
              <span>Cart</span>
              {itemCount > 0 && (
                <span className="cart-count" aria-label={`${itemCount} items in cart`}>
                  {itemCount > 99 ? "99+" : itemCount}
                </span>
              )}
            </Link>
          </div>
        </div>
      </header>

      {categories !== null && categories.length > 0 && (
        <nav className="categories" aria-label="Categories" id="categories">
          <div className="categories-inner">
            {categories.map((category) => (
              <Link key={category.id} className="category-chip" to={`/catalog?category=${category.slug}`}>
                {category.name}
              </Link>
            ))}
          </div>
        </nav>
      )}
    </>
  );
}

function SearchIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function CartIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

function UserIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}