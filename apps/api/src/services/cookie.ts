import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppConfig } from "@zelora/core";

/**
 * Session-cookie helpers built on Hono's cookie support. Only the cookie
 * mechanics live here: reading, issuing and clearing the configured session
 * cookie with a fixed security attribute set. Authentication policy (token
 * verification, session lookup) belongs to the auth service, not this module.
 */

interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  secure: boolean;
}

function sessionCookieOptions(config: AppConfig): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: config.sessionTtlSeconds,
    secure: config.sessionCookieSecure,
  };
}

/** Read the configured session cookie from the request, if present. */
export function readSessionCookie(config: AppConfig, c: Context): string | undefined {
  return getCookie(c, config.sessionCookieName);
}

/** Issue the session cookie for a raw session token. */
export function setSessionCookie(config: AppConfig, c: Context, token: string): void {
  setCookie(c, config.sessionCookieName, token, sessionCookieOptions(config));
}

/** Expire the session cookie immediately (deletes it on the client). */
export function clearSessionCookie(config: AppConfig, c: Context): void {
  deleteCookie(c, config.sessionCookieName, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.sessionCookieSecure,
  });
}