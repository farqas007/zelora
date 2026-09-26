import { AppError } from "./errors";
import { ADMIN_BOOTSTRAP_SECRET_MIN_LENGTH } from "@zelora/shared";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production" | "unknown";
  host: string;
  port: number;
  appVersion: string;
  corsOrigin: string;
  sessionCookieName: string;
  sessionTtlSeconds: number;
  sessionCookieSecure: boolean;
  /** Minimum seconds between writes of a session's `lastUsedAt`. */
  sessionLastUsedThrottleSeconds: number;
  /** Seconds between background purges of expired sessions. */
  sessionPurgeIntervalSeconds: number;
  pbkdf2Iterations: number;
  rateLimitEnabled: boolean;
  rateLimitTrustProxy: boolean;
  rateLimitLoginIpMax: number;
  rateLimitLoginIpWindowSeconds: number;
  rateLimitLoginEmailMax: number;
  rateLimitLoginEmailWindowSeconds: number;
  rateLimitRegisterIpMax: number;
  rateLimitRegisterIpWindowSeconds: number;
  rateLimitSellerOnboardingIpMax: number;
  rateLimitSellerOnboardingIpWindowSeconds: number;
  rateLimitProductCreateIpMax: number;
  rateLimitProductCreateIpWindowSeconds: number;
  /**
   * Secret gating the initial-admin bootstrap endpoint, or `null` when the
   * endpoint is disabled. When set, it must be at least
   * {@link ADMIN_BOOTSTRAP_SECRET_MIN_LENGTH} characters. Never a default
   * value and never echoed by any read path.
   */
  adminBootstrapSecret: string | null;
  /**
   * Absolute `http(s)` origin that uploaded media is publicly readable from,
   * or `null` when no media storage is configured. Media storage is opt-in:
   * an unset value leaves the storage port fail-closed rather than guessing
   * an origin that would produce dead image URLs.
   *
   * Always absolute (never a root-relative path) because a stored
   * `product_images.url` is loaded directly as an `<img src>` by the browser,
   * which may be served from a different origin than the API. Trailing
   * slashes are stripped so URL joining is unambiguous.
   */
  mediaPublicBaseUrl: string | null;
  /**
   * Filesystem directory the Node runtime writes uploaded media into. Only
   * read by the Node-only local filesystem driver; the Worker runtime never
   * touches it (it has no filesystem). Relative paths resolve against the
   * process working directory, matching `ZELORA_DB_PATH`.
   */
  mediaLocalRoot: string;
}

const DEFAULT_CONFIG: Omit<AppConfig, "nodeEnv"> = {
  host: "127.0.0.1",
  port: 3001,
  appVersion: "0.1.0",
  corsOrigin: "http://localhost:5173",
  sessionCookieName: "zelora_session",
  sessionTtlSeconds: 2_592_000,
  sessionCookieSecure: false,
  sessionLastUsedThrottleSeconds: 300,
  sessionPurgeIntervalSeconds: 3_600,
  pbkdf2Iterations: 210_000,
  rateLimitEnabled: true,
  rateLimitTrustProxy: false,
  rateLimitLoginIpMax: 20,
  rateLimitLoginIpWindowSeconds: 900,
  rateLimitLoginEmailMax: 10,
  rateLimitLoginEmailWindowSeconds: 900,
  rateLimitRegisterIpMax: 10,
  rateLimitRegisterIpWindowSeconds: 3_600,
  rateLimitSellerOnboardingIpMax: 10,
  rateLimitSellerOnboardingIpWindowSeconds: 3_600,
  rateLimitProductCreateIpMax: 30,
  rateLimitProductCreateIpWindowSeconds: 3_600,
  /** Admin bootstrap is opt-in: disabled unless a secret is provided. */
  adminBootstrapSecret: null,
  /**
   * Media storage is opt-in: no public base URL means the storage port stays
   * fail-closed. The local filesystem root mirrors the `.data/zelora.db`
   * default of `ZELORA_DB_PATH` so both live-development artifacts sit
   * together under `.data/`.
   */
  mediaPublicBaseUrl: null,
  mediaLocalRoot: ".data/media",
};

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_CONFIG.port;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(
      "APP_CONFIG_INVALID",
      `PORT must be an integer between 1 and 65535, received "${value}".`,
      500,
    );
  }
  return port;
}

