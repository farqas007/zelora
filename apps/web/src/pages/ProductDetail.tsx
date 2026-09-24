import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { CatalogProductDetailDto, CatalogVariantDto } from "@zelora/shared";
import { LoadingState } from "../components/LoadingState";
import { MarketFooter } from "../components/MarketFooter";
import { MarketHeader } from "../components/MarketHeader";
import { useAuth } from "../context/AuthContext";
import { useCart } from "../context/CartContext";
import { ApiFailureError } from "../lib/api/client";
import { resolveCartFailure } from "../lib/cart/errors";
import { formatCents } from "../lib/format";

type DetailState =
  | { status: "loading" }
  | { status: "ready"; product: CatalogProductDetailDto }
  | { status: "missing" }
  | { status: "error"; message: string };

interface AddToCartFeedback {
  kind: "success" | "error";
  text: string;
}

/**
 * Public product detail page. Reads the product from the catalog API by slug
 * and presents its images, store and sellable variants. Each variant row can
 * add that variant to the cart for an authenticated customer; signed-out
 * visitors are pointed at the existing sign-in flow instead of bypassing it.
 */
export function ProductDetailPage() {
  const { api, status } = useAuth();
  const { addItem } = useCart();
  const { slug } = useParams<{ slug: string }>();
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [addingVariantId, setAddingVariantId] = useState<string | null>(null);
  const [addFeedback, setAddFeedback] = useState<AddToCartFeedback | null>(null);

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

  useEffect(() => {
    if (addFeedback === null || addFeedback.kind !== "success") {
      return;
    }
    const timer = window.setTimeout(() => setAddFeedback(null), 4000);
    return () => window.clearTimeout(timer);
  }, [addFeedback]);

  async function onAddToCart(variant: CatalogVariantDto): Promise<void> {
    if (status !== "authenticated" || addingVariantId !== null) {
      return;
    }
    setAddingVariantId(variant.id);
    setAddFeedback(null);
    try {
      await addItem(variant.id, 1);
      setAddFeedback({ kind: "success", text: `${variant.name} added to your cart.` });
    } catch (cause) {
      setAddFeedback({ kind: "error", text: resolveCartFailure(cause) });
    } finally {
      setAddingVariantId(null);
    }
  }

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
                  {addFeedback !== null && (
                    <div
                      className={addFeedback.kind === "success" ? "form-success" : "form-alert"}
                      role="status"
                    >
                      {addFeedback.text}
                    </div>
                  )}
                  {status === "signed-out" && (
                    <div className="login-required-note" role="status">
                      <span>Sign in to add items to your cart.</span>
                      <Link to="/login">Sign in</Link>
                      <span aria-hidden="true">·</span>
                      <Link to="/register">Create an account</Link>
                    </div>
                  )}
                  {product.variants.length === 0 ? (
                    <p className="muted">No sellable variants at the moment.</p>
                  ) : (
                    product.variants.map((variant) => (
                      <div key={variant.id} className="variant-row">
                        <div className="variant-name">
                          <strong>{variant.name}</strong>
                          {variant.sku !== null && <span className="muted">SKU {variant.sku}</span>}
                        </div>
                        <div className="variant-actions">
                          <div className="variant-price">
                            <span>{formatCents(variant.priceAmountCents, variant.currency)}</span>
                            {variant.compareAtAmountCents !== null && (
                              <s>{formatCents(variant.compareAtAmountCents, variant.currency)}</s>
                            )}
                          </div>
                          {status === "loading" ? (
                            <button type="button" className="btn btn-sm btn-primary" disabled>
                              Add to cart
                            </button>
                          ) : status === "authenticated" ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => void onAddToCart(variant)}
                              disabled={addingVariantId !== null}
                            >
                              {addingVariantId === variant.id ? "Adding…" : "Add to cart"}
                            </button>
                          ) : (
                            <Link className="btn btn-sm btn-primary" to="/login">
                              Sign in to add
                            </Link>
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