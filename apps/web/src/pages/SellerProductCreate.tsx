import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  PRODUCT_LIMITS,
  PRODUCT_SLUG_PATTERN,
  type CatalogCategoryDto,
  type ProductDto,
} from "@zelora/shared";
import { FormField } from "../components/FormField";
import { LoadingState } from "../components/LoadingState";
import { PageShell } from "../components/PageShell";
import { useAuth } from "../context/AuthContext";
import { ApiFailureError } from "../lib/api/client";
import { resolveApiFailure } from "../lib/auth/errors";

/**
 * Seller product-creation form. Posts the shared `CreateProductRequest`
 * contract to `POST /api/seller/products`; the API resolves the seller's own
 * store server-side, so the form never sees or sends an ownership field. On
 * success the created `draft` product is shown without redirecting anywhere.
 */
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

  if (status === "loading") {
    return (
      <PageShell title="Create a product">
        <LoadingState label="Checking session…" />
      </PageShell>
    );
  }

  if (created !== null) {
    return (
      <PageShell title="Product created">
        <div className="dashboard">
          <section className="user-card" aria-labelledby="created-heading">
            <h2 id="created-heading">Product created</h2>
            <p>
              <strong>{created.name}</strong> is saved as a <span className="badge">draft</span>.
            </p>
            <p className="muted">
              Slug: <code>{created.slug}</code>
            </p>
          </section>
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
        until they are published. Back to <Link to="/dashboard">dashboard</Link>.
      </p>
    </PageShell>
  );
}