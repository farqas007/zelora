import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { AUTH_LIMITS } from "@zelora/shared";
import { FormField } from "../components/FormField";
import { LoadingState } from "../components/LoadingState";
import { PageShell } from "../components/PageShell";
import { useAuth } from "../context/AuthContext";
import { resolveApiFailure } from "../lib/auth/errors";
import { validateRegister, type FieldErrors } from "../lib/auth/validation";

/**
 * Account creation form. Submits the shared `RegisterRequest` contract
 * (name + email + password) plus a client-side confirm-password check through
 * the AuthContext, which applies the returned user + in-memory CSRF token
 * before redirecting to the dashboard. No tokens are persisted to storage.
 */
export function RegisterPage() {
  const { status, register } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === "loading") {
    return (
      <PageShell title="Create an account">
        <LoadingState label="Checking session…" />
      </PageShell>
    );
  }
  if (status === "authenticated") {
    return <Navigate to="/dashboard" replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const errors = validateRegister(name, email, password, confirmPassword);
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      await register({ name, email, password });
      navigate("/dashboard", { replace: true });
    } catch (error) {
      const resolved = resolveApiFailure(error);
      setFormError(resolved.message);
      if (Object.keys(resolved.fields).length > 0) {
        setFieldErrors((current) => ({ ...current, ...resolved.fields }));
      }
      setSubmitting(false);
    }
  }

  return (
    <PageShell title="Create an account">
      <div className="auth-card">
        {formError !== null && (
          <p className="form-alert" role="alert">
            {formError}
          </p>
        )}

        <form className="auth-form" onSubmit={onSubmit} noValidate>
          <FormField
            id="name"
            label="Name"
            type="text"
            value={name}
            onChange={setName}
            error={fieldErrors.name?.[0]}
            autoComplete="name"
            maxLength={80}
            required
          />
          <FormField
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            error={fieldErrors.email?.[0]}
            autoComplete="email"
            maxLength={254}
            required
          />
          <FormField
            id="password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            error={fieldErrors.password?.[0]}
            autoComplete="new-password"
            hint={`Use ${AUTH_LIMITS.passwordMinLength}–${AUTH_LIMITS.passwordMaxLength} characters.`}
            required
          />
          <FormField
            id="confirmPassword"
            label="Confirm password"
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            error={fieldErrors.confirmPassword?.[0]}
            autoComplete="new-password"
            required
          />

          <div className="button-row">
            <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
              {submitting ? "Creating account…" : "Create account"}
            </button>
          </div>
        </form>

        <div className="auth-links">
          <p>
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
          <p>
            <Link to="/">Back to home</Link>
          </p>
        </div>
      </div>
    </PageShell>
  );
}