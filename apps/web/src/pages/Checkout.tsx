import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CHECKOUT_LIMITS, type OrderAddressRequest } from "@zelora/shared";
import { FormField } from "../components/FormField";
import { LoadingState } from "../components/LoadingState";
import { MarketFooter } from "../components/MarketFooter";
import { MarketHeader } from "../components/MarketHeader";
import { useAuth } from "../context/AuthContext";
import { useCart } from "../context/CartContext";
import { ApiFailureError } from "../lib/api/client";
import { loadCartVariantLookup, type CartVariantReference } from "../lib/cart/catalog";
import { resolveOrderFailure } from "../lib/orders/errors";
import { formatCents } from "../lib/format";

const MAX_SHORT = CHECKOUT_LIMITS.line1MaxLength;
const MAX_PHONE = CHECKOUT_LIMITS.phoneMaxLength;
const MAX_LONG = CHECKOUT_LIMITS.line2MaxLength;
const MAX_POSTAL = CHECKOUT_LIMITS.postalCodeMaxLength;

/**
 * One address form's raw input. Optional fields stay strings here and are
 * trimmed/omitted when the request is built, mirroring the server's own
 * trim-then-collect rules so an empty optional field never travels in the body.
 */
export interface AddressForm {
  recipientName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}

const EMPTY_ADDRESS: AddressForm = {
  recipientName: "",
  phone: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  countryCode: "",
};

const ADDRESS_LABELS: Record<keyof AddressForm, string> = {
  recipientName: "Recipient name",
  phone: "Phone",
  line1: "Address line 1",
  line2: "Address line 2",
  city: "City",
  region: "Region",
  postalCode: "Postal code",
  countryCode: "Country code",
};

const SHIPPING_REQUIRED: ReadonlyArray<keyof AddressForm> = [
  "recipientName",
  "line1",
  "city",
  "countryCode",
];

/** Trim every value and lift non-empty optional fields onto the request. */
export function toAddressRequest(form: AddressForm): OrderAddressRequest {
  const address: OrderAddressRequest = {
    recipientName: form.recipientName.trim(),
    line1: form.line1.trim(),
    city: form.city.trim(),
    countryCode: form.countryCode.trim().toUpperCase(),
  };
  if (form.phone.trim() !== "") address.phone = form.phone.trim();
  if (form.line2.trim() !== "") address.line2 = form.line2.trim();
  if (form.region.trim() !== "") address.region = form.region.trim();
  if (form.postalCode.trim() !== "") address.postalCode = form.postalCode.trim();
  return address;
}

/**
 * Checkout page. Builds the `PlaceOrderRequest` address snapshots, submits via
 * the authenticated API client (CSRF token attached automatically), and on
 * success clears the server cart and routes to the confirmation page with the
 * returned {@link OrderDetailDto}. Order totals are never trusted here: the
 * server re-prices every line from live catalog data and the summary below is
 * derived from the same public catalog lookup the cart page uses.
 *
 * No payment is collected: checkout persists the order and atomically
 * decrements inventory, which is the whole payment-adjacent surface of Phase
 * A.
 */
