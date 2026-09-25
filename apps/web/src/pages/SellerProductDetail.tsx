import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SellerProductDetailDto } from "@zelora/shared";
import { LoadingState } from "../components/LoadingState";
import { PageShell } from "../components/PageShell";
import { useAuth } from "../context/AuthContext";
import { resolveApiFailure } from "../lib/auth/errors";
import { formatCents } from "../lib/format";

type DetailState =
  | { status: "loading" }
  | { status: "ready"; product: SellerProductDetailDto }
  | { status: "missing" }
  | { status: "error"; message: string };

export function SellerProductDetailPage() {
  const { status: authStatus, user, api } = useAuth();
  const { productId } = useParams<{ productId: string }>();
  const [state, setState] = useState<DetailState>({ status: "loading" });

  useEffect(() => {
    if (authStatus !== "authenticated" || user?.role !== "seller") {
      return;
    }

    let active = true;
    if (productId === undefined) {
      setState({ status: "missing" });
      return () => {
        active = false;
      };
    }

    setState({ status: "loading" });
    void api
      .getSellerProduct(productId)
      .then((envelope) => {
        if (!active) {
          return;
        }
        if (envelope.ok) {
          setState({ status: "ready", product: envelope.data });
        } else if (envelope.error.code === "PRODUCT_NOT_FOUND") {
          setState({ status: "missing" });
        } else {
          setState({ status: "error", message: envelope.error.message });
        }
      })
      .catch((cause) => {
        if (active) {
          setState({ status: "error", message: resolveApiFailure(cause).message });
        }
      });

    return () => {
      active = false;
    };
  }, [api, authStatus, productId, user?.role]);

  if (authStatus === "loading") {
    return (
      <PageShell title="Product details">
        <LoadingState label="Checking session…" />
      </PageShell>
    );
  }

  if (authStatus !== "authenticated" || user?.role !== "seller") {
    return (
      <PageShell title="Product details">
        <p className="muted">This page is available to approved sellers.</p>
        <Link className="btn" to="/dashboard">
          Back to dashboard
        </Link>
      </PageShell>
    );
  }

  return (
    <PageShell title="Product details">
      {state.status === "loading" && <LoadingState label="Loading product…" />}

      {state.status === "missing" && (
        <div className="catalog-empty">
          <h2>Product not found</h2>
          <p>This product is not available in your store.</p>
          <Link className="btn btn-primary" to="/dashboard#my-products">
            Back to My Products
          </Link>
        </div>
      )}

      {state.status === "error" && <p className="form-alert" role="alert">{state.message}</p>}

      {state.status === "ready" && <SellerProductDetail product={state.product} />}
    </PageShell>
  );
}

function SellerProductDetail({ product }: { product: SellerProductDetailDto }) {
  return (
    <article className="seller-product-detail">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/dashboard">Dashboard</Link>
        <span aria-hidden="true">/</span>
        <Link to="/dashboard#my-products">My Products</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{product.name}</span>
      </nav>

      <header className="seller-product-detail-header">
        <div>
          <h2>{product.name}</h2>
          <p className="muted">/{product.slug}</p>
        </div>
        <span className="badge">{product.status}</span>
      </header>

      <dl className="seller-product-facts">
        <div>
          <dt>Category</dt>
          <dd>{product.categoryId ?? "Uncategorized"}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(product.createdAt))}</dd>
        </div>
      </dl>

      <section className="user-card" aria-labelledby="description-heading">
        <h2 id="description-heading">Description</h2>
        <p>{product.description ?? "No description added."}</p>
      </section>

      <section className="user-card" aria-labelledby="variants-heading">
        <div className="section-heading">
          <h2 id="variants-heading">Variants and inventory</h2>
          <span className="muted">{product.variants.length} total</span>
        </div>
        {product.variants.length === 0 ? (
          <p className="muted">No variants have been added.</p>
        ) : (
          <div className="seller-variant-list">
            {product.variants.map((variant) => (
              <div className="seller-variant-row" key={variant.id}>
                <div className="seller-variant-meta">
                  <strong>{variant.name}</strong>
                  <span className="muted">{variant.sku ?? "No SKU"}</span>
                  <span className="badge">{variant.status}</span>
                </div>
                <div className="seller-variant-data">
                  <span>{formatCents(variant.priceAmountCents, variant.currency)}</span>
                  {variant.compareAtAmountCents !== null && (
                    <s>{formatCents(variant.compareAtAmountCents, variant.currency)}</s>
                  )}
                  <span>
                    {variant.inventory === null ? "Inventory not set" : `${variant.inventory.quantity} in stock`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <ul className="dashboard-actions">
        <li>
          <Link className="btn" to="/dashboard#my-products">
            Back to My Products
          </Link>
        </li>
        {product.status === "active" && (
          <li>
            <Link className="btn btn-primary" to={`/catalog/products/${product.slug}`}>
              View public listing
            </Link>
          </li>
        )}
      </ul>
    </article>
  );
}
