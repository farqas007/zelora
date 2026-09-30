import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_TEST_GLOBS,
  BOOT_AWARE_TIMEOUT_MS,
  D1_RUNTIME_CRITERION,
  D1_TEST_FILES,
  TEST_SOURCE_DIRS,
} from "../../vitest.layers";
import completeConfig from "../../vitest.config";
import d1Config from "../../vitest.d1.config";
import fastConfig from "../../vitest.fast.config";

/**
 * Guard for the fast / D1 test-layer split.
 *
 * The split is only worth anything if it is a *partition*: every test file
 * must land in exactly one layer, no test may quietly stop running, and the
 * D1 list may not drift away from what the D1 files actually do. Without a
 * check, all three of those fail silently — a renamed test drops out of both
 * lanes, a new workerd test is added to the fast lane and makes every commit
 * slow again, and a stale entry in the list points at a file that no longer
 * exists. None of those produce a failure. They just quietly undo the split.
 *
 * So this file asserts the partition directly, against the files on disk and
 * against the live Vitest configurations — not against a copy of them, so the
 * manifest and the three configs cannot drift apart either.
 *
 * The test is pure filesystem and text work and runs in the fast layer.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every `*.test.ts` under the directories the default run searches. */
function listTestFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      listTestFiles(full, found);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      // Normalised to forward slashes so the paths compare equal to the
      // manifest's regardless of the platform the suite runs on.
      found.push(relative(PACKAGE_ROOT, full).split(sep).join("/"));
    }
  }
  return found;
}

const testFiles = TEST_SOURCE_DIRS.flatMap((directory) =>
  listTestFiles(join(PACKAGE_ROOT, directory)),
).sort();

const d1Layer = new Set(D1_TEST_FILES);
const fastLayer = testFiles.filter((file) => !d1Layer.has(file));

/** Whether a test file's own source says it drives a real D1 / workerd runtime. */
function needsRealD1Runtime(file: string): boolean {
  return D1_RUNTIME_CRITERION.test(readFileSync(join(PACKAGE_ROOT, file), "utf8"));
}

describe("test layer partition", () => {
  it("finds the test files the default run searches", () => {
    // A silently empty walk would make every assertion below vacuously true.
    expect(testFiles.length).toBeGreaterThan(0);
    expect(testFiles).toContain("src/test/d1-layer-coverage.test.ts");
  });

  it("lists no duplicate D1 files", () => {
    expect(d1Layer.size).toBe(D1_TEST_FILES.length);
  });

  it("lists only files that exist and are tests", () => {
    for (const file of D1_TEST_FILES) {
      expect(statSync(join(PACKAGE_ROOT, file)).isFile(), `${file} is listed but missing`).toBe(true);
      expect(file.endsWith(".test.ts"), `${file} is listed but is not a test file`).toBe(true);
    }
  });

  it("covers every test file exactly once, so nothing is dropped from either lane", () => {
    expect(fastLayer.length + d1Layer.size).toBe(testFiles.length);
    expect(new Set([...fastLayer, ...D1_TEST_FILES]).size).toBe(testFiles.length);
  });

  it("runs every D1 file in the D1 lane, and every other file in the fast lane", () => {
    for (const file of D1_TEST_FILES) {
      expect(testFiles, `${file} is in the D1 list but is not a test file on disk`).toContain(file);
    }
    for (const file of fastLayer) {
      expect(D1_TEST_FILES).not.toContain(file);
    }
  });
});

describe("D1 list matches what the D1 files actually do", () => {
  it("every listed file drives a real D1 / workerd runtime", () => {
    for (const file of D1_TEST_FILES) {
      expect(needsRealD1Runtime(file), `${file} is in the D1 list but needs no workerd runtime`).toBe(
        true,
      );
    }
  });

  it("no unlisted file drives a real D1 / workerd runtime", () => {
    // The check that makes the split self-maintaining: a new Miniflare or
    // wrangler-spawning test that was not added to the manifest fails here,
    // instead of silently landing in the fast lane and making every commit
    // wait on a workerd boot.
    for (const file of fastLayer) {
      expect(needsRealD1Runtime(file), `${file} needs a real D1 runtime but is not in D1_TEST_FILES`).toBe(
        false,
      );
    }
  });
});

describe("Vitest configurations agree with the manifest", () => {
  const completeInclude = completeConfig.test?.include as string[];
  const fastInclude = fastConfig.test?.include as string[];
  const fastExclude = fastConfig.test?.exclude as string[];
  const d1Include = d1Config.test?.include as string[];

  it("the default configuration still runs the complete suite", () => {
    // `pnpm test` and a bare `vitest run` in this package must keep executing
    // every test. The layers are opt-in; nothing is opt-out.
    expect([...completeInclude].sort()).toEqual([...ALL_TEST_GLOBS].sort());
    expect(completeConfig.test?.exclude).toBeUndefined();
  });

  it("the fast configuration is the complete suite minus the D1 list", () => {
    expect([...fastInclude].sort()).toEqual([...ALL_TEST_GLOBS].sort());
    expect([...fastExclude].sort()).toEqual([...D1_TEST_FILES].sort());
  });

  it("the D1 configuration is exactly the D1 list", () => {
    expect([...d1Include].sort()).toEqual([...D1_TEST_FILES].sort());
  });

  it("all three layers keep the environment and the boot-aware timeouts", () => {
    for (const config of [completeConfig, fastConfig, d1Config]) {
      expect(config.test?.environment).toBe("node");
      // `hookTimeout` matters as much as `testTimeout` here: the D1 layer's
      // setup hooks boot workerd, and Vitest's 10s default silently fails the
      // file — and then its tests — whenever a boot outruns it.
      expect(config.test?.testTimeout).toBe(BOOT_AWARE_TIMEOUT_MS);
      expect(config.test?.hookTimeout).toBe(BOOT_AWARE_TIMEOUT_MS);
    }
  });

  it("sizes the boot-aware budget for a workerd boot, not an assertion", () => {
    // Guards against someone "fixing" a slow run by cutting this below what a
    // Miniflare boot needs. The seed tooling already assumes 30s for a single
    // boot; a budget under that is not a budget.
    expect(BOOT_AWARE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