export function CheckoutPage() {
  const { api } = useAuth();
  const { cart, itemCount, refresh } = useCart();
  const navigate = useNavigate();

  const items = cart?.items ?? [];
  const [shipping, setShipping] = useState<AddressForm>(EMPTY_ADDRESS);
  const [billing, setBilling] = useState<AddressForm>(EMPTY_ADDRESS);
  const [billingDiffers, setBillingDiffers] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lookup, setLookup] = useState<Map<string, CartVariantReference> | null>(null);

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

  const subtotal = (() => {
    if (lookup === null) {
      return null;
    }
    let total = 0;
    let currency: string | null = null;
    for (const item of items) {
      const reference = lookup.get(item.variantId);
      if (reference === undefined) {
        return null;
      }
      if (currency !== null && currency !== reference.variant.currency) {
        return null;
      }
      currency = reference.variant.currency;
      total += reference.variant.priceAmountCents * item.quantity;
    }
    return currency === null ? null : { total, currency };
  })();

  function fieldError(prefix: "shippingAddress" | "billingAddress", name: keyof AddressForm): string | undefined {
    return fieldErrors[`${prefix}.${name}`]?.[0];
  }

  function onShippingFieldChange(name: keyof AddressForm, value: string): void {
    setShipping((current) => ({
      ...current,
      [name]: name === "countryCode" ? value.toUpperCase() : value,
    }));
  }

  function onBillingFieldChange(name: keyof AddressForm, value: string): void {
    setBilling((current) => ({
      ...current,
      [name]: name === "countryCode" ? value.toUpperCase() : value,
    }));
  }

  function validateAddress(form: AddressForm): Record<string, string[]> {
    const errors: Record<string, string[]> = {};
    for (const name of SHIPPING_REQUIRED) {
      if (form[name].trim() === "") {
        errors[name] = [`${ADDRESS_LABELS[name]} is required.`];
      }
    }
    if (form.countryCode.trim() !== "" && !/^[A-Za-z]{2}$/.test(form.countryCode.trim())) {
      errors.countryCode = ["Country code must be 2 letters, e.g. US."];
    }
    return errors;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || cart === null || items.length === 0) {
      return;
    }
    setFieldErrors({});
    setFormError(null);

    const errors: Record<string, string[]> = {};
    for (const [prefix, form] of [
      ["shippingAddress", shipping],
      ["billingAddress", billing],
    ] as const) {
      if (prefix === "billingAddress" && !billingDiffers) {
        continue;
      }
      const addressErrors = validateAddress(form);
      for (const [name, messages] of Object.entries(addressErrors)) {
        errors[`${prefix}.${name}`] = messages;
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setFormError("Please fix the highlighted fields and try again.");
      return;
    }

    setSubmitting(true);
    try {
      const envelope = await api.placeOrder({
        shippingAddress: toAddressRequest(shipping),
        ...(billingDiffers ? { billingAddress: toAddressRequest(billing) } : {}),
      });
      if (!envelope.ok) {
        throw new ApiFailureError(envelope.error);
      }
      await refresh();
      navigate("/checkout/confirmation", { state: { order: envelope.data }, replace: true });
    } catch (cause) {
      if (cause instanceof ApiFailureError && cause.code === "VALIDATION_ERROR" && cause.fields !== undefined) {
        setFieldErrors(cause.fields);
      }
      setFormError(resolveOrderFailure(cause));
      setSubmitting(false);
    }
  }

  const empty = cart === null || items.length === 0;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <MarketHeader />
      <main id="main-content" className="main catalog-main">
        <div className="cart-head">
          <h1>Checkout</h1>
          <p className="muted">No payment is collected — this marketplace is still in Phase 1.</p>
        </div>

        {empty ? (
          <div className="catalog-empty">
            <h2>Your cart is empty</h2>
            <p>Add something to your cart before checking out.</p>
            <Link className="btn btn-primary" to="/catalog">
              Browse the catalog
            </Link>
          </div>
        ) : (
          <div className="checkout-layout">
            <form className="auth-card checkout-form" onSubmit={onSubmit} noValidate>
              {formError !== null && (
                <p className="form-alert" role="alert">
                  {formError}
                </p>
              )}

              <AddressFields
                legend="Shipping address"
                prefix="shippingAddress"
                value={shipping}
                fieldError={(name) => fieldError("shippingAddress", name)}
                onFieldChange={onShippingFieldChange}
              />

              <label className="checkout-toggle">
                <input
                  type="checkbox"
                  checked={billingDiffers}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setBillingDiffers(event.target.checked)
                  }
                />
                Billing address differs from shipping
              </label>

              {billingDiffers && (
                <AddressFields
                  legend="Billing address"
                  prefix="billingAddress"
                  value={billing}
                  fieldError={(name) => fieldError("billingAddress", name)}
                  onFieldChange={onBillingFieldChange}
                />
              )}

              <div className="button-row">
                <button
                  type="submit"
                  className="btn btn-primary btn-block"
                  disabled={submitting || lookup === null}
                >
                  {submitting ? "Placing order…" : "Place order"}
                </button>
              </div>
            </form>

            <aside className="checkout-summary" aria-label="Order summary">
              {subtotal === null ? (
                <LoadingState label="Calculating total…" />
              ) : (
                <>
                  <h2>Order summary</h2>
                  <p className="muted">
                    {itemCount} {itemCount === 1 ? "item" : "items"}
                  </p>
                  <p className="checkout-total">
                    Subtotal{" "}
                    <strong>{formatCents(subtotal.total, subtotal.currency)}</strong>
                  </p>
                  <p className="muted">Shipping and discounts are calculated at checkout.</p>
                  <Link className="btn" to="/cart">
                    Back to cart
                  </Link>
                </>
              )}
            </aside>
          </div>
        )}
      </main>
      <MarketFooter />
    </div>
  );
}