function parseNodeEnv(value: string | undefined): AppConfig["nodeEnv"] {
  switch (value) {
    case "development":
    case "test":
    case "production":
      return value;
    default:
      return "unknown";
  }
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError(
      "APP_CONFIG_INVALID",
      `${name} must be a positive integer, received "${value}".`,
      500,
    );
  }
  return parsed;
}

function parseNonEmptyString(
  value: string | undefined,
  fallback: string,
  name: string,
): string {
  if (value === undefined || value === "") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new AppError(
      "APP_CONFIG_INVALID",
      `${name} must not be empty, received "${value}".`,
      500,
    );
  }
  return trimmed;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new AppError(
    "APP_CONFIG_INVALID",
    `${name} must be "true" or "false", received "${value}".`,
    500,
  );
}

/**
 * Parse the admin bootstrap secret. An unset/empty value disables the
 * bootstrap endpoint (`null`); a set value must reach the minimum strength
 * so operators cannot opt in with a guessable secret. The value is never
 * trimmed — the secret is opaque byte material and any whitespace is part of
 * it.
 */
function parseAdminBootstrapSecret(value: string | undefined): string | null {
  if (value === undefined || value === "") {
    return null;
  }
  if (value.length < ADMIN_BOOTSTRAP_SECRET_MIN_LENGTH) {
    throw new AppError(
      "APP_CONFIG_INVALID",
      `ADMIN_BOOTSTRAP_SECRET must be at least ${ADMIN_BOOTSTRAP_SECRET_MIN_LENGTH} characters when set, received ${value.length} characters.`,
      500,
    );
  }
  return value;
}

/**
 * Parse the media public base URL. Unset/empty disables media storage
 * (`null`); a set value must be an absolute `http`/`https` URL with a host,
 * and any trailing slashes are stripped so a driver's URL join can never
 * produce a double slash. The value is not otherwise normalized: a
 * `r2.dev` development base, a custom domain and a proxied media route are
 * all legitimate, and the API must not second-guess which one is deployed.
 */
