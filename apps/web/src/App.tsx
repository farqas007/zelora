import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ApiEnvelope,
  CatalogCategoryDto,
  CatalogProductSummaryDto,
  HealthResponse,
} from "@zelora/shared";
import { MarketFooter } from "./components/MarketFooter";
import { MarketHeader } from "./components/MarketHeader";
import { ProductCard } from "./components/ProductCard";
import { useAuth } from "./context/AuthContext";

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

type ApiStatus = "checking" | "online" | "offline";

interface ApiHealthState {
  status: ApiStatus;
  health: HealthResponse | null;
}

const INITIAL_STATE: ApiHealthState = { status: "checking", health: null };

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

export function App() {
  const { api } = useAuth();
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

  const [categories, setCategories] = useState<CatalogCategoryDto[]>([]);
  const [featured, setFeatured] = useState<CatalogProductSummaryDto[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadCatalog(): Promise<void> {
      try {
        const categoriesEnvelope = await api.listCatalogCategories();
        if (!cancelled && categoriesEnvelope.ok) {
          setCategories(categoriesEnvelope.data);
        }
        const productsEnvelope = await api.listCatalogProducts({ limit: 4 });
        if (!cancelled && productsEnvelope.ok) {
          setFeatured(productsEnvelope.data.items);
        }
      } catch {
        // The hero stands alone; failures just leave these sections quiet.
      }
    }

    void loadCatalog();
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <MarketHeader />

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
              Zelora is a marketplace built for real sellers. Browse live categories, discover
              stores and shop with confidence — the catalog is open.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-light btn-lg" to="/catalog">
                Shop now
              </Link>
              <Link className="btn btn-outline-light btn-lg" to="/seller/onboarding">
                Become a seller
              </Link>
            </div>
            <p className="hero-note">
              The catalog is live now. Create an account and open a store to start selling.
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
              <p>Jump straight into every live category on Zelora.</p>
            </div>
            {categories.length === 0 ? (
              <p className="muted">Categories will appear here as stores open.</p>
            ) : (
              <div className="category-grid">
                {categories.map((category) => (
                  <Link key={category.id} className="category-card" to={`/catalog?category=${category.slug}`}>
                    <span className="category-icon">
                      <PackageIcon />
                    </span>
                    <span className="category-text">
                      <strong>{category.name}</strong>
                      <span>Shop category</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
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
              <p>Fresh listings from sellers across the marketplace.</p>
              <Link className="btn btn-outline btn-sm" to="/catalog">
                Browse all
              </Link>
            </div>
            {featured.length === 0 ? (
              <p className="muted">Live listings will appear here as sellers open their stores.</p>
            ) : (
              <div className="featured-grid">
                {featured.map((product) => (
                  <ProductCard key={product.id} product={product} />
                ))}
              </div>
            )}
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
                    Choose from live categories
                  </li>
                  <li>
                    <span className="benefit-icon" aria-hidden="true">
                      <CheckIcon />
                    </span>
                    Go live and start selling today
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

      <MarketFooter
        statusSlot={
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
        }
      />
    </div>
  );
}