interface AddressFieldsProps {
  legend: string;
  prefix: string;
  value: AddressForm;
  fieldError: (name: keyof AddressForm) => string | undefined;
  onFieldChange: (name: keyof AddressForm, value: string) => void;
}

function AddressFields({ legend, prefix, value, fieldError, onFieldChange }: AddressFieldsProps) {
  return (
    <fieldset className="checkout-fieldset">
      <legend>{legend}</legend>
      <FormField
        id={`${prefix}-recipientName`}
        label={ADDRESS_LABELS.recipientName}
        value={value.recipientName}
        onChange={(next) => onFieldChange("recipientName", next)}
        error={fieldError("recipientName")}
        autoComplete="name"
        maxLength={CHECKOUT_LIMITS.recipientNameMaxLength}
        required={SHIPPING_REQUIRED.includes("recipientName")}
      />
      <FormField
        id={`${prefix}-phone`}
        label={ADDRESS_LABELS.phone}
        value={value.phone}
        onChange={(next) => onFieldChange("phone", next)}
        error={fieldError("phone")}
        autoComplete="tel"
        maxLength={MAX_PHONE}
      />
      <FormField
        id={`${prefix}-line1`}
        label={ADDRESS_LABELS.line1}
        value={value.line1}
        onChange={(next) => onFieldChange("line1", next)}
        error={fieldError("line1")}
        autoComplete="address-line1"
        maxLength={MAX_SHORT}
        required={SHIPPING_REQUIRED.includes("line1")}
      />
      <FormField
        id={`${prefix}-line2`}
        label={ADDRESS_LABELS.line2}
        value={value.line2}
        onChange={(next) => onFieldChange("line2", next)}
        error={fieldError("line2")}
        autoComplete="address-line2"
        maxLength={MAX_LONG}
      />
      <FormField
        id={`${prefix}-city`}
        label={ADDRESS_LABELS.city}
        value={value.city}
        onChange={(next) => onFieldChange("city", next)}
        error={fieldError("city")}
        autoComplete="address-level2"
        maxLength={CHECKOUT_LIMITS.cityMaxLength}
        required={SHIPPING_REQUIRED.includes("city")}
      />
      <FormField
        id={`${prefix}-region`}
        label={ADDRESS_LABELS.region}
        value={value.region}
        onChange={(next) => onFieldChange("region", next)}
        error={fieldError("region")}
        autoComplete="address-level1"
        maxLength={MAX_LONG}
      />
      <FormField
        id={`${prefix}-postalCode`}
        label={ADDRESS_LABELS.postalCode}
        value={value.postalCode}
        onChange={(next) => onFieldChange("postalCode", next)}
        error={fieldError("postalCode")}
        autoComplete="postal-code"
        maxLength={MAX_POSTAL}
      />
      <FormField
        id={`${prefix}-countryCode`}
        label={ADDRESS_LABELS.countryCode}
        value={value.countryCode}
        onChange={(next) => onFieldChange("countryCode", next)}
        error={fieldError("countryCode")}
        autoComplete="country"
        maxLength={2}
        hint="2-letter country code, e.g. US"
        required={SHIPPING_REQUIRED.includes("countryCode")}
      />
    </fieldset>
  );
}