function parseMediaPublicBaseUrl(value: string | undefined): string | null {
  if (value === undefined || value === "") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError(
      "APP_CONFIG_INVALID",
      `MEDIA_PUBLIC_BASE_URL must be an absolute http(s) URL, received "${value}".`,
      500,
    );
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.host === "") {
    throw new AppError(
      "APP_CONFIG_INVALID",
      `MEDIA_PUBLIC_BASE_URL must be an absolute http(s) URL with a host, received "${value}".`,
      500,
    );
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * Load application configuration from the environment.
 * A specific map can be injected for tests.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);

  return {
    nodeEnv,
    host: env.HOST ?? DEFAULT_CONFIG.host,
    port: parsePort(env.PORT),
    appVersion: env.APP_VERSION ?? DEFAULT_CONFIG.appVersion,
    corsOrigin: env.CORS_ORIGIN ?? DEFAULT_CONFIG.corsOrigin,
    sessionCookieName: parseNonEmptyString(
      env.SESSION_COOKIE_NAME,
      DEFAULT_CONFIG.sessionCookieName,
      "SESSION_COOKIE_NAME",
    ),
    sessionTtlSeconds: parsePositiveInteger(
      env.SESSION_TTL_SECONDS,
      DEFAULT_CONFIG.sessionTtlSeconds,
      "SESSION_TTL_SECONDS",
    ),
    sessionCookieSecure: parseBoolean(
      env.SESSION_COOKIE_SECURE,
      nodeEnv === "production",
      "SESSION_COOKIE_SECURE",
    ),
    sessionLastUsedThrottleSeconds: parsePositiveInteger(
      env.SESSION_LAST_USED_THROTTLE_SECONDS,
      DEFAULT_CONFIG.sessionLastUsedThrottleSeconds,
      "SESSION_LAST_USED_THROTTLE_SECONDS",
    ),
    sessionPurgeIntervalSeconds: parsePositiveInteger(
      env.SESSION_PURGE_INTERVAL_SECONDS,
      DEFAULT_CONFIG.sessionPurgeIntervalSeconds,
      "SESSION_PURGE_INTERVAL_SECONDS",
    ),
    pbkdf2Iterations: parsePositiveInteger(
      env.PBKDF2_ITERATIONS,
      DEFAULT_CONFIG.pbkdf2Iterations,
      "PBKDF2_ITERATIONS",
    ),
    rateLimitEnabled: parseBoolean(
      env.RATE_LIMIT_ENABLED,
      DEFAULT_CONFIG.rateLimitEnabled,
      "RATE_LIMIT_ENABLED",
    ),
    rateLimitTrustProxy: parseBoolean(
      env.RATE_LIMIT_TRUST_PROXY,
      DEFAULT_CONFIG.rateLimitTrustProxy,
      "RATE_LIMIT_TRUST_PROXY",
    ),
    rateLimitLoginIpMax: parsePositiveInteger(
      env.RATE_LIMIT_LOGIN_IP_MAX,
      DEFAULT_CONFIG.rateLimitLoginIpMax,
      "RATE_LIMIT_LOGIN_IP_MAX",
    ),
    rateLimitLoginIpWindowSeconds: parsePositiveInteger(
      env.RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS,
      DEFAULT_CONFIG.rateLimitLoginIpWindowSeconds,
      "RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS",
    ),
    rateLimitLoginEmailMax: parsePositiveInteger(
      env.RATE_LIMIT_LOGIN_EMAIL_MAX,
      DEFAULT_CONFIG.rateLimitLoginEmailMax,
      "RATE_LIMIT_LOGIN_EMAIL_MAX",
    ),
    rateLimitLoginEmailWindowSeconds: parsePositiveInteger(
      env.RATE_LIMIT_LOGIN_EMAIL_WINDOW_SECONDS,
      DEFAULT_CONFIG.rateLimitLoginEmailWindowSeconds,
      "RATE_LIMIT_LOGIN_EMAIL_WINDOW_SECONDS",
    ),
    rateLimitRegisterIpMax: parsePositiveInteger(
      env.RATE_LIMIT_REGISTER_IP_MAX,
      DEFAULT_CONFIG.rateLimitRegisterIpMax,
      "RATE_LIMIT_REGISTER_IP_MAX",
    ),
    rateLimitRegisterIpWindowSeconds: parsePositiveInteger(
      env.RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS,
      DEFAULT_CONFIG.rateLimitRegisterIpWindowSeconds,
      "RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS",
    ),
    rateLimitSellerOnboardingIpMax: parsePositiveInteger(
      env.RATE_LIMIT_SELLER_ONBOARDING_IP_MAX,
      DEFAULT_CONFIG.rateLimitSellerOnboardingIpMax,
      "RATE_LIMIT_SELLER_ONBOARDING_IP_MAX",
    ),
    rateLimitSellerOnboardingIpWindowSeconds: parsePositiveInteger(
      env.RATE_LIMIT_SELLER_ONBOARDING_IP_WINDOW_SECONDS,
      DEFAULT_CONFIG.rateLimitSellerOnboardingIpWindowSeconds,
      "RATE_LIMIT_SELLER_ONBOARDING_IP_WINDOW_SECONDS",
    ),
    rateLimitProductCreateIpMax: parsePositiveInteger(
      env.RATE_LIMIT_PRODUCT_CREATE_IP_MAX,
      DEFAULT_CONFIG.rateLimitProductCreateIpMax,
      "RATE_LIMIT_PRODUCT_CREATE_IP_MAX",
    ),
    rateLimitProductCreateIpWindowSeconds: parsePositiveInteger(
      env.RATE_LIMIT_PRODUCT_CREATE_IP_WINDOW_SECONDS,
      DEFAULT_CONFIG.rateLimitProductCreateIpWindowSeconds,
      "RATE_LIMIT_PRODUCT_CREATE_IP_WINDOW_SECONDS",
    ),
    adminBootstrapSecret: parseAdminBootstrapSecret(env.ADMIN_BOOTSTRAP_SECRET),
    mediaPublicBaseUrl: parseMediaPublicBaseUrl(env.MEDIA_PUBLIC_BASE_URL),
    mediaLocalRoot: parseNonEmptyString(
      env.ZELORA_MEDIA_ROOT,
      DEFAULT_CONFIG.mediaLocalRoot,
      "ZELORA_MEDIA_ROOT",
    ),
  };
}