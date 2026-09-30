import { defineConfig } from "vitest/config";
import { BOOT_AWARE_TIMEOUT_MS, D1_TEST_FILES } from "./vitest.layers";

/**
 * The **D1** layer: only the tests that need a real Cloudflare D1 / workerd
 * runtime.
 *
 * Kept as its own configuration, and its own CI step, for two reasons. It is
 * where the real parity risk lives — these are the only tests that execute the
 * committed migration SQL on the runtime and dialect production actually uses,
 * and the only ones that spawn the real `wrangler` CLI — so it must not be the
 * thing that gets dropped when a build needs to be fast. And it is
 * overwhelmingly the slowest thing in the workspace, so giving it its own step
 * means its cost is visible and attributable instead of hidden inside a single
 * `pnpm test` whose total nobody can act on.
 *
 * The file list is the one in `vitest.layers.ts`, which
 * `src/test/d1-layer-coverage.test.ts` checks against what the files actually
 * do, in both directions. A D1 test added without being listed fails the
 * build; a listed file that no longer needs workerd fails the build too.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [...D1_TEST_FILES],
    testTimeout: BOOT_AWARE_TIMEOUT_MS,
    // This is the layer that needs it. Every file here boots a Miniflare or
    // workerd runtime in a setup hook, and Vitest's 10s default hook timeout is
    // not enough for that once several files boot concurrently — a hook that
    // times out leaves workerd half-alive, and every later test in the file
    // fails with "fetch failed" instead of the real cause.
    hookTimeout: BOOT_AWARE_TIMEOUT_MS,
  },
});
