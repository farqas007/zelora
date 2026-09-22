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