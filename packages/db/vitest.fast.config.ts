import { defineConfig } from "vitest/config";
import { ALL_TEST_GLOBS, BOOT_AWARE_TIMEOUT_MS, D1_TEST_FILES } from "./vitest.layers";

/**
 * The **fast** layer: every test that runs against the in-process SQLite
 * database, and nothing that boots a workerd runtime.
 *
 * This is what CI runs to gate a commit, and what a developer runs while
 * iterating. It exists so that lint, typecheck, unit behaviour, D1/local
 * parity and the schema invariants are verified on every push without waiting
 * on process boots that test the same code against a real D1.
 *
 * The split is an `exclude` of the D1 list rather than an `include` of the fast
 * files, so a newly added test lands here by default. See
 * `src/test/d1-layer-coverage.test.ts` for the guard that keeps that default
 * honest, and `vitest.layers.ts` for why membership is decided by what a file
 * does rather than by its name.
 *
 * Nothing is lost: `pnpm test` in this package still runs the complete suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [...ALL_TEST_GLOBS],
    exclude: [...D1_TEST_FILES],
    testTimeout: BOOT_AWARE_TIMEOUT_MS,
    hookTimeout: BOOT_AWARE_TIMEOUT_MS,
  },
});
