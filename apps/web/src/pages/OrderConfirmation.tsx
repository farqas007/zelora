import { Link, useLocation } from "react-router-dom";
import type { OrderDetailDto } from "@zelora/shared";
import { MarketFooter } from "../components/MarketFooter";
import { MarketHeader } from "../components/MarketHeader";
import { formatCents } from "../lib/format";

interface ConfirmationState {
  order?: OrderDetailDto;
}

/**
 * Post-checkout confirmation. The just-placed order is carried in router state
 * (it was returned by `POST /api/orders`), so this page renders instantly
 * without a refetch. If a visitor lands here fresh (direct link, reload) the
 * state is gone and they are pointed at their order history instead — the
 * order itself already exists server-side and is always reachable there.
 */
export function OrderConfirmationPage() {
  const location = useLocation();
  const order = (location.state as ConfirmationState | null)?.order;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <MarketHeader />
      <main id="main-content" className="main catalog-main">
        <div className="cart-head">
          <h1>Order confirmed</h1>
          <p className="muted">Thanks for shopping with Zelora.</p>
        </div>

        {order === undefined ? (
          <div className="catalog-empty">
            <h2>Nothing to show here yet</h2>
            <p>Your orders are always saved. Find them from your account.</p>
            <Link className="btn btn-primary" to="/orders">
              View my orders
            </Link>
          </div>
        ) : (
          <>
            <section className="order-detail" aria-label="Order confirmation">
              <div className="order-detail-head">
                <div>
                  <h2>Order {shortOrderId(order.id)}</h2>
                  <p className="muted">
                    Placed {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(order.createdAt))}
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
            </section>

            <div className="pagination-actions">
              <Link className="btn btn-primary" to="/orders">
                View all orders
              </Link>
              <Link className="btn" to="/catalog">
                Continue shopping
              </Link>
            </div>
          </>
        )}
      </main>
      <MarketFooter />
    </div>
  );
}

function shortOrderId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}