/**
 * The two test layers of `@zelora/db`, and the one place that decides which
 * test file belongs to which.
 *
 * # Why this file exists
 *
 * What looked like one suite is two, behind a single `vitest run`. They differ
 * along the only axis that actually costs wall clock: what the test runs
 * against.
 *
 * - **fast** — every test that runs against the in-process SQLite database from
 *   `src/test/helpers.ts` (`better-sqlite3`, the real committed migrations,
 *   foreign keys ON). A file costs milliseconds to seconds.
 * - **d1** — every test that needs a *real* Cloudflare D1 / workerd runtime,
 *   either by constructing a Miniflare instance in-process or by spawning the
 *   `wrangler` CLI, which boots a fresh workerd runtime per invocation. A file
 *   costs tens to hundreds of seconds, and its cost is dominated by process
 *   and runtime boots rather than by assertions.
 *
 * The D1 layer was measured at roughly 86% of this package's wall clock, which
 * pushed the whole workspace suite past the CI job timeout. The consequence
 * was not a slow build: it was that the fast signals which actually protect
 * every commit — lint, typecheck, unit behaviour, schema invariants — were
 * gated behind the slowest possible thing to run, and therefore behind the
 * first unrelated flake in a workerd boot.
 *
 * # Why membership is a regex and not a naming convention
 *
 * A `*.d1.test.ts` convention was rejected. It would have required renaming
 * files whose current names are already accurate, it duplicates a fact the
 * source already states, and — the real problem — a file that genuinely needs
 * workerd but happens not to be named conventionally would be discovered only
 * by measuring, which is the failure mode this file exists to remove.
 *
 * Instead the criterion is read off the file's own source:
 *
 * - `from "miniflare"` — it imports and drives a real workerd runtime.
 * - `.bin/wrangler` — it spawns the real `wrangler` CLI, and every local
 *   `wrangler d1` call boots a workerd runtime. `seed/d1-cli.test.ts` belongs
 *   to this layer for exactly that reason and would be missed by a
 *   "does it import miniflare?" check.
 *
 * Both patterns are deliberately narrow. Several fast-layer files mention
 * Miniflare or wrangler in prose comments about what the D1 layer covers, and
 * a looser pattern would sweep them in and quietly make the fast lane slow
 * again.
 *
 * `src/test/d1-layer-coverage.test.ts` asserts that {@link D1_TEST_FILES} and
 * {@link D1_RUNTIME_CRITERION} agree, in both directions, against the files
 * actually on disk. Adding a D1 test and forgetting this list fails the build
 * instead of silently costing minutes in the fast lane; deleting or renaming
 * one fails it too, so the list cannot rot.
 */

/**
 * Every test file the package's default (complete) run picks up.
 *
 * This is the `include` of `vitest.config.ts`, and it is deliberately
 * unchanged from the single-suite configuration it replaces: `pnpm test` and a
 * bare `vitest run` in this package still execute the complete suite, exactly
 * as before. The layers are opt-in, never opt-out.
 */
export const ALL_TEST_GLOBS: readonly string[] = ["src/**/*.test.ts", "seed/**/*.test.ts"];

/**
 * Directories, relative to the package root, that {@link ALL_TEST_GLOBS}
 * searches. The coverage test walks exactly these, so a test file added
 * anywhere the default run reaches is also one the coverage test can see.
 */
export const TEST_SOURCE_DIRS: readonly string[] = ["src", "seed"];

/**
 * The test files that need a real D1 / workerd runtime, as paths relative to
 * the package root.
 *
 * Used as the `include` of the D1 layer's config, and as the `exclude` of the
 * fast layer's config. Kept sorted, duplicate-free, and asserted against
 * {@link D1_RUNTIME_CRITERION} by `src/test/d1-layer-coverage.test.ts`.
 *
 * Because the fast layer is expressed as "everything except this list", a new
 * test file lands in the fast lane by default. That is the safe default: a new
 * test is verified by the gate that runs on every commit, and only a test that
 * demonstrably needs workerd has to be named here.
 */
export const D1_TEST_FILES: readonly string[] = [
  "seed/d1-cli.test.ts",
  "seed/d1.test.ts",
  "src/test/d1-integration.test.ts",
  "src/test/orders-migration-d1.test.ts",
];

/**
 * The definition of "this test needs a real D1 / workerd runtime", applied to a
 * test file's source text.
 *
 * Exported so the coverage test, and any future tooling that needs to reason
 * about the split, share one definition instead of restating it.
 *
 * Note the absence of a bare `miniflare` alternative: comments and doc
 * comments in the fast layer refer to Miniflare when they explain what the D1
 * layer covers, and matching those would drag fast tests into the slow lane.
 */
export const D1_RUNTIME_CRITERION: RegExp = /from "miniflare"|\.bin\/wrangler/;

/**
 * Per-test and per-hook timeout for every configuration in this package.
 *
 * This suite's floor is a process or workerd boot, not an assertion, so the
 * budget has to be sized for a boot. It applies to all three layers, and
 * uniformly, for one reason: the D1 layer's setup hooks are what actually need
 * it, and a fast layer that ran with a longer budget would be a lie about how
 * long the fast lane is allowed to take. No fast-layer test comes within an
 * order of magnitude of this.
 *
 * It is deliberately a single exported constant rather than a literal repeated
 * in three configs, because `hookTimeout` in particular is easy to add in one
 * place and forget in another — and forgetting it is invisible until a
 * contended run fails.
 */
export const BOOT_AWARE_TIMEOUT_MS = 120_000;
