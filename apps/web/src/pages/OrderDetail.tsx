import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { OrderDetailDto } from "@zelora/shared";
import { LoadingState } from "../components/LoadingState";
import { MarketFooter } from "../components/MarketFooter";
import { MarketHeader } from "../components/MarketHeader";
import { useAuth } from "../context/AuthContext";
import { resolveOrderFailure } from "../lib/orders/errors";
import { formatCents } from "../lib/format";

type DetailState = "loading" | "ready" | "error";

/**
 * One customer order with its saved address snapshots and lines. The id comes
 * from the route; the detail endpoint scopes to the caller, so another
 * customer's order id surfaces as a not-found error rather than leakage.
 */
export function OrderDetailPage() {
  const { api } = useAuth();
  const { orderId } = useParams<{ orderId: string }>();
  const [order, setOrder] = useState<OrderDetailDto | null>(null);
  const [state, setState] = useState<DetailState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (orderId === undefined) {
      setState("error");
      setError("This order could not be found.");
      return;
    }
    let active = true;
    setState("loading");
    setError(null);
    void api
      .getOrder(orderId)
      .then((envelope) => {
        if (!active) {
          return;
        }
        if (!envelope.ok) {
          setError(envelope.error.message);
          setState("error");
          return;
        }
        setOrder(envelope.data);
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
  }, [api, orderId]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <MarketHeader />
      <main id="main-content" className="main catalog-main">
        <div className="cart-head">
          <h1>Order detail</h1>
          <p className="muted">
            <Link to="/orders">All orders</Link>
          </p>
        </div>

        {state === "loading" && <LoadingState label="Loading order…" />}

        {state === "error" && (
          <div className="catalog-empty">
            <h2>Order not found</h2>
            <p>{error}</p>
            <Link className="btn btn-primary" to="/orders">
              Back to my orders
            </Link>
          </div>
        )}

        {state === "ready" && order !== null && (
          <section className="order-detail" aria-label="Order">
            <div className="order-detail-head">
              <div>
                <h2>Order {shortOrderId(order.id)}</h2>
                <p className="muted">
                  Placed{" "}
                  {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
                    new Date(order.createdAt),
                  )}
                </p>
              </div>
              <span className="badge">{order.status}</span>
            </div>

            <div className="order-totals">
              <p>
                Subtotal <strong>{formatCents(order.subtotalAmountCents, order.currency)}</strong>
              </p>
              <p>
                Shipping <strong>{formatCents(order.shippingAmountCents, order.currency)}</strong>
              </p>
              <p>
                Discount <strong>{formatCents(order.discountAmountCents, order.currency)}</strong>
              </p>
              <p className="order-total">
                Total <strong>{formatCents(order.totalAmountCents, order.currency)}</strong>
              </p>
              <p className="muted">
                {order.itemCount} {order.itemCount === 1 ? "item" : "items"}
              </p>
            </div>

            <ul className="order-lines">
              {order.items.map((item) => (
                <li className="order-line" key={item.id}>
                  <span className="order-line-name">
                    {item.productName} · {item.variantName}
                  </span>
                  <span className="muted">
                    {item.quantity} × {formatCents(item.unitAmountCents, item.currency)}
                  </span>
                  <span className="order-line-total">
                    {formatCents(item.lineTotalAmountCents, item.currency)}
                  </span>
                </li>
              ))}
            </ul>

            <div className="order-addresses">
              {order.addresses.map((address) => (
                <div className="order-address" key={address.kind}>
                  <h3>{address.kind === "shipping" ? "Shipping address" : "Billing address"}</h3>
                  <address>
                    <strong>{address.recipientName}</strong>
                    {address.phone !== null && <span className="muted">{address.phone}</span>}
                    <span>
                      {address.line1}
                      {address.line2 !== null ? `, ${address.line2}` : ""}
                    </span>
                    <span>
                      {address.city}
                      {address.region !== null ? `, ${address.region}` : ""}{" "}
                      {address.postalCode !== null ? address.postalCode : ""}
                    </span>
                    <span>{address.countryCode}</span>
                  </address>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
      <MarketFooter />
    </div>
  );
}

function shortOrderId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}