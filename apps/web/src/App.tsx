import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ApiEnvelope, HealthResponse } from "@zelora/shared";
import { useAuth } from "./context/AuthContext";

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

type ApiStatus = "checking" | "online" | "offline";

interface ApiHealthState {
  status: ApiStatus;
  health: HealthResponse | null;
}

const INITIAL_STATE: ApiHealthState = { status: "checking", health: null };

const CATEGORIES = [
  "Fashion & Apparel",
  "Electronics & Gadgets",
  "Beauty & Personal Care",
  "Home & Living",
  "Food & Groceries",
  "Sports & Outdoors",
  "Toys & Kids",
  "Health & Wellness",
] as const;

const FEATURED_SLOTS = [
  { label: "Spotlight", blurb: "Hand-picked products from our community of sellers." },
  { label: "New arrivals", blurb: "Fresh listings will appear here as sellers go live." },
  { label: "Top deals", blurb: "Promotions and special offers will land here soon." },
  { label: "Local picks", blurb: "Great finds from sellers in your area." },
] as const;

type IconProps = { size?: number };

function CatIcon({ size = 22, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
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

function PackageIcon({ size = 20 }: { size?: number }) {
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
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function StoreIcon({ size = 24 }: { size?: number }) {
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
      <path d="M3 9l1-5h16l1 5" />
      <path d="M3 9a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0" />
      <path d="M5 21h14a1 1 0 0 0 1-1v-7H4v7a1 1 0 0 0 1 1z" />
    </svg>
  );
}

function HeartIcon({ size = 18 }: { size?: number }) {
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
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" />
    </svg>
  );
}

function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function NodeOrnament({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 140 100"
      width="140"
      height="100"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M18 74 62 30 118 52"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.45"
      />
      <circle cx="18" cy="74" r="4" fill="var(--accent)" />
      <circle cx="62" cy="30" r="5" fill="var(--pink)" />
      <circle cx="118" cy="52" r="3" fill="var(--accent)" />
    </svg>
  );
}

function CategoryIcon({ name, size = 22 }: { name: string } & IconProps) {
  switch (name) {
    case "Fashion & Apparel":
      return (
        <CatIcon size={size}>
          <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" />
        </CatIcon>
      );
    case "Electronics & Gadgets":
      return (
        <CatIcon size={size}>
          <path d="M3 14h3a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7a9 9 0 0 1 18 0v7a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1" />
        </CatIcon>
      );
    case "Beauty & Personal Care":
      return (
        <CatIcon size={size}>
          <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
        </CatIcon>
      );
    case "Home & Living":
      return (
        <CatIcon size={size}>
          <path d="M3 9l9-7 9 7v10a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2V9z" />
        </CatIcon>
      );
    case "Food & Groceries":
      return (
        <CatIcon size={size}>
          <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
          <path d="M7 2v20" />
          <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7" />
        </CatIcon>
      );
    case "Sports & Outdoors":
      return (
        <CatIcon size={size}>
          <path d="m6.5 6.5 11 11" />
          <path d="m21 21-1-1" />
          <path d="m3 3 1 1" />
          <path d="m18 22 4-4" />
          <path d="m2 6 4-4" />
          <path d="m3 10 7-7" />
          <path d="m14 21 7-7" />
        </CatIcon>
      );
    case "Toys & Kids":
      return (
        <CatIcon size={size}>
          <line x1="6" y1="12" x2="10" y2="12" />
          <line x1="8" y1="10" x2="8" y2="14" />
          <line x1="15" y1="13" x2="15.01" y2="13" />
          <line x1="18" y1="11" x2="18.01" y2="11" />
          <rect x="2" y="6" width="20" height="12" rx="2" />
        </CatIcon>
      );
    case "Health & Wellness":
      return (
        <CatIcon size={size}>
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" />
          <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
        </CatIcon>
      );
    default:
      return <PackageIcon size={size} />;
  }
}

export function App() {
  const { status, user } = useAuth();
  const [healthState, setHealthState] = useState<ApiHealthState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth(): Promise<void> {
      try {
        const response = await fetch(`${API_BASE_URL}/api/health`);
        if (!response.ok) {
          throw new Error(`Unexpected status ${response.status}`);
        }
        const body = (await response.json()) as ApiEnvelope<HealthResponse>;
        if (cancelled) return;
        if (body.ok) {
          setHealthState({ status: "online", health: body.data });
        } else {
          setHealthState({ status: "offline", health: null });
        }
      } catch {
        if (!cancelled) {
          setHealthState({ status: "offline", health: null });
        }
      }
    }

    void checkHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  function onSearchSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

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
            <label className="sr-only" htmlFor="home-search">
              Search products
            </label>
            <input
              id="home-search"
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
            <button
              type="button"
              className="btn btn-sm cart-button"
              title="Cart is coming soon"
              aria-disabled="true"
              disabled
            >
              <CartIcon />
              <span>Cart</span>
            </button>
          </div>
        </div>
      </header>

      <nav className="categories" aria-label="Categories">
        <div className="categories-inner">
          {CATEGORIES.map((name) => (
            <button
              key={name}
              type="button"
              className="category-chip"
              title="Category browsing arrives with the catalog"
              aria-disabled="true"
            >
              {name}
            </button>
          ))}
        </div>
      </nav>

      <main id="main-content">
        <section className="hero" aria-labelledby="hero-heading">
          <div className="hero-decor hero-decor--lilac" aria-hidden="true" />
          <div className="hero-decor hero-decor--pink" aria-hidden="true" />
          <div className="hero-decor hero-decor--ring" aria-hidden="true" />
          <div className="hero-decor hero-decor--mark" aria-hidden="true">
            <img src="/assets/zelora-mark.svg" alt="" width="272" height="272" />
          </div>
          <NodeOrnament className="hero-decor hero-decor--nodes" />
          <div className="hero-decor hero-decor--tile" aria-hidden="true">
            <img src="/assets/zelora-mark.svg" alt="" width="40" height="40" />
          </div>
          <div className="hero-inner">
            <span className="hero-eyebrow">Multi-vendor marketplace</span>
            <h1 id="hero-heading">
              Where every independent store finds a <span className="hero-accent">home</span>.
            </h1>
            <p className="hero-subtitle">
              Zelora is a marketplace built for real sellers. Browse categories, discover local
              stores and shop with confidence — the live catalog launches soon.
            </p>
            <div className="hero-actions">
              <a className="btn btn-light btn-lg" href="#featured-products">
                Shop now
              </a>
              <Link className="btn btn-outline-light btn-lg" to="/seller/onboarding">
                Become a seller
              </Link>
            </div>
            <p className="hero-note">
              No catalog just yet. Create an account and start a store so you are ready when it
              opens.
            </p>
          </div>
        </section>

        <section id="categories" className="section" aria-labelledby="categories-heading">
          <div className="section-ornament" aria-hidden="true">
            <img src="/assets/zelora-mark.svg" alt="" width="256" height="256" />
          </div>
          <div className="section-inner">
            <div className="section-head">
              <h2 id="categories-heading">Popular categories</h2>
              <p>Every category goes live once the catalog launches.</p>
            </div>
            <div className="category-grid">
              {CATEGORIES.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="category-card"
                  title="Category browsing arrives with the catalog"
                  aria-disabled="true"
                >
                  <span className="category-icon">
                    <CategoryIcon name={name} />
                  </span>
                  <span className="category-text">
                    <strong>{name}</strong>
                    <span>Coming soon</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section
          id="featured-products"
          className="section section-alt"
          aria-labelledby="featured-heading"
        >
          <div className="section-inner">
            <div className="section-head">
              <h2 id="featured-heading">Featured products</h2>
              <p>Live listings will appear here as sellers open their stores.</p>
            </div>
            <div className="featured-grid">
              {FEATURED_SLOTS.map((slot) => (
                <article key={slot.label} className="product-placeholder">
                  <div className="product-media">
                    <img
                      className="product-watermark"
                      src="/assets/zelora-mark.svg"
                      alt=""
                      aria-hidden="true"
                      width="96"
                      height="96"
                    />
                    <span className="product-media-badge">
                      <PackageIcon size={34} />
                    </span>
                    <button
                      type="button"
                      className="product-heart"
                      title="Wishlist arriving soon"
                      aria-label="Add to wishlist — coming soon"
                      aria-disabled="true"
                      disabled
                    >
                      <HeartIcon />
                    </button>
                  </div>
                  <div className="product-body">
                    <span className="badge">Coming soon</span>
                    <h3>{slot.label}</h3>
                    <p>{slot.blurb}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="seller-heading">
          <div className="section-inner">
            <div className="seller-cta">
              <div className="seller-cta-decor" aria-hidden="true" />
              <div className="seller-cta-mark" aria-hidden="true">
                <img src="/assets/zelora-mark.svg" alt="" width="128" height="128" />
              </div>
              <div className="seller-cta-nodes" aria-hidden="true">
                <NodeOrnament />
              </div>
              <span className="seller-cta-icon" aria-hidden="true">
                <StoreIcon />
              </span>
              <div className="seller-cta-text">
                <span className="seller-eyebrow">For sellers</span>
                <h2 id="seller-heading">Open a store on Zelora</h2>
                <p>
                  Start your seller profile and set up your first store in a few steps. Reach
                  customers across the marketplace.
                </p>
                <ul className="seller-benefits">
                  <li>
                    <span className="benefit-icon" aria-hidden="true">
                      <CheckIcon />
                    </span>
                    Create your seller profile
                  </li>
                  <li>
                    <span className="benefit-icon" aria-hidden="true">
                      <CheckIcon />
                    </span>
                    Set up across 8 launch categories
                  </li>
                  <li>
                    <span className="benefit-icon" aria-hidden="true">
                      <CheckIcon />
                    </span>
                    Be ready when the catalog opens
                  </li>
                </ul>
              </div>
              <div className="seller-cta-actions">
                <Link className="btn btn-primary btn-lg" to="/seller/onboarding">
                  Become a seller
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="market-footer">
        <div className="footer-ornament" aria-hidden="true">
          <img src="/assets/zelora-mark-light.svg" alt="" width="144" height="144" />
          <span className="footer-ornament-ring" />
        </div>
        <div className="footer-inner">
          <div className="footer-columns">
            <div className="footer-col footer-brand">
              <p className="brand">
                <img
                  className="brand-logo"
                  src="/assets/zelora-logo-light.svg"
                  alt="Zelora"
                  width="132"
                  height="34"
                />
              </p>
              <p>
                A multi-vendor marketplace where independent sellers and their customers meet,
                shop and grow together.
              </p>
            </div>
            <div className="footer-col">
              <h3>Marketplace</h3>
              <ul>
                <li>
                  <a href="#featured-products">Shop now</a>
                </li>
                <li>
                  <a href="#categories">Popular categories</a>
                </li>
                <li>
                  <Link to="/seller/onboarding">Become a seller</Link>
                </li>
                <li>
                  <Link to="/seller/onboarding">Seller onboarding</Link>
                </li>
              </ul>
            </div>
            <div className="footer-col">
              <h3>Account</h3>
              <ul>
                <li>
                  <Link to="/login">Sign in</Link>
                </li>
                <li>
                  <Link to="/register">Create account</Link>
                </li>
                <li>
                  <Link to="/dashboard">Dashboard</Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="footer-bottom">
            <p>© {new Date().getFullYear()} Zelora · Multi-vendor marketplace</p>
            <span className="status-pill" role="status" aria-live="polite">
              {healthState.status === "checking" && (
                <>
                  <span className="status-dot" />
                  <span>Checking platform…</span>
                </>
              )}
              {healthState.status === "online" && (
                <>
                  <span className="status-dot online" />
                  <span>All systems online</span>
                </>
              )}
              {healthState.status === "offline" && (
                <>
                  <span className="status-dot offline" />
                  <span>API offline</span>
                </>
              )}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}