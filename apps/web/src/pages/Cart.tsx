import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CART_ITEM_QUANTITY_LIMITS, type CartItemDto } from "@zelora/shared";
import { LoadingState } from "../components/LoadingState";
import { MarketFooter } from "../components/MarketFooter";
import { MarketHeader } from "../components/MarketHeader";
import { useAuth } from "../context/AuthContext";
import { useCart } from "../context/CartContext";
import { loadCartVariantLookup, type CartVariantReference } from "../lib/cart/catalog";
import { resolveCartFailure } from "../lib/cart/errors";
import { formatCents } from "../lib/format";

const EMPTY_CART_ITEMS: CartItemDto[] = [];

/**
 * Customer cart page. Reads `GET /api/cart` through the shared cart state and
 * renders each line with live quantity controls (increment, decrement and a
 * direct number input), per-item removal and a whole-cart clear. Variant-level
 * product information (name, store, image, price) is joined client-side from
 * the public catalog since the cart API carries only variant ids + quantities.
 * Signed-out visitors see a login-required state instead of an error.
 */
export function CartPage() {
  const { api } = useAuth();
  const { cart, itemCount, status, error, refresh, updateItemQuantity, removeItem, clearCart } =
    useCart();
  const [localError, setLocalError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [lookup, setLookup] = useState<Map<string, CartVariantReference> | null>(null);

  const items = cart === null ? EMPTY_CART_ITEMS : cart.items;
  const lookupKey = items.map((item) => `${item.id}:${item.variantId}`).join("|");

  useEffect(() => {
    if (items.length === 0) {
      setLookup(new Map());
      return;
    }
    let cancelled = false;
    setLookup(null);
    void loadCartVariantLookup(
      api,
      items.map((item) => item.variantId),
    ).then((result) => {
      if (!cancelled) {
        setLookup(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, lookupKey]);

  async function onQuantityChange(item: CartItemDto, quantity: number): Promise<void> {
    setLocalError(null);
    try {
      await updateItemQuantity(item.id, quantity);
    } catch (cause) {
      setLocalError(resolveCartFailure(cause));
    }
  }

  async function onRemove(item: CartItemDto): Promise<void> {
    setLocalError(null);
    try {
      await removeItem(item.id);
    } catch (cause) {
      setLocalError(resolveCartFailure(cause));
    }
  }

  async function onClear(): Promise<void> {
    if (clearing) {
      return;
    }
    setClearing(true);
    setLocalError(null);
    try {
      await clearCart();
      setConfirmClear(false);
    } catch (cause) {
      setLocalError(resolveCartFailure(cause));
    } finally {
      setClearing(false);
    }
  }

  async function onRetry(): Promise<void> {
    setLocalError(null);
    try {
      await refresh();
    } catch (cause) {
      setLocalError(resolveCartFailure(cause));
    }
  }

  const loadError = error ?? localError;
  const ready = status === "ready" && cart !== null;
  const showError = status !== "loading" && status !== "signed-out" && loadError !== null;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <MarketHeader />
      <main id="main-content" className="main catalog-main">
        <div className="cart-head">
          <h1>Your cart</h1>
          {ready && items.length > 0 && (
            <p className="muted">
              {itemCount} {itemCount === 1 ? "item" : "items"} in your cart
            </p>
          )}
        </div>

        {status === "signed-out" && (
          <div className="cart-login">
            <h2>Sign in to view your cart</h2>
            <p>Your cart is tied to your account so your picks stay saved on any device.</p>
            <div className="cart-login-actions">
              <Link className="btn btn-primary" to="/login">
                Sign in
              </Link>
              <Link className="btn btn-outline" to="/register">
                Create an account
              </Link>
            </div>
          </div>
        )}

        {status === "loading" && <LoadingState label="Loading your cart…" />}

        {showError && (
          <div className="cart-banner" role="alert">
            <p className="form-alert">{loadError}</p>
            <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}

        {ready && items.length === 0 && loadError === null && (
          <div className="catalog-empty">
            <h2>Your cart is empty</h2>
            <p>Browse the catalog and add something you like.</p>
            <Link className="btn btn-primary" to="/catalog">
              Browse the catalog
            </Link>
          </div>
        )}

        {ready && items.length > 0 && (
          <>
            <div className="cart-lines">
              {items.map((item) => (
                <CartLine
                  key={item.id}
                  item={item}
                  reference={lookup?.get(item.variantId)}
                  detailLoading={lookup === null}
                  onQuantityChange={onQuantityChange}
                  onRemove={onRemove}
                />
              ))}
            </div>

            <div className="cart-foot">
              {confirmClear ? (
                <div className="cart-clear-confirm">
                  <span>Clear all items?</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={onClear}
                    disabled={clearing}
                  >
                    {clearing ? "Clearing…" : "Yes, clear"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setConfirmClear(false)}
                    disabled={clearing}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setConfirmClear(true)}
                >
                  Clear cart
                </button>
              )}
            </div>
          </>
        )}
      </main>
      <MarketFooter />
    </div>
  );
}

interface CartLineProps {
  item: CartItemDto;
  reference: CartVariantReference | undefined;
  detailLoading: boolean;
  onQuantityChange: (item: CartItemDto, quantity: number) => Promise<void>;
  onRemove: (item: CartItemDto) => Promise<void>;
}

function CartLine({
  item,
  reference,
  detailLoading,
  onQuantityChange,
  onRemove,
}: CartLineProps) {
  const available = reference !== undefined;
  const unavailable = !detailLoading && reference === undefined;
  const [draft, setDraft] = useState(String(item.quantity));

  useEffect(() => {
    setDraft(String(item.quantity));
  }, [item.quantity]);

  function commitDraft(): void {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isNaN(parsed)) {
      setDraft(String(item.quantity));
      return;
    }
    const clamped = Math.min(
      CART_ITEM_QUANTITY_LIMITS.max,
      Math.max(CART_ITEM_QUANTITY_LIMITS.min, parsed),
    );
    setDraft(String(clamped));
    if (clamped !== item.quantity) {
      void onQuantityChange(item, clamped);
    }
  }

  async function adjust(amount: number): Promise<void> {
    const next = item.quantity + amount;
    if (next < CART_ITEM_QUANTITY_LIMITS.min || next > CART_ITEM_QUANTITY_LIMITS.max) {
      return;
    }
    await onQuantityChange(item, next);
  }

  const unitPrice =
    reference !== undefined
      ? formatCents(reference.variant.priceAmountCents, reference.variant.currency)
      : null;
  const lineTotal =
    reference !== undefined
      ? formatCents(reference.variant.priceAmountCents * item.quantity, reference.variant.currency)
      : null;

  return (
    <div className={unavailable ? "cart-line cart-line--unavailable" : "cart-line"}>
      <div className="cart-line-media">
        {reference !== undefined && reference.product.images.length > 0 ? (
          <img
            src={reference.product.images[0]!.url}
            alt={reference.product.images[0]!.altText ?? reference.product.name}
          />
        ) : (
          <img className="product-watermark" src="/assets/zelora-mark.svg" alt="" width="48" height="48" />
        )}
      </div>

      <div className="cart-line-info">
        {detailLoading ? (
          <>
            <span className="cart-line-title">Loading product details…</span>
            <p className="cart-line-variant muted">Matching this line with the catalog…</p>
          </>
        ) : reference !== undefined ? (
          <>
            <Link className="cart-line-title" to={`/catalog/products/${reference.product.slug}`}>
              {reference.product.name}
            </Link>
            <span className="cart-line-store">{reference.product.store.name}</span>
            <p className="cart-line-variant">
              {reference.variant.name}
              {reference.variant.sku !== null && (
                <span className="muted"> · SKU {reference.variant.sku}</span>
              )}
            </p>
          </>
        ) : (
          <>
            <span className="cart-line-title">Unavailable item</span>
            <p className="cart-line-variant muted">
              Variant {item.variantId} is no longer on sale. You can remove it.
            </p>
          </>
        )}
      </div>

      <div className="cart-line-price">
        {unitPrice !== null && <span className="cart-line-unit">{unitPrice}</span>}
        {lineTotal !== null && (
          <span className={available ? "cart-line-total" : "cart-line-total muted"}>
            {lineTotal}
          </span>
        )}
      </div>

      <div className="cart-quantity">
        <button
          type="button"
          className="qty-btn"
          aria-label="Decrease quantity"
          onClick={() => void adjust(-1)}
          disabled={item.quantity <= CART_ITEM_QUANTITY_LIMITS.min}
        >
          −
        </button>
        <input
          type="number"
          className="qty-input"
          value={draft}
          min={CART_ITEM_QUANTITY_LIMITS.min}
          max={CART_ITEM_QUANTITY_LIMITS.max}
          aria-label={`Quantity of ${reference !== undefined ? reference.product.name : "this item"}`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className="qty-btn"
          aria-label="Increase quantity"
          onClick={() => void adjust(1)}
          disabled={item.quantity >= CART_ITEM_QUANTITY_LIMITS.max}
        >
          +
        </button>
      </div>

      <button
        type="button"
        className="cart-line-remove"
        onClick={() => void onRemove(item)}
        aria-label={`Remove ${reference !== undefined ? reference.product.name : "this item"}`}
      >
        Remove
      </button>
    </div>
  );
}