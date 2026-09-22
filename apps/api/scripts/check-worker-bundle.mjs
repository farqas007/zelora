#!/usr/bin/env node
/**
 * Static check that the built Cloudflare Worker bundle stays edge-safe.
 *
 * The Worker is bundled with esbuild `--platform=neutral`, which already
 * fails hard on `node:` builtin imports. This script adds the checks that
 * esbuild alone cannot prove, scanning the emitted bundle for markers that
 * would put Node-only code on the edge:
 *
 *   1. any `node:` builtin specifier (static import/export or dynamic),
 *   2. any `@hono/node-server` reference,
 *   3. any `better-sqlite3` reference that appears outside esbuild's own
 *      `// <source-path>` comment lines. Those comments only echo the pnpm
 *      store directory name (e.g. `drizzle-orm@..._@types+better-sqlite3@...`)
 *      and are not imports; real code references are what we block.
 *
 * Exits non-zero on any violation so `pnpm build` (which chains this script)
 * and CI both fail rather than shipping an unsafe bundle.
 */
import { existsSync, readFileSync } from "node:fs";

const bundlePath = process.argv[2] ?? "dist/worker.js";

if (!existsSync(bundlePath)) {
  console.error(`check-worker-bundle: not found: ${bundlePath}`);
  console.error("Run `pnpm build:worker` first, or pass the bundle path explicitly.");
  process.exitCode = 1;
} else {
  const source = readFileSync(bundlePath, "utf8");
  const commentStripped = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  const failures = [];
  for (const match of commentStripped.matchAll(/["'](node:[^"']+)["']/g)) {
    failures.push(`node builtin specifier \`${match[1]}\` must not be in the Worker bundle`);
  }
  if (commentStripped.includes("@hono/node-server")) {
    failures.push("`@hono/node-server` must not be in the Worker bundle");
  }
  if (commentStripped.includes("better-sqlite3")) {
    failures.push("`better-sqlite3` must not be in the Worker bundle");
  }

  if (failures.length > 0) {
    console.error(`check-worker-bundle: ${bundlePath} is not Worker-safe:`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`check-worker-bundle: OK (${bundlePath}, no Node-only code)`);
  }
}
