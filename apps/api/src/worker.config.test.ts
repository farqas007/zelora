import { describe, expect, it } from "vitest";
import { loadWorkerConfig, type Env } from "./worker";

describe("worker config", () => {
  it("resolves to Workers-supported PBKDF2 iteration count when not specified", () => {
    const config = loadWorkerConfig({ DB: {} } as Env);
    expect(config.pbkdf2Iterations).toBeLessThanOrEqual(100_000);
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
