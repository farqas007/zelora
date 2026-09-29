import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { OrderSummaryDto } from "@zelora/shared";
import { LoadingState } from "../components/LoadingState";
import { MarketFooter } from "../components/MarketFooter";
import { MarketHeader } from "../components/MarketHeader";
import { useAuth } from "../context/AuthContext";
import { resolveOrderFailure } from "../lib/orders/errors";
import { formatCents } from "../lib/format";

type OrdersState = "loading" | "ready" | "error";

/**
 * Customer order history, newest first, keyset-paginated with a load-more
 * control identical to the seller product list. Each row links to the order's
 * detail page; the list rows intentionally carry no address snapshots (the
 * list endpoint returns the lean projection).
 */
export function OrdersPage() {
  const { api } = useAuth();
  const [orders, setOrders] = useState<OrderSummaryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<OrdersState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    setState("loading");
    setError(null);
    void api
      .listOrders({ limit: 10 })
      .then((envelope) => {
        if (!active) {
          return;
        }
        if (!envelope.ok) {
          setError(envelope.error.message);
          setState("error");
          return;
        }
        setOrders(envelope.data.items);
        setNextCursor(envelope.data.nextCursor);
        setState("ready");
      })
      .catch((cause) => {
        if (!active) {
          return;
        }
        setError(resolveOrderFailure(cause));
        setState("error");
      });
    return () => {
      active = false;
    };
  }, [api]);

  async function onLoadMore(): Promise<void> {
    if (nextCursor === null || loadingMore) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      const envelope = await api.listOrders({ limit: 10, cursor: nextCursor });
      if (!envelope.ok) {
        setError(envelope.error.message);
        return;
      }
      setOrders((current) => [...current, ...envelope.data.items]);
      setNextCursor(envelope.data.nextCursor);
    } catch (cause) {
      setError(resolveOrderFailure(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <MarketHeader />
      <main id="main-content" className="main catalog-main">
        <div className="cart-head">
          <h1>Your orders</h1>
          <p className="muted">Every order you have placed, newest first.</p>
        </div>

        {state === "loading" && orders.length === 0 && <LoadingState label="Loading your orders…" />}

        {error !== null && (
          <p className="form-alert" role="alert">
            {error}
          </p>
        )}

        {state === "ready" && orders.length === 0 && (
          <div className="catalog-empty">
            <h2>No orders yet</h2>
            <p>When you check out, your orders will show up here.</p>
            <Link className="btn btn-primary" to="/catalog">
              Browse the catalog
            </Link>
          </div>
        )}

        {orders.length > 0 && (
          <ul className="order-list">
            {orders.map((order) => (
              <li className="order-row" key={order.id}>
                <div className="order-row-meta">
                  <Link className="order-row-id" to={`/orders/${order.id}`}>
                    Order {shortOrderId(order.id)}
                  </Link>
                  <span className="muted">
                    {formatCents(order.totalAmountCents, order.currency)} · {order.itemCount}{" "}
                    {order.itemCount === 1 ? "item" : "items"}
                  </span>
                  <span className="muted">
                    {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
                      new Date(order.createdAt),
                    )}
                  </span>
                </div>
                <span className="badge">{order.status}</span>
              </li>
            ))}
          </ul>
        )}

        {nextCursor !== null && state === "ready" && (
          <div className="pagination-actions">
            <button type="button" className="btn" onClick={() => void onLoadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </main>
      <MarketFooter />
    </div>
  );
}

function shortOrderId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}