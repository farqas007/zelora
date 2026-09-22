import { serve } from "@hono/node-server";
import { loadConfig, createLogger } from "@zelora/core";
import { createApp } from "./app";

const config = loadConfig();
const logger = createLogger("server");

const app = createApp(config);

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