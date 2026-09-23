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