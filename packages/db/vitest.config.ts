import { defineConfig } from "vitest/config";
import { ALL_TEST_GLOBS, BOOT_AWARE_TIMEOUT_MS } from "./vitest.layers";

/**
 * The package's **complete** test configuration, and the default one: a bare
 * `vitest run` here, and therefore `pnpm test`, still executes every test in the
 * package. This is the safety property that matters most, so the default
 * configuration is the union of the layers and not either layer on its own.
 *
 * The two layers are separate configurations layered on top of this one:
 *
 * - `vitest.fast.config.ts` — everything except the real-D1 tests. The
 *   PR-blocking lane.
 * - `vitest.d1.config.ts` — only the real-D1 tests.
 *
 * `hookTimeout` is set alongside `testTimeout` on purpose. Vitest's default
 * hook timeout is 10s, and the D1 layer's setup hooks are a Miniflare or
 * workerd boot plus, for the seed tooling, a full migration run — so under
 * contention they outrun that default and take the whole file down with a
 * half-booted runtime, which then fails the *tests* with a confusing
 * "fetch failed". Both budgets come from one constant; see
 * `BOOT_AWARE_TIMEOUT_MS`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [...ALL_TEST_GLOBS],
    testTimeout: BOOT_AWARE_TIMEOUT_MS,
    hookTimeout: BOOT_AWARE_TIMEOUT_MS,
  },
});
