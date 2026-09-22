import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createLogger, loadConfig, PBKDF2PasswordHasher } from "@zelora/core";
import { createLocalClient, resolveDbPath } from "@zelora/db";
import { createLocalAuthSessionRepository } from "@zelora/db/auth/local";
import { createLocalUserRepository } from "@zelora/db/users/local";
import { createLocalSellerRepository } from "@zelora/db/seller/local";
import { createApp } from "./app";
import { systemClock } from "./services/clock";
import {
  firstForwardedFor,
  normalizeClientIp,
  type ClientIpResolver,
} from "./services/client-ip";

const config = loadConfig();
const logger = createLogger("server");

/**
 * Node composition/runtime boundary. The local better-sqlite3 repositories
 * are instantiated here and injected into the application so edge-compatible
 * modules (app/routes/middleware/services) never pull in the native stack.
 *
 * The client-IP resolver is Node-specific in exactly one way: it reads the
 * TCP peer address that Node observed for the connection. Forwarded headers
 * are only consulted when `RATE_LIMIT_TRUST_PROXY` explicitly opts in (the
 * app then sits behind a single proxy that rewrites X-Forwarded-For).
 */
const clientIpResolver: ClientIpResolver = {
  resolve: (c) => {
    if (config.rateLimitTrustProxy) {
      return normalizeClientIp(firstForwardedFor(c.req.header("x-forwarded-for")));
    }
    return normalizeClientIp(getConnInfo(c).remote.address);
  },
};

const { db } = createLocalClient(resolveDbPath());

const app = createApp({
  config,
  userRepository: createLocalUserRepository(db),
  sessionRepository: createLocalAuthSessionRepository(db),
  sellerRepository: createLocalSellerRepository(db),
  passwordHasher: new PBKDF2PasswordHasher(config.pbkdf2Iterations),
  clock: systemClock,
  clientIpResolver,
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