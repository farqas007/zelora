import { serve } from "@hono/node-server";
import { createLogger, loadConfig, PBKDF2PasswordHasher } from "@zelora/core";
import { createLocalClient, resolveDbPath } from "@zelora/db";
import { createLocalAuthSessionRepository } from "@zelora/db/auth/local";
import { createLocalUserRepository } from "@zelora/db/users/local";
import { createApp } from "./app";
import { systemClock } from "./services/clock";

const config = loadConfig();
const logger = createLogger("server");

/**
 * Node composition/runtime boundary. The local better-sqlite3 repositories
 * are instantiated here and injected into the application so edge-compatible
 * modules (app/routes/middleware/services) never pull in the native stack.
 */
const { db } = createLocalClient(resolveDbPath());

const app = createApp({
  config,
  userRepository: createLocalUserRepository(db),
  sessionRepository: createLocalAuthSessionRepository(db),
  passwordHasher: new PBKDF2PasswordHasher(config.pbkdf2Iterations),
  clock: systemClock,
});

const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  (info) => {
    logger.info("api listening", { host: info.address, port: info.port });
  },
);

function shutdown(signal: string): void {
  logger.info("shutting down", { signal });
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));