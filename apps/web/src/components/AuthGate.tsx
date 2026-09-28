import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../context/AuthContext";
import { LoadingState } from "./LoadingState";

/**
 * Route guards built on the resolved auth status.
 *
 * While the session is being bootstrapped (`loading`) a small loading state is
 * shown instead of redirecting, so a real session is never routed away.
 * Protected routes redirect signed-out visitors to `/login`; auth pages
 * redirect already-authenticated visitors to `/dashboard`.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === "loading") {
    return <LoadingState label="Checking session…" />;
  }
  if (status === "signed-out") {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

/**
 * Admin-only guard layered on top of {@link RequireAuth}.
 *
 * This is a navigation concern only — it decides what the browser renders, so
 * the admin API is never the thing that has to refuse. The server still
 * authorizes every admin request independently (`requireAdmin` in the API), and
 * this guard mirrors that same `user.role === "admin"` signal so a signed-in
 * customer is sent to their dashboard instead of being shown an admin page that
 * would only fail. Nothing about the session or the auth provider is changed
 * here; the guard reads the state that already exists.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();

  if (status === "loading") {
    return <LoadingState label="Checking session…" />;
  }
  if (status === "signed-out") {
    return <Navigate to="/login" replace />;
  }
  if (user?.role !== "admin") {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

/**
 * Seller-onboarding guard, the mirror image of {@link RequireAdmin}.
 *
 * The platform permits exactly one administrator, and approving a seller
 * application promotes the account, so an administrator is not allowed to apply
 * to sell: the API refuses the request with
 * `SELLER_ONBOARDING_FORBIDDEN` regardless of what the browser renders. This
 * guard exists so an admin is not shown a form that can only be submitted into a
 * refusal — the same navigation-only role of `RequireAdmin`, reading the same
 * already-resolved `user.role`, with no change to the session or the auth
 * provider. An admin lands on the admin page, which is the page that actually
 * reviews applications.
 */
export function ForbidAdmin({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();

  if (status === "loading") {
    return <LoadingState label="Checking session…" />;
  }
  if (status === "signed-out") {
    return <Navigate to="/login" replace />;
  }
  if (user?.role === "admin") {
    return <Navigate to="/admin" replace />;
  }
  return <>{children}</>;
}

export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === "loading") {
    return <LoadingState label="Checking session…" />;
  }
  if (status === "authenticated") {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}