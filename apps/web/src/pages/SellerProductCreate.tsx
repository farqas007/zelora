import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  CURRENCY_PATTERN,
  DEFAULT_PRODUCT_CURRENCY,
  INVENTORY_LIMITS,
  PRODUCT_LIMITS,
  PRODUCT_SLUG_PATTERN,
  PRODUCT_VARIANT_LIMITS,
  SKU_PATTERN,
  type CatalogCategoryDto,
  type CreateProductVariantRequest,
  type InventoryDto,
  type ProductDto,
  type ProductVariantDto,
} from "@zelora/shared";
import { FormField } from "../components/FormField";
import { LoadingState } from "../components/LoadingState";
import { PageShell } from "../components/PageShell";
import { useAuth } from "../context/AuthContext";
import { ApiFailureError } from "../lib/api/client";
import { resolveApiFailure } from "../lib/auth/errors";
import { formatCents } from "../lib/format";

/**
 * Seller product-creation wizard: create a `draft` product, add a sellable
 * variant, set its inventory, then publish. Each step posts the shared
 * contract to the corresponding seller endpoint after mirroring the API's
 * server-side validation limits.
 */

/** Parse a dollars string ("49.95") into integer cents, or null when invalid. */
function dollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [whole, fraction] = trimmed.split(".");
  return Number(whole) * 100 + (fraction === undefined ? 0 : Number(fraction.padEnd(2, "0")));
}

