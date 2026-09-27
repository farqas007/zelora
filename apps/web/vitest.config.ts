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
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
