import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { CatalogProductSummaryDto, StorefrontStoreDto } from "@zelora/shared";
import { LoadingState } from "../components/LoadingState";
import { MarketFooter } from "../components/MarketFooter";
import { MarketHeader } from "../components/MarketHeader";
import { ProductCard } from "../components/ProductCard";
import { useAuth } from "../context/AuthContext";
import { ApiFailureError } from "../lib/api/client";

const PAGE_SIZE = 12;

/**
 * Public storefront for one active store. The store's identity (name and
 * description — there is no logo/gallery field on stores yet) plus its
 * published products, fetched from `GET /api/stores/:slug` and appended with
 * the API's keyset pagination, mirroring the catalog grid. An unknown or
 * offline store resolves to a friendly 404 state instead of leaking whether
 * the store exists.
 */
export function StorefrontPage() {
  const { slug } = useParams<{ slug: string }>();
  const { api } = useAuth();

  const [store, setStore] = useState<StorefrontStoreDto | null>(null);
  const [products, setProducts] = useState<CatalogProductSummaryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadStorefront(): Promise<void> {
      if (slug === undefined) return;
      setLoading(true);
      setError(null);
      setNotFound(false);
      setStore(null);
      setProducts([]);
      setNextCursor(null);
      try {
        const envelope = await api.getStorefront(slug, { limit: PAGE_SIZE });
        if (cancelled) return;
        if (envelope.ok) {
          setStore(envelope.data.store);
          setProducts(envelope.data.products.items);
          setNextCursor(envelope.data.products.nextCursor);
        } else if (envelope.error.code === "NOT_FOUND") {
          setNotFound(true);
        } else {
          setError(envelope.error.message);
        }
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof ApiFailureError ? cause.message : "Unable to load this store right now.",
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadStorefront();
    return () => {
      cancelled = true;
    };
  }, [api, slug]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (slug === undefined || nextCursor === null || loadingMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const envelope = await api.getStorefront(slug, { limit: PAGE_SIZE, cursor: nextCursor });
      if (envelope.ok) {
        setProducts((current) => [...current, ...envelope.data.products.items]);
        setNextCursor(envelope.data.products.nextCursor);
      } else {
        setError(envelope.error.message);
      }
    } catch (cause) {
      setError(cause instanceof ApiFailureError ? cause.message : "Unable to load more products.");
    } finally {
      setLoadingMore(false);
    }
  }, [api, loadingMore, nextCursor, slug]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <MarketHeader />
      <main id="main-content" className="main storefront-main">
        {loading ? (
          <LoadingState label="Loading store…" />
        ) : notFound ? (
          <div className="catalog-empty storefront-empty">
            <h2>Store not found</h2>
            <p>This store may not exist yet, or it may be taking a short break.</p>
            <Link className="btn btn-primary" to="/catalog">
              Browse the catalog
            </Link>
          </div>
        ) : error !== null ? (
          <div className="form-alert">{error}</div>
        ) : store !== null ? (
          <>
            <header className="store-head">
              <p className="store-eyebrow">Store</p>
              <h1>{store.name}</h1>
              {store.description !== null && store.description !== "" && (
                <p className="store-description">{store.description}</p>
              )}
              <Link className="btn btn-outline btn-sm" to="/catalog">
                Browse all products
              </Link>
            </header>

            <section className="store-products" aria-live="polite">
              {products.length === 0 ? (
                <div className="catalog-empty">
                  <h2>No products here yet</h2>
                  <p>This store is open, but its first listings are still being prepared.</p>
                </div>
              ) : (
                <>
                  <div className="catalog-grid">
                    {products.map((product) => (
                      <ProductCard key={product.id} product={product} />
                    ))}
                  </div>
                  {nextCursor !== null && (
                    <div className="catalog-load-more">
                      <button type="button" className="btn btn-outline" onClick={() => void loadMore()}>
                        {loadingMore ? "Loading more…" : "Load more"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        ) : null}
      </main>
      <MarketFooter />
    </div>
  );
}