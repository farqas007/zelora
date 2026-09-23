# Zelora

Zelora is a production-oriented multi-vendor marketplace platform. Sellers open
their own stores and manage products and orders; customers browse, search and
purchase products; marketplace administration, commissions, payments and
delivery integrations are designed as additive services on top of a stable
foundation.

This repository currently contains the **Phase 1 foundation shell** — nothing
more. No marketplace features exist yet and no mock marketplace data is
presented as real functionality.

## Prerequisites

- **Node.js** ≥ 22.12 (see `.nvmrc`; use `nvm use` if you have nvm)
- **pnpm** 12.5.1 — enabled via Corepack, not installed globally:
  `corepack enable` (readies the `pnpm` shim, which pins the version declared
  in `packageManager`).

## Current architecture

A lightweight pnpm workspace (no Turborepo, no Docker):

```
apps/web        React 19 + Vite 7 web application (SPA shell)
apps/api        Hono 4 API service — runs on Node for local dev with
                @hono/node-server; deployable to Cloudflare Workers later
packages/shared Shared domain types and API contracts (no runtime deps)
packages/core   Foundational config, typed errors and logging primitives
packages/db     Data layer: Drizzle schema (SQLite/Cloudflare-D1 compatible),
                SQLite client, migration workflow and schema tests
```

Key properties:

- TypeScript everywhere, strict mode, no `any` (enforced by ESLint).
- The API exposes a typed envelope: `{ ok: true, data }` or `{ ok: false, error }`.
- `packages/shared` is the only contract between apps; the API is the single
  source of truth for the browser.
- Workspace packages are consumed as TypeScript source (no build step for
  `packages/*`). Local packages export `./src/index.ts` directly.

## Cloudflare deployment foundation

A Cloudflare Workers runtime path is implemented and ready to be wired to a real
account, but Zelora is **not deployed** to Cloudflare yet.

- `apps/api/src/index.ts` remains the Node/better-sqlite3 runtime used for local
  dev (`pnpm dev`).
- `apps/api/src/worker.ts` is the Cloudflare Workers composition root: it maps
  the Worker `env` bindings into the same `createApp()` the Node server uses, so
  routes, middleware and services are identical on both runtimes.
- The Worker uses the Cloudflare D1 repositories (`@zelora/db/*/d1`) instead of
  the local better-sqlite3 ones, and reads the real client address from the
  `CF-Connecting-IP` header for per-IP rate limiting.
- `apps/api/wrangler.jsonc` holds the Worker config: the `DB` D1 binding and its
  `migrations_dir`, pointing at `../../packages/db/migrations`.
- The `database_id` in `wrangler.jsonc` is intentionally a placeholder. A real
  D1 database must be created in a Cloudflare account and its id filled in
  before any Wrangler command reads the config.
- Real Cloudflare credentials, database ids and secrets must never be committed.
- D1 migrations must be applied to the production database before the deployed
  API can serve requests.
- Worker configuration provides production environment values through Cloudflare
  bindings and variables, which `src/worker.ts` maps into the shared config
  contract (no `process.env` on the edge).
- The Worker build (`pnpm build:worker`, chained into `pnpm build`) bundles
  `src/worker.ts` for a neutral platform and runs
  `scripts/check-worker-bundle.mjs`, which fails the build if the emitted bundle
  still contains Node-only runtime code (`node:` builtins, `@hono/node-server`,
  `better-sqlite3`).

## Local development

```sh
pnpm install      # install workspace dependencies
pnpm dev          # web on http://localhost:5173 and API on http://localhost:3001
```

API health check: <http://localhost:3001/api/health>

For the web app's live API-status indicator to show *online*, keep `pnpm dev`
running (the Vite dev server runs on port 5173, the default CORS origin).

Other scripts:

| Command              | Description                                     |
| -------------------- | ----------------------------------------------- |
| `pnpm build`         | Builds runnable artifacts (web + API bundle)    |
| `pnpm test`          | Runs the test suites (API and database)         |
| `pnpm lint`          | ESLint over the whole workspace (no warnings)   |
| `pnpm typecheck`     | `tsc --noEmit` for every package                |
| `pnpm db:generate`   | Generate a new migration from `packages/db` schema |
| `pnpm db:migrate`    | Apply migrations to the local dev SQLite file   |
| `pnpm db:seed`       | Load clearly-marked dev/test seed data (blocked in production) |
| `pnpm db:studio`     | Open Drizzle Studio against the local dev DB    |

Environment variables are optional at this phase — defaults are documented in
`.env.example`. A `.env` loader arrives in a later phase, when the data layer
is added.

### Local Cloudflare Worker development

`wrangler dev` serves the Worker over plain HTTP on `localhost`, where browsers
drop `Secure` cookies. The Worker defaults `NODE_ENV` to `production` (the
deployed posture) and therefore needs an explicit development override to stay
usable locally:

```sh
pnpm --filter @zelora/api exec wrangler dev \
  --var NODE_ENV:development \
  --var SESSION_COOKIE_SECURE:false \
  --var CORS_ORIGIN:http://localhost:5173
```

The Worker validates this at startup: a `Secure` cookie combined with
`NODE_ENV=development` is rejected with a clear configuration error, and
`PBKDF2_ITERATIONS` above 100000 (Cloudflare Web Crypto's limit) is refused —
so a config copied from a Node-tuned local environment can never silently break
authentication or crash hashing on the edge. Production deployments keep the
`Secure` cookie and the Workers-compatible iteration cap.

## Phase 1 scope

- pnpm workspace with shared tooling configuration
- React + Vite web application shell (accessible foundation page)
- Hono API with a typed `GET /api/health` endpoint and typed error envelope
- `packages/shared` (API contract types) and `packages/core` (config, errors,
  logging primitives)
- ESLint, strict TypeScript, Vitest, GitHub Actions CI

Not in Phase 1: database, authentication, accounts, catalog, cart, checkout,
orders, seller/admin dashboards, payments, delivery, Cloudflare deployment.

## Future phases

Planned (in order): data layer & core schema → authentication & accounts →
seller onboarding & stores → product catalog → browsing, search & filtering →
cart → checkout & orders → seller order management → admin dashboard &
moderation → reviews → notifications & messaging → payments, refunds, returns &
payouts → commissions & seller ledger → security hardening, observability &
performance → Cloudflare deployment & CI/CD → post-v1 services (gateways,
OAuth, guest checkout, analytics).

Each phase is additive; nothing in later phases requires a rewrite of Phase 1.