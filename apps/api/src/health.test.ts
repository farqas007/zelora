import { describe, expect, it } from "vitest";
import type { ApiFailure, HealthResponse } from "@zelora/shared";
import { loadConfig } from "@zelora/core";
import { createApp } from "./app";

function makeTestConfig() {
  return loadConfig({ NODE_ENV: "test" });
}

describe("GET /api/health", () => {
  it("returns 200 with a typed success envelope", async () => {
    const app = createApp(makeTestConfig());
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);

    const body = (await response.json()) as { ok: true; data: HealthResponse };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
    expect(body.data.service).toBe("zelora-api");
    expect(body.data.version).toBe("0.1.0");
    expect(Number.isNaN(Date.parse(body.data.timestamp))).toBe(false);
  });

  it("responds to unknown routes with a typed error envelope", async () => {
    const app = createApp(makeTestConfig());
    const response = await app.request("/api/does-not-exist");

    expect(response.status).toBe(404);

    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
  });
});