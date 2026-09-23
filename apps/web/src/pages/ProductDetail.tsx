import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { CatalogProductDetailDto } from "@zelora/shared";
import { LoadingState } from "../components/LoadingState";
import { MarketFooter } from "../components/MarketFooter";
import { MarketHeader } from "../components/MarketHeader";
import { useAuth } from "../context/AuthContext";
import { ApiFailureError } from "../lib/api/client";
import { formatCents } from "../lib/format";

type DetailState =
  | { status: "loading" }
  | { status: "ready"; product: CatalogProductDetailDto }
  | { status: "missing" }
  | { status: "error"; message: string };

/**
 * Public product detail page. Reads the product from the catalog API by slug
 * and presents its images, store and sellable variants. A missing or inactive
 * product surfaces as an explicit "not available" state instead of a crash.
 */
export function ProductDetailPage() {
  const { api } = useAuth();
  const { slug } = useParams<{ slug: string }>();
  const [state, setState] = useState<DetailState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function loadProduct(): Promise<void> {
      if (slug === undefined) {
        setState({ status: "missing" });
        return;
      }
      setState({ status: "loading" });
      try {
        const envelope = await api.getCatalogProductBySlug(slug);
        if (cancelled) return;
        if (envelope.ok) {
          setState({ status: "ready", product: envelope.data });
        } else {
          setState({
            status: envelope.error.code === "NOT_FOUND" ? "missing" : "error",
            message: envelope.error.message,
          });
        }
      } catch (cause) {
        if (cancelled) return;
        setState({
          status: "error",
          message:
            cause instanceof ApiFailureError ? cause.message : "Unable to load this product.",
        });
      }
    }

    void loadProduct();
    return () => {
      cancelled = true;
    };
  }, [api, slug]);

  const product = state.status === "ready" ? state.product : null;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <MarketHeader />
      <main id="main-content" className="main catalog-main">
        {state.status === "loading" && (
          <LoadingState label="Loading product…" />
        )}

        {state.status === "missing" && (
          <div className="catalog-empty">
            <h2>This product is not available</h2>
            <p>It may have been removed or is no longer on sale.</p>
            <Link className="btn btn-primary" to="/catalog">
              Back to the catalog
            </Link>
          </div>
        )}

        {state.status === "error" && <div className="form-alert">{state.message}</div>}

        {product !== null && (
          <article className="product-detail">
            <nav className="breadcrumbs" aria-label="Breadcrumb">
              <Link to="/catalog">Catalog</Link>
              {product.category !== null && (
                <>
                  <span aria-hidden="true">/</span>
                  <Link to={`/catalog?category=${product.category.slug}`}>{product.category.name}</Link>
                </>
              )}
              <span aria-hidden="true">/</span>
              <span aria-current="page">{product.name}</span>
            </nav>

            <div className="product-detail-grid">
              <div className="product-detail-media">
                {product.images.length > 0 ? (
                  <img
                    src={product.images[0]!.url}
                    alt={product.images[0]!.altText ?? product.name}
                  />
                ) : (
                  <div className="product-media">
                    <img
                      className="product-watermark"
                      src="/assets/zelora-mark.svg"
                      alt=""
                      aria-hidden="true"
                      width="96"
                      height="96"
                    />
                  </div>
                )}
              </div>

              <div className="product-detail-info">
                <span className="product-store">{product.store.name}</span>
                <h1>{product.name}</h1>
                <p className="product-detail-description">{product.description}</p>

                <div className="product-variant-list">
                  {product.variants.length === 0 ? (
                    <p className="muted">No sellable variants at the moment.</p>
                  ) : (
                    product.variants.map((variant) => (
                      <div key={variant.id} className="variant-row">
                        <div className="variant-name">
                          <strong>{variant.name}</strong>
                          {variant.sku !== null && <span className="muted">SKU {variant.sku}</span>}
                        </div>
                        <div className="variant-price">
                          <span>{formatCents(variant.priceAmountCents, variant.currency)}</span>
                          {variant.compareAtAmountCents !== null && (
                            <s>{formatCents(variant.compareAtAmountCents, variant.currency)}</s>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </article>
        )}
      </main>
      <MarketFooter />
    </div>
  );
}