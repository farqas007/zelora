import { defineConfig } from "vitest/config";

/**
 * `packages/shared` is plain TypeScript with no runtime dependencies, so the
 * environment is Node's and the suite stays as fast as the package is small.
 *
 * These tests exist because this module is the one place the API and the
 * browser both take their vocabulary, limits and error codes from: a limit that
 * drifts here is a limit the two halves of the product no longer agree on, and
 * nothing else in the workspace would notice.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
