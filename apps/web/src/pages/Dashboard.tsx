import { useState } from "react";
import { Link } from "react-router-dom";
import { LoadingState } from "../components/LoadingState";
import { PageShell } from "../components/PageShell";
import { useAuth } from "../context/AuthContext";
import { resolveApiFailure } from "../lib/auth/errors";

/**
 * Authenticated placeholder. Demonstrates the session-restore flow: after a
 * page reload the HttpOnly cookie restores `/api/auth/me`, `/api/auth/csrf`
 * restores the in-memory CSRF token, and sign-out still works. The full
 * seller dashboard arrives in a later step.
 */
export function DashboardPage() {
  const { status, user, logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignOut(): Promise<void> {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    setError(null);
    try {
      await logout();
    } catch (cause) {
      setError(resolveApiFailure(cause).message);
      setSigningOut(false);
    }
  }

  return (
    <PageShell title="Dashboard">
      {status === "loading" && <LoadingState label="Checking session…" />}

      {status === "signed-out" && (
        <p className="muted">
          You are not signed in. <Link to="/login">Sign in</Link> to continue.
        </p>
      )}

      {status === "authenticated" && user !== null && (
        <div className="dashboard">
          <section className="user-card" aria-labelledby="account-heading">
            <h2 id="account-heading">Account</h2>
            <p className="user-email">{user.email}</p>
            <p className="muted">
              {user.name} · <span className="badge">{user.role}</span>
            </p>
          </section>

          {error !== null && (
            <p className="form-alert" role="alert">
              {error}
            </p>
          )}

          <ul className="dashboard-actions">
            <li>
              <Link to="/seller/onboarding">Seller onboarding</Link>
            </li>
            <li>
              <Link to="/">Back to home</Link>
            </li>
            <li>
              <button type="button" className="btn" onClick={onSignOut} disabled={signingOut}>
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </li>
          </ul>
        </div>
      )}
    </PageShell>
  );
}