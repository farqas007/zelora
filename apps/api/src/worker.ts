import type { Hono } from "hono";
import { loadConfig, PBKDF2PasswordHasher, type AppConfig } from "@zelora/core";
import { createD1Client, type D1DatabaseLike } from "@zelora/db/d1";
import { createD1AuthSessionRepository } from "@zelora/db/auth/d1";
import { createD1UserRepository } from "@zelora/db/users/d1";
import { createD1SellerRepository } from "@zelora/db/seller/d1";
import { createApp } from "./app";
import { systemClock } from "./services/clock";
import { normalizeClientIp, type ClientIpResolver } from "./services/client-ip";

/**
 * Cloudflare Workers runtime boundary for the Zelora API.
 *
 * This module is the Worker's composition root: it receives the platform
 * `env` bindings, wires the D1 database through {@link createD1Client} into
 * the D1 repository implementations, and hands everything to the same
 * `createApp()` the Node server uses. Only this file differs between the two
 * runtimes — routes, middleware and services are untouched.
 *
 * Edge-safety rules are enforced structurally:
 * - no `@hono/node-server` (the Worker exposes the standard `fetch` handler),
 * - no `better-sqlite3` (the D1 repositories are the only data layer here),
 * - no `process.env` (configuration comes from the `env` bindings below).
 */

/** Bindings the Zelora Worker actually reads from `env`. */
export interface Env {
  /** Cloudflare D1 database binding — the Worker's only database. */
  DB: D1DatabaseLike;
  /** `development` | `test` | `production`; defaults to `production`. */
  NODE_ENV?: string;
  /** Allowed browser origin for the API's CORS policy. */
  CORS_ORIGIN?: string;
  /** Version reported by `GET /api/health`. */
  APP_VERSION?: string;
  /** HttpOnly session cookie name set on register/login. */
  SESSION_COOKIE_NAME?: string;
  /** Session lifetime in seconds. */
  SESSION_TTL_SECONDS?: string;
  /** Whether the session cookie is marked Secure. */
  SESSION_COOKIE_SECURE?: string;
  /** PBKDF2-HMAC-SHA256 iteration count for password hashing. */
  PBKDF2_ITERATIONS?: string;
  /** Master switch for the auth rate limiting. */
  RATE_LIMIT_ENABLED?: string;
  /** Login attempts allowed per IP address per window. */
  RATE_LIMIT_LOGIN_IP_MAX?: string;
  RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS?: string;
  /** Login attempts allowed against one normalized email per window. */
  RATE_LIMIT_LOGIN_EMAIL_MAX?: string;
  RATE_LIMIT_LOGIN_EMAIL_WINDOW_SECONDS?: string;
  /** Account registrations allowed per IP address per window. */
  RATE_LIMIT_REGISTER_IP_MAX?: string;
  RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS?: string;
  /** Seller onboarding submissions allowed per IP address per window. */
  RATE_LIMIT_SELLER_ONBOARDING_IP_MAX?: string;
  RATE_LIMIT_SELLER_ONBOARDING_IP_WINDOW_SECONDS?: string;
}

/**
 * Config keys mapped 1:1 from the Worker bindings into the shared
 * `loadConfig()` contract (see {@link Env}). `HOST`/`PORT` are intentionally
 * absent: the Worker serves via `fetch` and never binds a socket.
 */
const WORKER_CONFIG_KEYS = [
  "NODE_ENV",
  "APP_VERSION",
  "CORS_ORIGIN",
  "SESSION_COOKIE_NAME",
  "SESSION_TTL_SECONDS",
  "SESSION_COOKIE_SECURE",
  "PBKDF2_ITERATIONS",
  "RATE_LIMIT_ENABLED",
  "RATE_LIMIT_LOGIN_IP_MAX",
  "RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS",
  "RATE_LIMIT_LOGIN_EMAIL_MAX",
  "RATE_LIMIT_LOGIN_EMAIL_WINDOW_SECONDS",
  "RATE_LIMIT_REGISTER_IP_MAX",
  "RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS",
  "RATE_LIMIT_SELLER_ONBOARDING_IP_MAX",
  "RATE_LIMIT_SELLER_ONBOARDING_IP_WINDOW_SECONDS",
] as const;

export function loadWorkerConfig(env: Env): AppConfig {
  const values: Record<string, string | undefined> = {};
  for (const key of WORKER_CONFIG_KEYS) {
    values[key] = env[key];
  }
  // The Worker is the production runtime. A missing NODE_ENV binding must not
  // silently fall back to the development posture (insecure session cookies);
  // default to `production` unless the operator explicitly overrides it (for
  // example with `wrangler dev --var NODE_ENV:development`).
  values.NODE_ENV = values.NODE_ENV ?? "production";
  // Cloudflare Workers Web Crypto rejects PBKDF2 iteration counts > 100000.
  // Never fall back to the unsupported 210000 default in the Worker runtime.
  // Prefer explicit binding; otherwise use a Workers-supported safe default.
  if (values.PBKDF2_ITERATIONS === undefined || values.PBKDF2_ITERATIONS === "") {
    values.PBKDF2_ITERATIONS = "100000";
  }
  return loadConfig(values);
}

function createWorkerApp(env: Env): Hono {
  const config = loadWorkerConfig(env);
  const db = createD1Client(env.DB);

  // On Cloudflare Workers the real client address is provided by the edge in
  // the `CF-Connecting-IP` header (set by Cloudflare, rewritten past the point
  // a client can spoof it). There is no TCP peer to introspect, so this is the
  // trusted source for per-IP rate limiting on this runtime.
  const clientIpResolver: ClientIpResolver = {
    resolve: (c) => normalizeClientIp(c.req.header("CF-Connecting-IP")),
  };

  return createApp({
    config,
    userRepository: createD1UserRepository(db),
    sessionRepository: createD1AuthSessionRepository(db),
    sellerRepository: createD1SellerRepository(db),
    passwordHasher: new PBKDF2PasswordHasher(config.pbkdf2Iterations),
    clock: systemClock,
    clientIpResolver,
  });
}

/** Lazily built app, reused across requests within an isolate. */
let app: Hono | undefined;

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    app ??= createWorkerApp(env);
    return app.fetch(request, env);
  },
};