export function SellerProductCreatePage() {
  const { status, user, api } = useAuth();

  const [categories, setCategories] = useState<CatalogCategoryDto[] | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<ProductDto | null>(null);

  const [variantName, setVariantName] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [compareAt, setCompareAt] = useState("");
  const [currency, setCurrency] = useState(DEFAULT_PRODUCT_CURRENCY);
  const [quantity, setQuantity] = useState("");
  const [variant, setVariant] = useState<ProductVariantDto | null>(null);
  const [inventory, setInventory] = useState<InventoryDto | null>(null);

  const [variantErrors, setVariantErrors] = useState<Record<string, string[]>>({});
  const [variantError, setVariantError] = useState<string | null>(null);
  const [variantSubmitting, setVariantSubmitting] = useState(false);
  const [inventoryErrors, setInventoryErrors] = useState<Record<string, string[]>>({});
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventorySubmitting, setInventorySubmitting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .listCatalogCategories()
      .then((envelope) => {
        if (active && envelope.ok) {
          setCategories(envelope.data);
        }
      })
      .catch(() => {
        if (active) {
          setCategories([]);
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  function validateBeforeSubmit(): Record<string, string[]> {
    const errors: Record<string, string[]> = {};
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      errors.name = ["Product name is required."];
    } else if (
      trimmedName.length < PRODUCT_LIMITS.nameMinLength ||
      trimmedName.length > PRODUCT_LIMITS.nameMaxLength
    ) {
      errors.name = [
        `Product name must be between ${PRODUCT_LIMITS.nameMinLength} and ${PRODUCT_LIMITS.nameMaxLength} characters.`,
      ];
    }

    const normalizedSlug = slug.trim().toLowerCase();
    if (normalizedSlug.length < PRODUCT_LIMITS.slugMinLength || normalizedSlug.length > PRODUCT_LIMITS.slugMaxLength) {
      errors.slug = [
        `Product slug must be between ${PRODUCT_LIMITS.slugMinLength} and ${PRODUCT_LIMITS.slugMaxLength} characters.`,
      ];
    } else if (!PRODUCT_SLUG_PATTERN.test(normalizedSlug)) {
      errors.slug = ["Product slug is invalid."];
    }

    if (description.length > PRODUCT_LIMITS.descriptionMaxLength) {
      errors.description = [
        `Description must be at most ${PRODUCT_LIMITS.descriptionMaxLength} characters.`,
      ];
    }
    return errors;
  }

  function validateVariantBeforeSubmit(): Record<string, string[]> {
    const errors: Record<string, string[]> = {};
    const trimmedName = variantName.trim();
    if (trimmedName.length === 0) {
      errors.variantName = ["Variant name is required."];
    } else if (
      trimmedName.length < PRODUCT_VARIANT_LIMITS.nameMinLength ||
      trimmedName.length > PRODUCT_VARIANT_LIMITS.nameMaxLength
    ) {
      errors.variantName = [
        `Variant name must be between ${PRODUCT_VARIANT_LIMITS.nameMinLength} and ${PRODUCT_VARIANT_LIMITS.nameMaxLength} characters.`,
      ];
    }

    const trimmedSku = sku.trim();
    if (trimmedSku.length > 0 && !SKU_PATTERN.test(trimmedSku)) {
      errors.sku = ["SKU is invalid."];
    }

    const priceCents = dollarsToCents(price);
    if (priceCents === null) {
      errors.price = ["Enter a valid price with up to two decimal places."];
    } else if (
      priceCents < PRODUCT_VARIANT_LIMITS.priceAmountCentsMin ||
      priceCents > PRODUCT_VARIANT_LIMITS.priceAmountCentsMax
    ) {
      errors.price = ["Enter a price within the allowed range."];
    }

    const trimmedCompareAt = compareAt.trim();
    if (trimmedCompareAt.length > 0) {
      const compareCents = dollarsToCents(trimmedCompareAt);
      if (compareCents === null) {
        errors.compareAt = ["Enter a valid compare-at price with up to two decimal places."];
      } else if (
        compareCents < PRODUCT_VARIANT_LIMITS.compareAtAmountCentsMin ||
        compareCents > PRODUCT_VARIANT_LIMITS.compareAtAmountCentsMax
      ) {
        errors.compareAt = ["Enter a compare-at price within the allowed range."];
      }
    }

    const trimmedCurrency = currency.trim();
    if (trimmedCurrency.length > 0 && !CURRENCY_PATTERN.test(trimmedCurrency)) {
      errors.currency = ["Currency must be a 3-letter code like USD."];
    }
    return errors;
  }

  function validateInventoryBeforeSubmit(): Record<string, string[]> {
    const errors: Record<string, string[]> = {};
    const trimmed = quantity.trim();
    if (!/^\d+$/.test(trimmed)) {
      errors.quantity = ["Quantity must be a whole number."];
      return errors;
    }
    const parsed = Number(trimmed);
    if (parsed < INVENTORY_LIMITS.quantityMin || parsed > INVENTORY_LIMITS.quantityMax) {
      errors.quantity = [
        `Quantity must be between ${INVENTORY_LIMITS.quantityMin} and ${INVENTORY_LIMITS.quantityMax}.`,
      ];
    } else if (parsed < 1) {
      errors.quantity = ["Set at least 1 unit to publish."];
    }
    return errors;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const errors = validateBeforeSubmit();
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      const envelope = await api.createProduct({
        name: name.trim(),
        slug: slug.trim().toLowerCase(),
        description: description.trim() === "" ? undefined : description.trim(),
        categoryId: categoryId === "" ? undefined : categoryId,
      });
      if (envelope.ok) {
        setCreated(envelope.data);
        setSubmitting(false);
        return;
      }
      const resolved = resolveApiFailure(new ApiFailureError(envelope.error));
      setFormError(resolved.message);
      if (Object.keys(resolved.fields).length > 0) {
        setFieldErrors((current) => ({ ...current, ...resolved.fields }));
      }
      setSubmitting(false);
    } catch (error) {
      const resolved = resolveApiFailure(error);
      setFormError(resolved.message);
      if (Object.keys(resolved.fields).length > 0) {
        setFieldErrors((current) => ({ ...current, ...resolved.fields }));
      }
      setSubmitting(false);
    }
  }

  async function onVariantSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (variantSubmitting || created === null) {
      return;
    }

    const errors = validateVariantBeforeSubmit();
    setVariantErrors(errors);
    setVariantError(null);
    if (Object.keys(errors).length > 0) {
      return;
    }

    const priceCents = dollarsToCents(price);
    const trimmedCompareAt = compareAt.trim();
    const compareCents = trimmedCompareAt === "" ? undefined : dollarsToCents(trimmedCompareAt);
    if (priceCents === null || (trimmedCompareAt !== "" && compareCents === null)) {
      return;
    }

    setVariantSubmitting(true);
    try {
      const trimmedSku = sku.trim();
      const trimmedCurrency = currency.trim();
      const request: CreateProductVariantRequest = {
        name: variantName.trim(),
        sku: trimmedSku === "" ? undefined : trimmedSku,
        priceAmountCents: priceCents,
        currency: trimmedCurrency === "" ? undefined : trimmedCurrency.toUpperCase(),
      };
      if (compareCents !== undefined && compareCents !== null) {
        request.compareAtAmountCents = compareCents;
      }
      const envelope = await api.createProductVariant(created.id, request);
      if (envelope.ok) {
        setVariant(envelope.data);
        setVariantSubmitting(false);
        return;
      }
      const resolved = resolveApiFailure(new ApiFailureError(envelope.error));
      setVariantError(resolved.message);
      if (Object.keys(resolved.fields).length > 0) {
        setVariantErrors((current) => ({ ...current, ...resolved.fields }));
      }
      setVariantSubmitting(false);
    } catch (error) {
      const resolved = resolveApiFailure(error);
      setVariantError(resolved.message);
      if (Object.keys(resolved.fields).length > 0) {
        setVariantErrors((current) => ({ ...current, ...resolved.fields }));
      }
      setVariantSubmitting(false);
    }
  }

  async function onInventorySubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inventorySubmitting || created === null || variant === null) {
      return;
    }

    const errors = validateInventoryBeforeSubmit();
    setInventoryErrors(errors);
    setInventoryError(null);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setInventorySubmitting(true);
    try {
      const envelope = await api.setProductInventory(created.id, variant.id, {
        quantity: Number(quantity.trim()),
      });
      if (envelope.ok) {
        setInventory(envelope.data);
        setInventorySubmitting(false);
        return;
      }
      const resolved = resolveApiFailure(new ApiFailureError(envelope.error));
      setInventoryError(resolved.message);
      if (Object.keys(resolved.fields).length > 0) {
        setInventoryErrors((current) => ({ ...current, ...resolved.fields }));
      }
      setInventorySubmitting(false);
    } catch (error) {
      const resolved = resolveApiFailure(error);
      setInventoryError(resolved.message);
      if (Object.keys(resolved.fields).length > 0) {
        setInventoryErrors((current) => ({ ...current, ...resolved.fields }));
      }
      setInventorySubmitting(false);
    }
  }

  async function onPublish(): Promise<void> {
    if (publishing || created === null) {
      return;
    }
    setPublishing(true);
    setPublishError(null);
    try {
      const envelope = await api.publishProduct(created.id);
      if (envelope.ok) {
        setPublished(true);
        setPublishing(false);
        return;
      }
      const resolved = resolveApiFailure(new ApiFailureError(envelope.error));
      setPublishError(resolved.message);
      setPublishing(false);
    } catch (error) {
      const resolved = resolveApiFailure(error);
      setPublishError(resolved.message);
      setPublishing(false);
    }
  }

  if (status === "loading") {
    return (
      <PageShell title="Create a product">
        <LoadingState label="Checking session…" />
      </PageShell>
    );
  }

  if (created !== null) {
    return (
      <PageShell title="Create a product">
        <div className="dashboard">
          <section className="user-card" aria-labelledby="created-heading">
            <h2 id="created-heading">Product created</h2>
            <p>
              <strong>{created.name}</strong> is saved as a <span className="badge">{created.status}</span>.
            </p>
            <p className="muted">
              Slug: <code>{created.slug}</code>
            </p>
          </section>

          {variant === null ? (
            <section className="user-card" aria-labelledby="variant-heading">
              <h3 id="variant-heading">Step 1 of 3 — Add a sellable variant</h3>
              {variantError !== null && (
                <p className="form-alert" role="alert">
                  {variantError}
                </p>
              )}
              <form className="auth-form" onSubmit={onVariantSubmit} noValidate>
                <FormField
                  id="variantName"
                  label="Variant name"
                  type="text"
                  value={variantName}
                  onChange={setVariantName}
                  error={variantErrors.variantName?.[0]}
                  maxLength={PRODUCT_VARIANT_LIMITS.nameMaxLength}
                  required
                />
                <FormField
                  id="sku"
                  label="SKU"
                  type="text"
                  value={sku}
                  onChange={setSku}
                  error={variantErrors.sku?.[0]}
                  hint="Optional. Must be unique when provided."
                  maxLength={PRODUCT_VARIANT_LIMITS.skuMaxLength}
                />
                <FormField
                  id="price"
                  label={`Price (${currency.trim() === "" ? DEFAULT_PRODUCT_CURRENCY : currency.trim().toUpperCase()})`}
                  type="text"
                  value={price}
                  onChange={setPrice}
                  error={variantErrors.price?.[0]}
                  hint="Dollars and cents, e.g. 49.95."
                  required
                />
                <FormField
                  id="compareAt"
                  label="Compare-at price"
                  type="text"
                  value={compareAt}
                  onChange={setCompareAt}
                  error={variantErrors.compareAt?.[0]}
                  hint="Optional. Shown struck through."
                />
                <FormField
                  id="currency"
                  label="Currency"
                  type="text"
                  value={currency}
                  onChange={setCurrency}
                  error={variantErrors.currency?.[0]}
                  hint="3-letter code such as USD."
                  maxLength={3}
                />
                <div className="button-row">
                  <button type="submit" className="btn btn-primary btn-block" disabled={variantSubmitting}>
                    {variantSubmitting ? "Adding variant…" : "Add variant"}
                  </button>
                </div>
              </form>
            </section>
          ) : inventory === null ? (
            <section className="user-card" aria-labelledby="inventory-heading">
              <h3 id="inventory-heading">Step 2 of 3 — Set inventory</h3>
              <p className="muted">
                Variant <strong>{variant.name}</strong> at{" "}
                {formatCents(variant.priceAmountCents, variant.currency)}
                {variant.compareAtAmountCents !== null
                  ? ` (compare at ${formatCents(variant.compareAtAmountCents, variant.currency)})`
                  : ""}
                .
              </p>
              {inventoryError !== null && (
                <p className="form-alert" role="alert">
                  {inventoryError}
                </p>
              )}
              <form className="auth-form" onSubmit={onInventorySubmit} noValidate>
                <FormField
                  id="quantity"
                  label="Available quantity"
                  type="text"
                  value={quantity}
                  onChange={setQuantity}
                  error={inventoryErrors.quantity?.[0]}
                  hint="Set at least 1 unit to publish."
                  required
                />
                <div className="button-row">
                  <button type="submit" className="btn btn-primary btn-block" disabled={inventorySubmitting}>
                    {inventorySubmitting ? "Saving inventory…" : "Save inventory"}
                  </button>
                </div>
              </form>
            </section>
          ) : published ? (
            <section className="user-card" aria-labelledby="published-heading">
              <h3 id="published-heading">
                Product is <span className="badge">published</span>
              </h3>
              <p>
                <strong>{created.name}</strong> is live on the storefront with{" "}
                <strong>{inventory.quantity}</strong> units of{" "}
                <strong>{variant.name}</strong> in stock.
              </p>
            </section>
          ) : (
            <section className="user-card" aria-labelledby="publish-heading">
              <h3 id="publish-heading">Step 3 of 3 — Publish</h3>
              <p className="muted">
                Variant <strong>{variant.name}</strong> at{" "}
                {formatCents(variant.priceAmountCents, variant.currency)},{" "}
                <strong>{inventory.quantity}</strong> units in stock. Publishing makes the product
                visible on the storefront.
              </p>
              {publishError !== null && (
                <p className="form-alert" role="alert">
                  {publishError}
                </p>
              )}
              <div className="button-row">
                <button type="button" className="btn btn-primary btn-block" onClick={onPublish} disabled={publishing}>
                  {publishing ? "Publishing…" : "Publish product"}
                </button>
              </div>
            </section>
          )}

          <ul className="dashboard-actions">
            <li>
              <Link to="/seller/products/new">Create another product</Link>
            </li>
            <li>
              <Link to="/dashboard">Back to dashboard</Link>
            </li>
          </ul>
        </div>
      </PageShell>
    );
  }

  if (status !== "authenticated" || user === null) {
    return (
      <PageShell title="Create a product">
        <p className="muted">
          You are not signed in. <Link to="/login">Sign in</Link> to continue.
        </p>
      </PageShell>
    );
  }

  if (user.role !== "seller") {
    return (
      <PageShell title="Create a product">
        <p className="form-alert" role="alert">
          Only approved sellers can create products.
        </p>
        <p>
          <Link to="/dashboard">Back to dashboard</Link>
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell title="Create a product">
      {formError !== null && (
        <p className="form-alert" role="alert">
          {formError}
        </p>
      )}

      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <FormField
          id="name"
          label="Product name"
          type="text"
          value={name}
          onChange={setName}
          error={fieldErrors.name?.[0]}
          maxLength={PRODUCT_LIMITS.nameMaxLength}
          required
        />
        <FormField
          id="slug"
          label="Slug"
          type="text"
          value={slug}
          onChange={setSlug}
          error={fieldErrors.slug?.[0]}
          hint={`Lowercase letters, numbers and hyphens (${PRODUCT_LIMITS.slugMinLength}–${PRODUCT_LIMITS.slugMaxLength}).`}
          maxLength={PRODUCT_LIMITS.slugMaxLength}
          required
        />

        <div className="form-field">
          <label htmlFor="description">Description</label>
          <textarea
            id="description"
            name="description"
            value={description}
            maxLength={PRODUCT_LIMITS.descriptionMaxLength}
            rows={4}
            className={fieldErrors.description !== undefined ? "has-error" : undefined}
            aria-invalid={fieldErrors.description !== undefined ? true : undefined}
            aria-describedby={
              fieldErrors.description !== undefined
                ? "description-error"
                : "description-hint"
            }
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value)}
          />
          {fieldErrors.description === undefined ? (
            <p id="description-hint" className="field-hint">
              Optional. Up to {PRODUCT_LIMITS.descriptionMaxLength} characters.
            </p>
          ) : (
            <p id="description-error" className="field-error">
              {fieldErrors.description[0]}
            </p>
          )}
        </div>

        <div className="form-field">
          <label htmlFor="categoryId">Category</label>
          <select
            id="categoryId"
            name="categoryId"
            value={categoryId}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => setCategoryId(event.target.value)}
          >
            <option value="">No category</option>
            {(categories ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <p id="categoryId-hint" className="field-hint">
            Optional.
          </p>
        </div>

        <div className="button-row">
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? "Creating product…" : "Create product"}
          </button>
        </div>
      </form>

      <p className="muted">
        New products are saved as drafts and will not appear on the storefront
        until they have a variant with inventory and are published. Back to <Link to="/dashboard">dashboard</Link>.
      </p>
    </PageShell>
  );
}