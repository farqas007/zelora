import type { Hono } from "hono";
import { AppError, loadConfig, PBKDF2PasswordHasher, type AppConfig } from "@zelora/core";
import { createD1Client, type D1DatabaseLike } from "@zelora/db/d1";
import { createD1AuthSessionRepository } from "@zelora/db/auth/d1";
import { createD1UserRepository } from "@zelora/db/users/d1";
import { createD1SellerRepository } from "@zelora/db/seller/d1";
import { createD1CatalogRepository } from "@zelora/db/catalog/d1";
import { createD1ProductRepository } from "@zelora/db/products/d1";
import { createD1CartRepository } from "@zelora/db/cart/d1";
import { createD1AuditLogRepository } from "@zelora/db/audit/d1";
import { createApp } from "./app";
import { systemClock } from "./services/clock";
import { normalizeClientIp, type ClientIpResolver } from "./services/client-ip";
import { createR2MediaStorage, type R2BucketLike } from "./services/media/r2";
import type { MediaStorage } from "./services/media/storage";

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
 * - no `process.env` (configuration comes from the `env` bindings below),
 * - no `services/media/local-fs` (the Worker has no filesystem, so uploaded
 *   media goes to the `MEDIA` R2 bucket through the edge-safe R2 driver).
 */

/** Bindings the Zelora Worker actually reads from `env`. */
export interface Env {
  /** Cloudflare D1 database binding — the Worker's only database. */
  DB: D1DatabaseLike;
  /**
   * Cloudflare R2 bucket binding for seller-uploaded product images.
   *
   * Media storage is opt-in and requires **both** this binding and
   * `MEDIA_PUBLIC_BASE_URL`; either one alone leaves media storage off, and
   * media operations fail loudly. Declared with the same hand-written
   * structural approach as {@link D1DatabaseLike}, so
   * `@cloudflare/workers-types` stays out of the dependency tree.
   */
  MEDIA?: R2BucketLike;
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
  /** Product creations allowed per IP address per window. */
  RATE_LIMIT_PRODUCT_CREATE_IP_MAX?: string;
  RATE_LIMIT_PRODUCT_CREATE_IP_WINDOW_SECONDS?: string;
  /**
   * Secret gating the initial-admin bootstrap endpoint. Deployed via
   * `wrangler secret put ADMIN_BOOTSTRAP_SECRET` (a secret binding, so it is
   * never visible in the dashboard vars or `wrangler.jsonc`).
   */
  ADMIN_BOOTSTRAP_SECRET?: string;
  /**
   * Absolute `http(s)` base the `MEDIA` bucket's objects are publicly readable
   * from. A `r2.dev` development base, a custom domain, or a proxied media
   * route are all valid.
   *
   * Required **together with** the `MEDIA` binding; setting only one of the two
   * leaves media storage off (see `createWorkerMediaStorage`).
   */
  MEDIA_PUBLIC_BASE_URL?: string;
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
  "RATE_LIMIT_PRODUCT_CREATE_IP_MAX",
  "RATE_LIMIT_PRODUCT_CREATE_IP_WINDOW_SECONDS",
  "ADMIN_BOOTSTRAP_SECRET",
  "MEDIA_PUBLIC_BASE_URL",
] as const;

/**
 * Highest PBKDF2-HMAC iteration count Cloudflare Workers Web Crypto accepts.
 * Node's runtime supports far more (see `PASSWORD_HASH_MAX_ITERATIONS` in
 * `@zelora/core`); this boundary is intentionally Worker-specific and keeps
 * the Node-vs-Worker difference explicit rather than letting a Node-tuned
 * value crash hash generation on the edge.
 */
export const PBKDF2_WORKER_MAX_ITERATIONS = 100_000;

/**
 * Resolve the Worker's PBKDF2 iteration binding into a Workers-supported
 * value. Missing/empty falls back to the Workers-safe max; anything else must
 * be a positive integer that Cloudflare Web Crypto can actually run.
 */
function resolveWorkerPbkdf2Iterations(value: string | undefined): string {
  if (value === undefined || value === "") {
    return String(PBKDF2_WORKER_MAX_ITERATIONS);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AppError(
      "APP_CONFIG_INVALID",
      `PBKDF2_ITERATIONS must be a positive integer, received "${value}".`,
      500,
    );
  }
  if (parsed > PBKDF2_WORKER_MAX_ITERATIONS) {
    throw new AppError(
      "APP_CONFIG_INVALID",
      `PBKDF2_ITERATIONS must not exceed ${PBKDF2_WORKER_MAX_ITERATIONS} on Cloudflare Workers ` +
        `(Web Crypto rejects higher iteration counts), received "${value}".`,
      500,
    );
  }
  return value;
}

