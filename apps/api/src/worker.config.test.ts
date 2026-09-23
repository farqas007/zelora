import { describe, expect, it } from "vitest";
import { AppError } from "@zelora/core";
import {
  loadWorkerConfig,
  PBKDF2_WORKER_MAX_ITERATIONS,
  type Env,
} from "./worker";

describe("worker config", () => {
  it("resolves to Workers-supported PBKDF2 iteration count when not specified", () => {
    const config = loadWorkerConfig({ DB: {} } as Env);
    expect(config.pbkdf2Iterations).toBeLessThanOrEqual(PBKDF2_WORKER_MAX_ITERATIONS);
    expect(config.pbkdf2Iterations).toBeGreaterThan(0);
  });

  it("respects explicit PBKDF2_ITERATIONS binding when provided", () => {
    const config = loadWorkerConfig({ DB: {}, PBKDF2_ITERATIONS: "50000" } as Env);
    expect(config.pbkdf2Iterations).toBe(50000);
  });

  it("defaults to production NODE_ENV when not specified", () => {
    const config = loadWorkerConfig({ DB: {} } as Env);
    expect(config.nodeEnv).toBe("production");
  });

  it("does not fall back to unsupported 210000 value", () => {
    const config = loadWorkerConfig({ DB: {} } as Env);
    expect(config.pbkdf2Iterations).not.toBe(210_000);
  });
});

describe("worker config: PBKDF2 boundary and invalid values", () => {
  function expectConfigRejected(env: Partial<Env>): void {
    try {
      loadWorkerConfig({ DB: {}, ...env } as Env);
      expect.unreachable("expected loadWorkerConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("APP_CONFIG_INVALID");
    }
  }

  it("accepts exactly the Workers Web Crypto boundary of 100000", () => {
    const config = loadWorkerConfig({ DB: {}, PBKDF2_ITERATIONS: "100000" } as Env);
    expect(config.pbkdf2Iterations).toBe(PBKDF2_WORKER_MAX_ITERATIONS);
  });

  it("accepts the minimum of one iteration", () => {
    const config = loadWorkerConfig({ DB: {}, PBKDF2_ITERATIONS: "1" } as Env);
    expect(config.pbkdf2Iterations).toBe(1);
  });

  it("rejects an explicit count copied from the Node default (210000)", () => {
    expectConfigRejected({ PBKDF2_ITERATIONS: "210000" });
  });

  it("rejects counts one above the Workers limit", () => {
    expectConfigRejected({ PBKDF2_ITERATIONS: String(PBKDF2_WORKER_MAX_ITERATIONS + 1) });
  });

  it("rejects non-positive and non-numeric iteration bindings", () => {
    expectConfigRejected({ PBKDF2_ITERATIONS: "0" });
    expectConfigRejected({ PBKDF2_ITERATIONS: "-1" });
    expectConfigRejected({ PBKDF2_ITERATIONS: "1.5" });
    expectConfigRejected({ PBKDF2_ITERATIONS: "many" });
    expectConfigRejected({ PBKDF2_ITERATIONS: "99999999999999999999" });
  });
});

describe("worker config: session cookie posture", () => {
  it("keeps the session cookie Secure in the default production posture", () => {
    const config = loadWorkerConfig({ DB: {} } as Env);
    expect(config.nodeEnv).toBe("production");
    expect(config.sessionCookieSecure).toBe(true);
  });

  it("keeps the session cookie Secure when production is declared explicitly", () => {
    const config = loadWorkerConfig({ DB: {}, NODE_ENV: "production", SESSION_COOKIE_SECURE: "true" } as Env);
    expect(config.sessionCookieSecure).toBe(true);
  });

  it("makes local development explicitly non-Secure so plain-HTTP Wrangler dev works", () => {
    const config = loadWorkerConfig({ DB: {}, NODE_ENV: "development" } as Env);
    expect(config.nodeEnv).toBe("development");
    expect(config.sessionCookieSecure).toBe(false);
  });

  it("accepts an explicit non-Secure flag in local development", () => {
    const config = loadWorkerConfig({ DB: {}, NODE_ENV: "development", SESSION_COOKIE_SECURE: "false" } as Env);
    expect(config.sessionCookieSecure).toBe(false);
  });

  it("rejects Secure cookies in a development environment instead of silently breaking auth", () => {
    try {
      loadWorkerConfig({ DB: {}, NODE_ENV: "development", SESSION_COOKIE_SECURE: "true" } as Env);
      expect.unreachable("expected loadWorkerConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("APP_CONFIG_INVALID");
      expect(String((error as AppError).message)).toContain("SESSION_COOKIE_SECURE");
    }
  });
});
