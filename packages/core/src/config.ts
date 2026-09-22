import { AppError } from "./errors";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production" | "unknown";
  host: string;
  port: number;
  appVersion: string;
  corsOrigin: string;
}

const DEFAULT_CONFIG: Omit<AppConfig, "nodeEnv"> = {
  host: "127.0.0.1",
  port: 3001,
  appVersion: "0.1.0",
  corsOrigin: "http://localhost:5173",
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

/**
 * Load application configuration from the environment.
 * A specific map can be injected for tests.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  return {
    nodeEnv: parseNodeEnv(env.NODE_ENV),
    host: env.HOST ?? DEFAULT_CONFIG.host,
    port: parsePort(env.PORT),
    appVersion: env.APP_VERSION ?? DEFAULT_CONFIG.appVersion,
    corsOrigin: env.CORS_ORIGIN ?? DEFAULT_CONFIG.corsOrigin,
  };
}