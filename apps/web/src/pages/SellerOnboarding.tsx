import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  AUTH_ERROR_CODES,
  AUTH_LIMITS,
  type SellerOnboardingData,
} from "@zelora/shared";
import { FormField } from "../components/FormField";
import { LoadingState } from "../components/LoadingState";
import { PageShell } from "../components/PageShell";
import { useAuth } from "../context/AuthContext";
import { ApiFailureError } from "../lib/api/client";
import { resolveApiFailure } from "../lib/auth/errors";
import { validateSellerOnboarding, type FieldErrors } from "../lib/auth/validation";

/**
 * Seller onboarding form for an authenticated customer.
 *
 * Submits exactly the four shared `SellerOnboardingRequest` fields — never
 * `userId`, `role`, `status` or any ownership field — through
 * `api.onboardSeller()`, which carries the in-memory CSRF token. On HTTP 201
 * the returned profile (`pending`) and store (`draft`) are shown as a
 * "pending approval" success state: the account is not yet a seller, so the
 * page never presents the user as approved.
 */

/** Map the API's 409 `SLUG_IN_USE` message to the field that collided. */
function slugInUseField(message: string): "slug" | "storeSlug" | null {
  if (message.includes("seller profile with this slug")) {
    return "slug";
  }
  if (message.includes("store with this slug")) {
    return "storeSlug";
  }
  return null;
}

export function SellerOnboardingPage() {
  const { status, user, api } = useAuth();

  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeSlug, setStoreSlug] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<SellerOnboardingData | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const errors = validateSellerOnboarding(slug, displayName, storeName, storeSlug);
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      const envelope = await api.onboardSeller({
        slug: slug.trim().toLowerCase(),
        displayName: displayName.trim(),
        storeName: storeName.trim(),
        storeSlug: storeSlug.trim().toLowerCase(),
      });
      if (!envelope.ok) {
        throw new ApiFailureError(envelope.error);
      }
      setSubmitted(envelope.data);
    } catch (error) {
      const resolved = resolveApiFailure(error);
      setFormError(resolved.message);

      const nextFields: FieldErrors = { ...(resolved.fields ?? {}) };
      if (error instanceof ApiFailureError && error.code === AUTH_ERROR_CODES.SLUG_IN_USE) {
        const field = slugInUseField(error.message);
        if (field !== null) {
          nextFields[field] = [resolved.message];
        }
      }
      setFieldErrors((current) => ({ ...current, ...nextFields }));
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "loading" || (status === "authenticated" && user === null)) {
    return (
      <PageShell title="Seller onboarding">
        <LoadingState label="Checking session…" />
      </PageShell>
    );
  }

  if (submitted !== null) {
    return (
      <PageShell title="Application submitted">
        <div className="dashboard">
          <section className="user-card" aria-labelledby="submitted-heading">
            <h2 id="submitted-heading">Application submitted</h2>
            <p>
              Your seller account is now <span className="badge">pending approval</span>.
            </p>
            <p className="muted">
              A store administrator will review your application. Once approved
              you will be able to create and publish products — meanwhile you
              can keep browsing and shopping.
            </p>
          </section>

          <section className="user-card" aria-labelledby="application-heading">
            <h3 id="application-heading">Your application</h3>
            <dl className="detail-list">
              <dt>Seller profile</dt>
              <dd>
                {submitted.sellerProfile.displayName}{" "}
                <span className="badge">{submitted.sellerProfile.status}</span>
              </dd>
              <dt>Profile slug</dt>
              <dd>
                <code>{submitted.sellerProfile.slug}</code>
              </dd>
              <dt>Store</dt>
              <dd>
                {submitted.store.name} <span className="badge">{submitted.store.status}</span>
              </dd>
              <dt>Store slug</dt>
              <dd>
                <code>{submitted.store.slug}</code>
              </dd>
            </dl>
          </section>

          <ul className="dashboard-actions">
            <li>
              <Link to="/dashboard">Back to dashboard</Link>
            </li>
            <li>
              <Link to="/">Back to home</Link>
            </li>
          </ul>
        </div>
      </PageShell>
    );
  }

  if (status !== "authenticated" || user === null) {
    return (
      <PageShell title="Seller onboarding">
        <p className="muted">
          You are not signed in. <Link to="/login">Sign in</Link> to continue.
        </p>
      </PageShell>
    );
  }

  if (user.role === "seller") {
    return (
      <PageShell title="Seller onboarding">
        <div className="dashboard">
          <section className="user-card" aria-labelledby="approved-heading">
            <h2 id="approved-heading">You are an approved seller</h2>
            <p>
              Your seller account is <span className="badge">active</span>. Start
              adding products to your store whenever you are ready.
            </p>
          </section>
          <ul className="dashboard-actions">
            <li>
              <Link to="/seller/products/new">Create a product</Link>
            </li>
            <li>
              <Link to="/dashboard">Back to dashboard</Link>
            </li>
          </ul>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="Seller onboarding">
      <p className="muted">
        Become a seller: submit your application below. Once a store
        administrator approves it you will be able to create and publish
        products.
      </p>

      {formError !== null && (
        <p className="form-alert" role="alert">
          {formError}
        </p>
      )}

      <div className="auth-card">
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          <FormField
            id="slug"
            label="Seller profile slug"
            type="text"
            value={slug}
            onChange={setSlug}
            error={fieldErrors.slug?.[0]}
            hint={`Lowercase letters, numbers and hyphens (${AUTH_LIMITS.slugMinLength}–${AUTH_LIMITS.slugMaxLength}). Forms your profile address.`}
            maxLength={AUTH_LIMITS.slugMaxLength}
            required
          />
          <FormField
            id="displayName"
            label="Display name"
            type="text"
            value={displayName}
            onChange={setDisplayName}
            error={fieldErrors.displayName?.[0]}
            hint={`Public name shown on your profile (up to ${AUTH_LIMITS.displayNameMaxLength} characters).`}
            maxLength={AUTH_LIMITS.displayNameMaxLength}
            required
          />
          <FormField
            id="storeName"
            label="Store name"
            type="text"
            value={storeName}
            onChange={setStoreName}
            error={fieldErrors.storeName?.[0]}
            hint={`Name of your store (up to ${AUTH_LIMITS.storeNameMaxLength} characters).`}
            maxLength={AUTH_LIMITS.storeNameMaxLength}
            required
          />
          <FormField
            id="storeSlug"
            label="Store slug"
            type="text"
            value={storeSlug}
            onChange={setStoreSlug}
            error={fieldErrors.storeSlug?.[0]}
            hint={`Lowercase letters, numbers and hyphens (${AUTH_LIMITS.slugMinLength}–${AUTH_LIMITS.slugMaxLength}). Forms your storefront address.`}
            maxLength={AUTH_LIMITS.slugMaxLength}
            required
          />

          <div className="button-row">
            <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
              {submitting ? "Submitting application…" : "Submit application"}
            </button>
          </div>
        </form>

        <div className="auth-links">
          <p>
            <Link to="/dashboard">Back to dashboard</Link>
          </p>
        </div>
      </div>
    </PageShell>
  );
}