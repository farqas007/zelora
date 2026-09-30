import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Test configuration for the web app, mirroring `apps/api/vitest.config.ts`
 * while supplying the browser globals the SPA actually needs.
 *
 * `jsdom` is the environment rather than Node's, because the code under test
 * renders React and touches `File`, `FormData` and `URL.createObjectURL` — the
 * last of which jsdom does not implement, so the upload tests stub it instead
 * of needing a polyfill.
 *
 * The React plugin is reused from the build config so JSX in a `.tsx` test is
 * transformed the same way it is in `src`, instead of relying on esbuild's
 * default JSX handling.
 *
 * `pool: "vmThreads"` builds the jsdom environment once per worker instead of
 * once per file. Under the default `forks` pool each of the 13 test files got
 * its own worker and therefore its own jsdom, which accounted for ~38% of this
 * suite's wall clock for no isolation benefit: `vmThreads` still gives every
 * file a fresh module registry and a fresh global scope, so files still cannot
 * see each other's state.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    pool: "vmThreads",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
