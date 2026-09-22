import type { UserDto } from "@zelora/shared";
import type { ZeloraApi } from "../api/client";

/**
 * Frontend session bootstrap/restoration.
 *
 * Browser refresh → the HttpOnly session cookie is sent automatically with
 * `credentials: "include"` requests → `/api/auth/me` restores the user →
 * `/api/auth/csrf` restores the in-memory synchronizer token → logout remains
 * possible.
 *
 * Nothing in this module touches `localStorage`/`sessionStorage`: the session
 * cookie and its raw token are HttpOnly and browser-managed, and the frontend
 * CSRF token is kept strictly in memory by the caller.
 */

export interface AuthenticatedBootstrap {
  status: "authenticated";
  user: UserDto;
  csrfToken: string;
}

export interface SignedOutBootstrap {
  status: "signed-out";
}

export type SessionBootstrap = AuthenticatedBootstrap | SignedOutBootstrap;

/**
 * Resolve the current session from the server. An expired or missing session
 * (the API's 401 `SESSION_EXPIRED`) is treated as signed out. Transport
 * failures propagate so callers can surface network state distinctly from a
 * genuine signed-out session.
 */
export async function bootstrapSession(api: ZeloraApi): Promise<SessionBootstrap> {
  const me = await api.me();
  if (!me.ok) {
    return { status: "signed-out" };
  }

  const csrf = await api.csrf();
  if (!csrf.ok) {
    return { status: "signed-out" };
  }

  return {
    status: "authenticated",
    user: me.data.user,
    csrfToken: csrf.data.csrfToken,
  };
}