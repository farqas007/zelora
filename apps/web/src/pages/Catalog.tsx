import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { CatalogCategoryDto, CatalogProductSummaryDto } from "@zelora/shared";
import { LoadingState } from "../components/LoadingState";
import { MarketFooter } from "../components/MarketFooter";
import { MarketHeader } from "../components/MarketHeader";
import { ProductCard } from "../components/ProductCard";
import { useAuth } from "../context/AuthContext";
import { ApiFailureError } from "../lib/api/client";

const PAGE_SIZE = 12;

/**
 * Public storefront grid. The active category (if any) lives in the `category`
 * query parameter so filtering is shareable and back-forward friendly; the
 * sidebar always shows every live category. Products are fetched with the
 * API's keyset pagination and appended by a "load more" control.
 */
export function CatalogPage() {
  const { api } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const category = searchParams.get("category") ?? undefined;

  const [categories, setCategories] = useState<CatalogCategoryDto[] | null>(null);
  const [products, setProducts] = useState<CatalogProductSummaryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadCategories(): Promise<void> {
      try {
        const envelope = await api.listCatalogCategories();
        if (!cancelled && envelope.ok) {
          setCategories(envelope.data);
        }
      } catch {
        // The grid still works without the sidebar labels.
      }
    }

    void loadCategories();
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;

    async function loadFirstPage(): Promise<void> {
      setLoading(true);
      setError(null);
      setProducts([]);
      setNextCursor(null);
      try {
        const envelope = await api.listCatalogProducts({ limit: PAGE_SIZE, category });
        if (cancelled) return;
        if (envelope.ok) {
          setProducts(envelope.data.items);
          setNextCursor(envelope.data.nextCursor);
        } else {
          setError(envelope.error.message);
        }
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof ApiFailureError ? cause.message : "Unable to load the catalog right now.",
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadFirstPage();
    return () => {
      cancelled = true;
    };
  }, [api, category]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null || loadingMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const envelope = await api.listCatalogProducts({ limit: PAGE_SIZE, cursor: nextCursor, category });
      if (envelope.ok) {
        setProducts((current) => [...current, ...envelope.data.items]);
        setNextCursor(envelope.data.nextCursor);
      } else {
        setError(envelope.error.message);
      }
    } catch (cause) {
      setError(cause instanceof ApiFailureError ? cause.message : "Unable to load more products.");
    } finally {
      setLoadingMore(false);
    }
  }, [api, category, loadingMore, nextCursor]);

  const activeCategory = categories?.find((candidate) => candidate.slug === category) ?? null;

  function selectCategory(slug: string | undefined): void {
    if (slug === undefined) {
      setSearchParams({});
    } else {
      setSearchParams({ category: slug });
    }
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <MarketHeader />
      <main id="main-content" className="main catalog-main">
        <div className="catalog-head">
          <h1>{activeCategory !== null ? activeCategory.name : "All products"}</h1>
          <p>
            {activeCategory !== null
              ? `Browse every live listing in ${activeCategory.name}.`
              : "Browse every live listing across the marketplace."}
          </p>
        </div>

        <div className="catalog-layout">
          <aside className="catalog-sidebar" aria-label="Categories">
            <h2>Categories</h2>
            {categories === null ? (
              <p className="muted">Loading categories…</p>
            ) : (
              <ul className="catalog-filter-list">
                <li>
                  <Link
                    className={category === undefined ? "catalog-filter-link active" : "catalog-filter-link"}
                    to="/catalog"
                  >
                    All products
                  </Link>
                </li>
                {categories.map((candidate) => (
                  <li key={candidate.id}>
                    <Link
                      className={
                        category === candidate.slug ? "catalog-filter-link active" : "catalog-filter-link"
                      }
                      to={`/catalog?category=${candidate.slug}`}
                    >
                      {candidate.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="catalog-results" aria-live="polite">
            {error !== null && <div className="form-alert">{error}</div>}

            {loading ? (
              <LoadingState label="Loading products…" />
            ) : products.length === 0 && error === null ? (
              <div className="catalog-empty">
                <h2>No products here yet</h2>
                <p>New listings will appear as sellers open their stores.</p>
                {activeCategory !== null && (
                  <button type="button" className="btn btn-primary" onClick={() => selectCategory(undefined)}>
                    Browse all products
                  </button>
                )}
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
        </div>
      </main>
      <MarketFooter />
    </div>
  );
}