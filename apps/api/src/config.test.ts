import { describe, expect, it } from "vitest";
import { AppError, loadConfig } from "@zelora/core";

describe("loadConfig auth defaults", () => {
  it("provides development-safe defaults", () => {
    const config = loadConfig({ NODE_ENV: "test" });

    expect(config.nodeEnv).toBe("test");
    expect(config.sessionCookieName).toBe("zelora_session");
    expect(config.sessionTtlSeconds).toBe(2_592_000);
    expect(config.sessionCookieSecure).toBe(false);
    expect(config.pbkdf2Iterations).toBe(210_000);
  });

  it("defaults the session cookie to Secure in production", () => {
    expect(loadConfig({ NODE_ENV: "production" }).sessionCookieSecure).toBe(true);
  });

  it("lets an explicit SESSION_COOKIE_SECURE value win in either direction", () => {
    expect(loadConfig({ NODE_ENV: "development", SESSION_COOKIE_SECURE: "true" }).sessionCookieSecure).toBe(true);
    expect(loadConfig({ NODE_ENV: "production", SESSION_COOKIE_SECURE: "false" }).sessionCookieSecure).toBe(false);
    expect(loadConfig({ NODE_ENV: "development", SESSION_COOKIE_SECURE: "1" }).sessionCookieSecure).toBe(true);
    expect(loadConfig({ NODE_ENV: "development", SESSION_COOKIE_SECURE: "0" }).sessionCookieSecure).toBe(false);
  });

  it("parses explicit session and pbkdf2 tuning", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      SESSION_COOKIE_NAME: "custom_session",
      SESSION_TTL_SECONDS: "7200",
      PBKDF2_ITERATIONS: "100000",
    });

    expect(config.sessionCookieName).toBe("custom_session");
    expect(config.sessionTtlSeconds).toBe(7200);
    expect(config.pbkdf2Iterations).toBe(100_000);
  });
});

describe("loadConfig invalid values", () => {
  function expectConfigRejected(env: Record<string, string | undefined>): void {
    try {
      loadConfig({ NODE_ENV: "test", ...env });
      expect.unreachable("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("APP_CONFIG_INVALID");
    }
  }

  it.each([
    { name: "zero session TTL", env: { SESSION_TTL_SECONDS: "0" } },
    { name: "negative session TTL", env: { SESSION_TTL_SECONDS: "-100" } },
    { name: "fractional session TTL", env: { SESSION_TTL_SECONDS: "1.5" } },
    { name: "non-numeric session TTL", env: { SESSION_TTL_SECONDS: "abc" } },
    { name: "zero pbkdf2 iterations", env: { PBKDF2_ITERATIONS: "0" } },
    { name: "fractional pbkdf2 iterations", env: { PBKDF2_ITERATIONS: "1.5" } },
    { name: "non-numeric pbkdf2 iterations", env: { PBKDF2_ITERATIONS: "many" } },
    { name: "unparsable secure flag", env: { SESSION_COOKIE_SECURE: "maybe" } },
    { name: "non-1/0 secure flag shorthand", env: { SESSION_COOKIE_SECURE: "yes" } },
    { name: "whitespace-only cookie name", env: { SESSION_COOKIE_NAME: "   " } },
    { name: "invalid port", env: { PORT: "70000" } },
  ])("rejects $name with APP_CONFIG_INVALID", ({ env }) => {
    expectConfigRejected(env);
  });

  it("keeps empty-string tuning values on their defaults", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      SESSION_TTL_SECONDS: "",
      PBKDF2_ITERATIONS: "",
      SESSION_COOKIE_NAME: "",
    });

    expect(config.sessionTtlSeconds).toBe(2_592_000);
    expect(config.pbkdf2Iterations).toBe(210_000);
    expect(config.sessionCookieName).toBe("zelora_session");
  });
});