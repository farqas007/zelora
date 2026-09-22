import { Link } from "react-router-dom";
import { PageShell } from "../components/PageShell";
import { useAuth } from "../context/AuthContext";

/**
 * Authenticated placeholder. Demonstrates the session-restore flow: after a
 * page reload the HttpOnly cookie restores `/api/auth/me`, `/api/auth/csrf`
 * restores the in-memory CSRF token, and sign-out still works.
 */
export function DashboardPage() {
  const { status, user, logout } = useAuth();

  function onSignOut(): void {
    void logout().catch(() => undefined);
  }

  return (
    <PageShell title="Dashboard">
      {status === "loading" && <p>Checking session status…</p>}
      {status === "signed-out" && (
        <p>
          You are not signed in. <Link to="/login">Sign in</Link> to continue.
        </p>
      )}
      {status === "authenticated" && user !== null && (
        <>
          <p>
            Signed in as <strong>{user.email}</strong> ({user.role}).
          </p>
          <p>
            <button type="button" onClick={onSignOut}>
              Sign out
            </button>
          </p>
        </>
      )}
    </PageShell>
  );
}