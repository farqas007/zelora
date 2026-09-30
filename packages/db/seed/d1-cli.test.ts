import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadApiBinding } from "./d1";
import { FIXTURE_CREATED_AT_MS, FIXTURE_IMAGES, FIXTURE_USERS } from "./fixture";

/**
 * End-to-end rehearsal of the seed CLI (`./d1.ts`) as a real user runs it.
 *
 * The CLI is spawned exactly the way a user runs it, but pointed at a fresh
 * temp persistence dir per test (`--persist-to`), so no invocation ever
 * touches a shared local store, let alone the remote D1 database. Every
 * wrangler invocation is passed the committed `apps/api/wrangler.jsonc` via
 * `--config` (audit F), and the remote gate is exercised fully offline with
 * no `--remote` flag anywhere (audit G).
 *
 * NOTE: this file spawns the real `wrangler` and `tsx` CLIs, and every local
 * wrangler D1 call boots a fresh workerd runtime — so its floor is set by
 * process boots, not by assertions. Keep one invocation per distinct thing
 * being proven and batch statements into a single `d1 execute --file` (see
 * `wranglerFile`) rather than paying a boot per statement.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const API_CONFIG_PATH = join(REPO_ROOT, "apps/api/wrangler.jsonc");
const WRANGLER_BIN = fileURLToPath(new URL("../../../node_modules/.bin/wrangler", import.meta.url));
const TSX_BIN = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const D1_CLI = fileURLToPath(new URL("./d1.ts", import.meta.url));

/** Unrelated real row id (valid UUIDv7-shaped) for collision tests. */
const FOREIGN_ROW_ID = "0192a0ff-0000-7000-8000-0000000000ab";

/**
 * The URLs the fixture wrote for its images before the placehold.co switch,
 * index-aligned with `FIXTURE_IMAGES`. Pinned as literals so the refresh
 * rehearsal does not take its input from the code it exercises.
 */
