import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SellerProductSummaryDto } from "@zelora/shared";
import { LoadingState } from "../components/LoadingState";
import { PageShell } from "../components/PageShell";
import { useAuth } from "../context/AuthContext";
import { resolveApiFailure } from "../lib/auth/errors";

type ProductsState = "idle" | "loading" | "ready" | "error";

export function DashboardPage() {
  const { status, user, logout, api } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<SellerProductSummaryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [productsState, setProductsState] = useState<ProductsState>("idle");
  const [productsError, setProductsError] = useState<string | null>(null);
  const [productsLoading, setProductsLoading] = useState(false);

  useEffect(() => {
    if (status !== "authenticated" || user?.role !== "seller") {
      setProducts([]);
      setNextCursor(null);
      setProductsState("idle");
      setProductsError(null);
      setProductsLoading(false);
      return;
    }

    let active = true;
    setProductsState("loading");
    setProductsError(null);
    setProductsLoading(true);
    void api
      .listSellerProducts({ limit: 5 })
      .then((envelope) => {
        if (!active) {
          return;
        }
        if (!envelope.ok) {
          setProductsError(envelope.error.message);
          setProductsState("error");
          return;
        }
        setProducts(envelope.data.items);
        setNextCursor(envelope.data.nextCursor);
        setProductsState("ready");
      })
      .catch((cause) => {
        if (!active) {
          return;
        }
        setProductsError(resolveApiFailure(cause).message);
        setProductsState("error");
      })
      .finally(() => {
        if (active) {
          setProductsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [api, status, user?.role]);

  async function onSignOut(): Promise<void> {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    setError(null);
    try {
      await logout();
    } catch (cause) {
      setError(resolveApiFailure(cause).message);
      setSigningOut(false);
    }
  }

  async function onLoadMore(): Promise<void> {
    if (nextCursor === null || productsLoading || status !== "authenticated") {
      return;
    }
    setProductsLoading(true);
    setProductsError(null);
    try {
      const envelope = await api.listSellerProducts({ limit: 5, cursor: nextCursor });
      if (!envelope.ok) {
        setProductsError(envelope.error.message);
        return;
      }
      setProducts((current) => [...current, ...envelope.data.items]);
      setNextCursor(envelope.data.nextCursor);
    } catch (cause) {
      setProductsError(resolveApiFailure(cause).message);
    } finally {
      setProductsLoading(false);
    }
  }

  const sellerProducts = user?.role === "seller" ? (
    <section className="seller-products" id="my-products" aria-labelledby="my-products-heading">
      <div className="section-heading">
        <div>
          <h2 id="my-products-heading">My Products</h2>
          <p className="muted">Review your products, variants, and inventory.</p>
        </div>
        <Link className="btn btn-primary" to="/seller/products/new">
          Create product
        </Link>
      </div>

      {productsState === "loading" && products.length === 0 && (
        <LoadingState label="Loading products…" />
      )}

      {productsError !== null && (
        <p className="form-alert" role="alert">
          {productsError}
        </p>
      )}

      {productsState !== "loading" && products.length === 0 && productsError === null && (
        <p className="muted">You have not created any products yet.</p>
      )}

      {products.length > 0 && (
        <ul className="seller-product-list">
          {products.map((product) => (
            <li className="seller-product-row" key={product.id}>
              <div className="seller-product-meta">
                <strong>{product.name}</strong>
                <span className="muted">/{product.slug}</span>
                <span className="badge">{product.status}</span>
                <span className="muted">
                  Created {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(product.createdAt))}
                </span>
              </div>
              <Link className="btn btn-sm" to={`/seller/products/${product.id}`}>
                View details
              </Link>
            </li>
          ))}
        </ul>
      )}

      {nextCursor !== null && (
        <div className="pagination-actions">
          <button type="button" className="btn" onClick={() => void onLoadMore()} disabled={productsLoading}>
            {productsLoading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  ) : null;

  return (
    <PageShell title="Dashboard">
      {status === "loading" && <LoadingState label="Checking session…" />}

      {status === "signed-out" && (
        <p className="muted">
          You are not signed in. <Link to="/login">Sign in</Link> to continue.
        </p>
      )}

      {status === "authenticated" && user !== null && (
        <div className="dashboard">
          <section className="user-card" aria-labelledby="account-heading">
            <h2 id="account-heading">Account</h2>
            <p className="user-email">{user.email}</p>
            <p className="muted">
              {user.name} · <span className="badge">{user.role}</span>
            </p>
          </section>

          {error !== null && (
            <p className="form-alert" role="alert">
              {error}
            </p>
          )}

          {sellerProducts}

          <ul className="dashboard-actions">
            {user.role === "seller" && (
              <li>
                <Link to="/dashboard#my-products">My Products</Link>
              </li>
            )}
            {user.role === "seller" && (
              <li>
                <Link to="/seller/products/new">Create a product</Link>
              </li>
            )}
            {user.role === "customer" && (
              <li>
                <Link to="/seller/onboarding">Seller onboarding</Link>
              </li>
            )}
            <li>
              <Link to="/">Back to home</Link>
            </li>
            <li>
              <button type="button" className="btn" onClick={onSignOut} disabled={signingOut}>
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </li>
          </ul>
        </div>
      )}
    </PageShell>
  );
}
