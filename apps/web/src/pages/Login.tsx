import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { FormField } from "../components/FormField";
import { LoadingState } from "../components/LoadingState";
import { PageShell } from "../components/PageShell";
import { useAuth } from "../context/AuthContext";
import { resolveApiFailure } from "../lib/auth/errors";
import { validateLogin, type FieldErrors } from "../lib/auth/validation";

/**
 * Sign-in form. Submits the shared `LoginRequest` contract through the
 * AuthContext, which applies the returned user + in-memory CSRF token before
 * redirecting to the dashboard. All session/CORS mechanics stay in the
 * existing API client; no tokens are persisted to browser storage here.
 */
export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === "loading") {
    return (
      <PageShell title="Sign in">
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

    const errors = validateLogin(email, password);
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      await login({ email, password });
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
    <PageShell title="Sign in">
      <div className="auth-card">
        {formError !== null && (
          <p className="form-alert" role="alert">
            {formError}
          </p>
        )}

        <form className="auth-form" onSubmit={onSubmit} noValidate>
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
            autoComplete="current-password"
            required
          />

          <div className="button-row">
            <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>

        <div className="auth-links">
          <p>
            No account yet? <Link to="/register">Create one</Link>
          </p>
          <p>
            <Link to="/">Back to home</Link>
          </p>
        </div>
      </div>
    </PageShell>
  );
}