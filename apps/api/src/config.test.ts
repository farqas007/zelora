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
    expect(config.rateLimitEnabled).toBe(true);
    expect(config.rateLimitTrustProxy).toBe(false);
    expect(config.rateLimitLoginIpMax).toBe(20);
    expect(config.rateLimitLoginIpWindowSeconds).toBe(900);
    expect(config.rateLimitLoginEmailMax).toBe(10);
    expect(config.rateLimitLoginEmailWindowSeconds).toBe(900);
    expect(config.rateLimitRegisterIpMax).toBe(10);
    expect(config.rateLimitRegisterIpWindowSeconds).toBe(3_600);
    expect(config.rateLimitSellerOnboardingIpMax).toBe(10);
    expect(config.rateLimitSellerOnboardingIpWindowSeconds).toBe(3_600);
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

  it("applies rate-limit defaults and parses explicit overrides", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });

    expect(defaults.rateLimitEnabled).toBe(true);
    expect(defaults.rateLimitTrustProxy).toBe(false);
    expect(defaults.rateLimitLoginIpMax).toBe(20);
    expect(defaults.rateLimitLoginIpWindowSeconds).toBe(900);
    expect(defaults.rateLimitLoginEmailMax).toBe(10);
    expect(defaults.rateLimitLoginEmailWindowSeconds).toBe(900);
    expect(defaults.rateLimitRegisterIpMax).toBe(10);
    expect(defaults.rateLimitRegisterIpWindowSeconds).toBe(3_600);
    expect(defaults.rateLimitSellerOnboardingIpMax).toBe(10);
    expect(defaults.rateLimitSellerOnboardingIpWindowSeconds).toBe(3_600);

    const config = loadConfig({
      NODE_ENV: "test",
      RATE_LIMIT_ENABLED: "false",
      RATE_LIMIT_TRUST_PROXY: "true",
      RATE_LIMIT_LOGIN_IP_MAX: "5",
      RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS: "60",
      RATE_LIMIT_LOGIN_EMAIL_MAX: "3",
      RATE_LIMIT_LOGIN_EMAIL_WINDOW_SECONDS: "120",
      RATE_LIMIT_REGISTER_IP_MAX: "2",
      RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS: "1800",
      RATE_LIMIT_SELLER_ONBOARDING_IP_MAX: "7",
      RATE_LIMIT_SELLER_ONBOARDING_IP_WINDOW_SECONDS: "720",
    });

    expect(config.rateLimitEnabled).toBe(false);
    expect(config.rateLimitTrustProxy).toBe(true);
    expect(config.rateLimitLoginIpMax).toBe(5);
    expect(config.rateLimitLoginIpWindowSeconds).toBe(60);
    expect(config.rateLimitLoginEmailMax).toBe(3);
    expect(config.rateLimitLoginEmailWindowSeconds).toBe(120);
    expect(config.rateLimitRegisterIpMax).toBe(2);
    expect(config.rateLimitRegisterIpWindowSeconds).toBe(1_800);
    expect(config.rateLimitSellerOnboardingIpMax).toBe(7);
    expect(config.rateLimitSellerOnboardingIpWindowSeconds).toBe(720);
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
    { name: "zero login IP max", env: { RATE_LIMIT_LOGIN_IP_MAX: "0" } },
    { name: "negative login IP max", env: { RATE_LIMIT_LOGIN_IP_MAX: "-1" } },
    { name: "fractional login IP max", env: { RATE_LIMIT_LOGIN_IP_MAX: "1.5" } },
    { name: "non-numeric login IP max", env: { RATE_LIMIT_LOGIN_IP_MAX: "many" } },
    { name: "zero login IP window", env: { RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS: "0" } },
    { name: "negative login IP window", env: { RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS: "-10" } },
    { name: "fractional login IP window", env: { RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS: "900.5" } },
    { name: "non-numeric login IP window", env: { RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS: "ten" } },
    { name: "zero login email max", env: { RATE_LIMIT_LOGIN_EMAIL_MAX: "0" } },
    { name: "negative login email window", env: { RATE_LIMIT_LOGIN_EMAIL_WINDOW_SECONDS: "-1" } },
    { name: "zero register IP max", env: { RATE_LIMIT_REGISTER_IP_MAX: "0" } },
    { name: "non-numeric register IP window", env: { RATE_LIMIT_REGISTER_IP_WINDOW_SECONDS: "hour" } },
    { name: "zero seller onboarding IP max", env: { RATE_LIMIT_SELLER_ONBOARDING_IP_MAX: "0" } },
    { name: "negative seller onboarding IP max", env: { RATE_LIMIT_SELLER_ONBOARDING_IP_MAX: "-2" } },
    { name: "fractional seller onboarding IP window", env: { RATE_LIMIT_SELLER_ONBOARDING_IP_WINDOW_SECONDS: "3600.5" } },
    { name: "non-numeric seller onboarding IP window", env: { RATE_LIMIT_SELLER_ONBOARDING_IP_WINDOW_SECONDS: "hour" } },
    { name: "unparsable rate-limit enabled flag", env: { RATE_LIMIT_ENABLED: "maybe" } },
    { name: "non-1/0 trust proxy shorthand", env: { RATE_LIMIT_TRUST_PROXY: "yes" } },
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