const LEGACY_IMAGE_URLS = [
  "https://example.test/wireless-headphones.jpg",
  "https://example.test/gaming-keyboard.jpg",
  "https://example.test/gaming-mouse.jpg",
  "https://example.test/led-desk-lamp.jpg",
] as const;

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the real wrangler CLI against a hermetic local persistence dir. */
function wrangler(args: string[]): CliRun {
  const result = spawnSync(WRANGLER_BIN, ["--config", API_CONFIG_PATH, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Run one or more statements in a **single** `wrangler d1 execute --file`.
 *
 * Every local wrangler D1 call boots a fresh workerd runtime, so issuing the
 * statements one `--command` at a time pays that boot once per statement. One
 * `--file` runs them all in one boot and, with `--json`, still reports one
 * result entry per statement, which is what `assertStatementsApplied` checks.
 */
function wranglerFile(dir: string, statements: readonly string[]): D1JsonRun {
  const file = join(dir, "drift.sql");
  writeFileSync(file, `${statements.join("\n")}\n`);
  const run = wrangler(["d1", "execute", "zelora", "--local", "--persist-to", dir, "--file", file, "--json"]);
  return { ...run, entries: parseWranglerJson(run.stdout) };
}

interface D1JsonRun extends CliRun {
  /** One entry per statement in the `--file`, in order. */
  entries: Array<{ success?: boolean }>;
}

/** The `--json` payload wrangler prints on stdout, or `[]` when there is none. */
function parseWranglerJson(stdout: string): Array<{ success?: boolean }> {
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? (parsed as Array<{ success?: boolean }>) : [];
  } catch {
    return [];
  }
}

/** Every statement in the file ran, and the file really held all of them. */
function assertStatementsApplied(run: D1JsonRun, expected: number): void {
  expect(run.status).toBe(0);
  expect(run.entries).toHaveLength(expected);
  expect(run.entries.every((entry) => entry.success === true)).toBe(true);
}

/** Run the seed CLI via tsx. ZELORA_REMOTE_SEED_ALLOW is always stripped so a
 * stray shell export can never widen a gate during a rehearsal. */
function seedCli(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): CliRun {
  const env = opts.env ? { ...opts.env } : { ...process.env };
  delete env.ZELORA_REMOTE_SEED_ALLOW;
  const result = spawnSync(TSX_BIN, [D1_CLI, ...args], { encoding: "utf8", cwd: REPO_ROOT, env });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Run the seed CLI with ZELORA_REMOTE_SEED_ALLOW deliberately SET.
 *
 * `seedCli` strips it for safety, so the "env set but --yes missing" gate case
 * needs its own path. The gate must fire before any wrangler invocation, so
 * this stays purely offline: no `--remote` flag is passed and the process
 * refuses before it could reach the network.
 */
function seedCliWithAllowEnv(args: string[]): CliRun {
  const result = spawnSync(TSX_BIN, [D1_CLI, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, ZELORA_REMOTE_SEED_ALLOW: "1" },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A fresh, empty persistence dir for one hermetic CLI test. */
function tempD1Dir(): string {
  return mkdtempSync(join(tmpdir(), "zelora-d1-"));
}

describe("remote D1 seed CLI (hermetic, audits E/F/G/H)", () => {
  it("runs the full local workflow through the real CLI: apply, verify, no-op re-apply, cleanup, re-apply", () => {
    const dir = tempD1Dir();

    const migrated = wrangler(["d1", "migrations", "apply", "zelora", "--local", "--persist-to", dir]);
    expect(migrated.status).toBe(0);

    const apply1 = seedCli(["apply", "--database", "zelora", "--local", "--persist-to", dir]);
    expect(apply1.status).toBe(0);
    expect(apply1.stdout).toContain("applied fixture; verification matches");

    const verify = seedCli(["verify", "--database", "zelora", "--local", "--persist-to", dir]);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain("fixture fully present");
    expect(verify.stdout).toContain("zelora-test-store / wireless-headphones");

    const apply2 = seedCli(["apply", "--database", "zelora", "--local", "--persist-to", dir]);
    expect(apply2.status).toBe(0);
    expect(apply2.stdout).toContain("already fully present; nothing to do");

    const cleanup = seedCli(["cleanup", "--database", "zelora", "--local", "--persist-to", dir]);
    expect(cleanup.status).toBe(0);
    expect(cleanup.stdout).toContain("fixture cleaned");

    const apply3 = seedCli(["apply", "--database", "zelora", "--local", "--persist-to", dir]);
    expect(apply3.status).toBe(0);
    expect(apply3.stdout).toContain("applied fixture; verification matches");
  }, 400_000);

  it("refuses to apply when an unrelated real row claims a fixture natural key", () => {
    const dir = tempD1Dir();

    const migrated = wrangler(["d1", "migrations", "apply", "zelora", "--local", "--persist-to", dir]);
    expect(migrated.status).toBe(0);

    const seeded = wrangler([
      "d1",
      "execute",
      "zelora",
      "--local",
      "--persist-to",
      dir,
      "--command",
      `INSERT INTO users (id, email, role, status, name, password_hash, created_at, updated_at) VALUES ('${FOREIGN_ROW_ID}', '${FIXTURE_USERS[0]!.email}', 'customer', 'active', 'Real Customer With The Same Email', NULL, ${FIXTURE_CREATED_AT_MS}, ${FIXTURE_CREATED_AT_MS})`,
    ]);
    expect(seeded.status).toBe(0);

    const apply = seedCli(["apply", "--database", "zelora", "--local", "--persist-to", dir]);
    expect(apply.status).not.toBe(0);
    const output = [apply.stdout, apply.stderr].join("\n");
    expect(output).toContain("refusing to apply");
    expect(output).toContain("users_fixture");
  }, 180_000);

  it("aborts on a schema missing required tables and surfaces the migrations hint", () => {
    const apply = seedCli(["apply", "--database", "zelora", "--local", "--persist-to", tempD1Dir()]);
    expect(apply.status).not.toBe(0);
    const output = [apply.stdout, apply.stderr].join("\n");
    expect(output).toContain("missing required tables");
    expect(output).toContain("wrangler d1 migrations apply zelora --local --config apps/api/wrangler.jsonc");
  }, 90_000);

  it("refuses a remote apply before any write unless the allow env is set, even with --yes", () => {
    // Purely offline: the gate fires before any wrangler invocation, and no
    // --remote/--local flag is even passed here.
    const apply = seedCli(["apply", "--database", "zelora", "--yes"]);
    expect(apply.status).not.toBe(0);
    const output = [apply.stdout, apply.stderr].join("\n");
    expect(output).toContain("remote apply refused");
    expect(output).toContain("DB/zelora/245a64cf-0841-4faf-978c-171c03fd0dc8");
  });

  it("refuses a remote refresh-images without the allow env, and without --yes", () => {
    // Purely offline: the gate fires before any wrangler invocation, and no
    // --remote flag is even passed here.
    const noEnv = seedCli(["refresh-images", "--database", "zelora", "--yes"]);
    expect(noEnv.status).not.toBe(0);
    expect([noEnv.stdout, noEnv.stderr].join("\n")).toContain("remote apply refused");

    const envButNoYes = seedCliWithAllowEnv(["refresh-images", "--database", "zelora"]);
    expect(envButNoYes.status).not.toBe(0);
    const output = [envButNoYes.stdout, envButNoYes.stderr].join("\n");
    expect(output).toContain("remote apply refused");
    expect(output).toContain("--yes");
  });

  it("rehearses refresh-images end to end on a local D1 database: stale to current, then idempotent", () => {
    const dir = tempD1Dir();

    const migrated = wrangler(["d1", "migrations", "apply", "zelora", "--local", "--persist-to", dir]);
    expect(migrated.status).toBe(0);

    const seeded = seedCli(["apply", "--database", "zelora", "--local", "--persist-to", dir]);
    expect(seeded.status).toBe(0);

    // Drift each image row onto its legacy URL by deterministic id, exactly as
    // the live database is. Pinned as literals, index-aligned with
    // FIXTURE_IMAGES, so this rehearsal does not take its input from the code
    // it is exercising. All four in one `d1 execute --file`: four separate
    // invocations would boot workerd four times over for the same four writes.
    const drifted = wranglerFile(
      dir,
      LEGACY_IMAGE_URLS.map(
        (legacy, index) =>
          `UPDATE product_images SET url = '${legacy}' WHERE id = '${FIXTURE_IMAGES[index]!.id}';`,
      ),
    );
    assertStatementsApplied(drifted, LEGACY_IMAGE_URLS.length);

    const refresh = seedCli(["refresh-images", "--database", "zelora", "--local", "--persist-to", dir]);
    expect(refresh.status).toBe(0);
    expect(refresh.stdout).toContain(`${FIXTURE_IMAGES.length} fixture image row(s) carry a stale URL`);
    expect(refresh.stdout).toContain(`refreshed ${FIXTURE_IMAGES.length} fixture image row(s) to the current URL`);

    // The catalog is intact: a url-only refresh must not have deleted anything.
    const verify = seedCli(["verify", "--database", "zelora", "--local", "--persist-to", dir]);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain("fixture fully present");

    // Idempotent: a second run finds nothing stale and writes nothing.
    const again = seedCli(["refresh-images", "--database", "zelora", "--local", "--persist-to", dir]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already carry the current URL; nothing to refresh");
  }, 400_000);

  it("loadApiBinding accepts only the committed binding identity", () => {
    const binding = loadApiBinding();
    expect(binding).toEqual({
      binding: "DB",
      databaseName: "zelora",
      databaseId: "245a64cf-0841-4faf-978c-171c03fd0dc8",
    });

    const dir = tempD1Dir();
    const wrong = join(dir, "wrangler.jsonc");
    writeFileSync(
      wrong,
      [
        '{',
        '  "d1_databases": [',
        '    { "binding": "DB", "database_name": "zelora2", "database_id": "00000000-0000-0000-0000-000000000000" }',
        '  ]',
        '}',
      ].join("\n"),
    );
    expect(() => loadApiBinding(new URL(`file://${wrong}`))).toThrow(/Refusing to seed/);
  });
});