/**
 * A `Secure` session cookie is never sent by a browser over plain-HTTP local
 * development (Wrangler serves `http://localhost` by default), which silently
 * breaks authentication. Reject the mismatch loudly at startup instead of
 * letting a production-tuned config ship into a local session-trap. Production
 * stays on `Secure` cookies; local dev must opt into the http posture.
 */
function assertWorkerSessionCookiePosture(config: AppConfig): void {
  if (config.nodeEnv === "development" && config.sessionCookieSecure === true) {
    throw new AppError(
      "APP_CONFIG_INVALID",
      `SESSION_COOKIE_SECURE=true is incompatible with plain-HTTP local development. ` +
        `Run Wrangler with --var NODE_ENV:development and leave SESSION_COOKIE_SECURE ` +
        `unset (or set it to "false"); production deployments keep the Secure cookie.`,
      500,
    );
  }
}

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
  // Never fall back to the unsupported 210000 default in the Worker runtime,
  // and reject explicit overrides that exceed the Workers-supported limit.
  values.PBKDF2_ITERATIONS = resolveWorkerPbkdf2Iterations(values.PBKDF2_ITERATIONS);
  const config = loadConfig(values);
  assertWorkerSessionCookiePosture(config);
  return config;
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
    catalogRepository: createD1CatalogRepository(db),
    productRepository: createD1ProductRepository(db),
    cartRepository: createD1CartRepository(db),
    auditLogRepository: createD1AuditLogRepository(db),
    passwordHasher: new PBKDF2PasswordHasher(config.pbkdf2Iterations),
    clock: systemClock,
    clientIpResolver,
    mediaStorage: createWorkerMediaStorage(env, config),
  });
}

/**
 * Build the Worker's R2-backed media storage, or `undefined` to let `createApp`
 * install the fail-closed default.
 *
 * Media storage is enabled only when **both** halves of the capability are
 * present: the `MEDIA` R2 bucket binding *and* `MEDIA_PUBLIC_BASE_URL`. Anything
 * less is treated as "media storage is not configured" and returns `undefined`,
 * which makes every media operation fail loudly instead of silently doing the
 * wrong thing:
 *
 * - binding without a public base: objects could be written but every URL
 *   handed to a browser would be unresolvable,
 * - public base without a binding: there would be nowhere to write.
 *
 * Half-configured is therefore *additive and inert*, never an error. This
 * matters for deployment: `wrangler.jsonc` declares the `MEDIA` binding, so a
 * default deployment always has `env.MEDIA` present, and an operator who has
 * not yet chosen a public base (or created the bucket) must still be able to
 * deploy and serve every other endpoint. Media stays off until they configure
 * the base; it is opt-in, so nothing that currently works changes.
 *
 * `MEDIA_PUBLIC_BASE_URL` is still fully validated by `loadConfig` before it
 * reaches here — this function only decides *whether* to build a storage, never
 * *what* a base URL is allowed to be.
 */
export function createWorkerMediaStorage(env: Env, config: AppConfig): MediaStorage | undefined {
  const publicBaseUrl = config.mediaPublicBaseUrl;
  if (env.MEDIA === undefined || publicBaseUrl === null) {
    return undefined;
  }
  return createR2MediaStorage({ bucket: env.MEDIA, publicBaseUrl });
}

/** Lazily built app, reused across requests within an isolate. */
let app: Hono | undefined;

/**
 * Minimal structural types for the Workers scheduled-handler contract.
 *
 * `@cloudflare/workers-types` is deliberately not a dependency of this app
 * (see `D1DatabaseLike` in `@zelora/db` for the same approach): the fields
 * below are the only part of the platform API this module touches, so
 * hand-declaring them keeps the type-check node-only while still matching
 * what wrangler/workerd actually pass at runtime.
 */
export interface ScheduledControllerLike {
  /** Unix ms at which this invocation was scheduled to run. */
  scheduledTime: number;
  /** The cron expression that triggered this invocation. */
  cron: string;
}

export interface ExecutionContextLike {
  /** Extends the lifetime of the scheduled run until the promise settles. */
  waitUntil(promise: Promise<unknown>): void;
}

function purgeExpiredSessions(env: Env): Promise<number> {
  const sessionRepository = createD1AuthSessionRepository(createD1Client(env.DB));
  return sessionRepository.purgeExpired();
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    app ??= createWorkerApp(env);
    return app.fetch(request, env);
  },

  /**
   * Cron entry point (see `triggers.crons` in wrangler.jsonc). Expired
   * sessions are otherwise only ever deleted lazily when their cookie is
   * presented again; this sweep keeps the auth_sessions table bounded even
   * for sessions nobody ever comes back for. `purgeExpired` is a pure
   * `DELETE ... WHERE expires_at <= now`, so overlapping or retried runs are
   * safe and idempotent.
   */
  scheduled(
    _event: ScheduledControllerLike,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<void> {
    const purge = purgeExpiredSessions(env);
    ctx.waitUntil(purge);
    return purge.then(() => undefined);
  },
};