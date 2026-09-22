import { describe, expect, it } from "vitest";
import { loadWorkerConfig, type Env } from "./worker";

describe("worker env configuration", () => {
  it("never uses unsupported 210000 iteration count by default", () => {
    const config = loadWorkerConfig({ DB: {} } as Env);
    expect(config.pbkdf2Iterations).toBe(100_000);
  });

  it("uses explicit worker env value when provided", () => {
    const config = loadWorkerConfig({ DB: {}, PBKDF2_ITERATIONS: "100000" } as Env);
    expect(config.pbkdf2Iterations).toBe(100_000);
  });

  it("allows lower worker-specific values", () => {
    const config = loadWorkerConfig({ DB: {}, PBKDF2_ITERATIONS: "31000" } as Env);
    expect(config.pbkdf2Iterations).toBe(31000);
  });
});
