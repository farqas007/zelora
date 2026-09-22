import { AppError } from "./errors";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production" | "unknown";
  host: string;
  port: number;
  appVersion: string;
  corsOrigin: string;
  sessionCookieName: string;
  sessionTtlSeconds: number;
  sessionCookieSecure: boolean;
  pbkdf2Iterations: number;
  rateLimitEnabled: boolean;
  rateLimitTrustProxy: boolean;
  rateLimitLoginIpMax: number;
  rateLimitLoginIpWindowSeconds: number;
  rateLimitLoginEmailMax: number;
  rateLimitLoginEmailWindowSeconds: number;
  rateLimitRegisterIpMax: number;
  rateLimitRegisterIpWindowSeconds: number;
}

const DEFAULT_CONFIG: Omit<AppConfig, "nodeEnv"> = {
  host: "127.0.0.1",
  port: 3001,
  appVersion: "0.1.0",
  corsOrigin: "http://localhost:5173",
  sessionCookieName: "zelora_session",
  sessionTtlSeconds: 2_592_000,
  sessionCookieSecure: false,
  pbkdf2Iterations: 210_000,
  rateLimitEnabled: true,
  rateLimitTrustProxy: false,
  rateLimitLoginIpMax: 20,
  rateLimitLoginIpWindowSeconds: 900,
  rateLimitLoginEmailMax: 10,
  rateLimitLoginEmailWindowSeconds: 900,
  rateLimitRegisterIpMax: 10,
  rateLimitRegisterIpWindowSeconds: 3_600,
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
  };
}