import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppConfig, Logger } from "@zelora/core";
import type { ApiFailure } from "@zelora/shared";
import { MemoryWindowRateLimiter, type RateLimiter } from "../services/rate-limit";
import type { Clock } from "../services/clock";
import type { ClientIpResolver } from "../services/client-ip";
import { createErrorHandler } from "./error";
import { createIpRateLimitMiddleware } from "./rate-limit";

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

class FakeClock implements Clock {
  private currentTime: Date;

  constructor(startTime: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.currentTime = startTime;
  }

  now(): Date {
    return new Date(this.currentTime.getTime());
  }

  set(time: Date): void {
    this.currentTime = new Date(time.getTime());
  }

  advance(ms: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + ms);
  }
}

const baseConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3001,
  appVersion: "0.1.0",
  corsOrigin: "http://localhost:5173",
  sessionCookieName: "zelora_session",
  sessionTtlSeconds: 2_592_000,
  sessionCookieSecure: false,
  pbkdf2Iterations: 1_000,
  rateLimitEnabled: true,
  rateLimitTrustProxy: false,
  rateLimitLoginIpMax: 20,
  rateLimitLoginIpWindowSeconds: 900,
  rateLimitLoginEmailMax: 10,
  rateLimitLoginEmailWindowSeconds: 900,
  rateLimitRegisterIpMax: 10,
  rateLimitRegisterIpWindowSeconds: 3_600,
  rateLimitSellerOnboardingIpMax: 10,
  rateLimitSellerOnboardingIpWindowSeconds: 3_600,
};

const ipResolver: ClientIpResolver = {
  resolve: (c) => c.req.header("x-test-ip") ?? undefined,
};

function makeApp(config: AppConfig, limiter: RateLimiter, clock: Clock): Hono {
  const app = new Hono();
  app.onError(createErrorHandler(silentLogger));
  app.post(
    "/login",
    createIpRateLimitMiddleware({
      config,
      rateLimiter: limiter,
      clientIpResolver: ipResolver,
      clock,
      scope: "login",
      limit: config.rateLimitLoginIpMax,
      windowSeconds: config.rateLimitLoginIpWindowSeconds,
    }),
    (c) => c.json({ ok: true, data: { done: true } }),
  );
  return app;
}

async function request(app: Hono, ip?: string): Promise<Response> {
  return await app.request("/login", {
    method: "POST",
    headers:
      ip === undefined ? {} : { "X-Test-IP": ip, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "user@example.com", password: "password123" }),
  });
}

describe("ip rate limit middleware", () => {
  let clock: FakeClock;
  let limiter: MemoryWindowRateLimiter;

  beforeEach(() => {
    clock = new FakeClock();
    limiter = new MemoryWindowRateLimiter(clock);
  });

  it("is a transparent pass-through when rate limiting is disabled", async () => {
    const app = makeApp({ ...baseConfig, rateLimitEnabled: false }, limiter, clock);

    const response = await request(app, "203.0.113.5");
    expect(response.status).toBe(200);
  });

  it("allows requests up to the limit", async () => {
    const config: AppConfig = {
      ...baseConfig,
      rateLimitLoginIpMax: 2,
      rateLimitLoginIpWindowSeconds: 900,
    };
    const app = makeApp(config, limiter, clock);

    expect((await request(app, "203.0.113.5")).status).toBe(200);
    expect((await request(app, "203.0.113.5")).status).toBe(200);
    const blocked = await request(app, "203.0.113.5");
    expect(blocked.status).toBe(429);
  });

  it("returns HTTP 429 with the RATE_LIMITED envelope and Retry-After", async () => {
    const config: AppConfig = {
      ...baseConfig,
      rateLimitLoginIpMax: 1,
      rateLimitLoginIpWindowSeconds: 900,
    };
    const app = makeApp(config, limiter, clock);

    await request(app, "203.0.113.5");
    const blocked = await request(app, "203.0.113.5");

    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.details).toEqual({ retryAfterSeconds: 900, scope: "ip" });
    expect(blocked.headers.get("retry-after")).toBe("900");
  });

  it("calculates Retry-After from the remaining window with a one-second floor", async () => {
    const config: AppConfig = {
      ...baseConfig,
      rateLimitLoginIpMax: 1,
      rateLimitLoginIpWindowSeconds: 900,
    };
    const app = makeApp(config, limiter, clock);

    await request(app, "203.0.113.5");
    clock.advance(899_500);
    const blocked = await request(app, "203.0.113.5");

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");
    const body = (await blocked.json()) as ApiFailure;
    if (!body.ok) {
      expect(body.error.details).toEqual({ retryAfterSeconds: 1, scope: "ip" });
    }

    clock.advance(1_000);
    const afterReset = await request(app, "203.0.113.5");
    expect(afterReset.status).toBe(200);
  });

  it("keeps buckets for different IPs independent", async () => {
    const config: AppConfig = {
      ...baseConfig,
      rateLimitLoginIpMax: 1,
      rateLimitLoginIpWindowSeconds: 900,
    };
    const app = makeApp(config, limiter, clock);

    await request(app, "203.0.113.5");
    expect((await request(app, "203.0.113.5")).status).toBe(429);

    expect((await request(app, "198.51.100.9")).status).toBe(200);
  });

  it("routes unresolved IPs into the shared unknown bucket", async () => {
    const config: AppConfig = {
      ...baseConfig,
      rateLimitLoginIpMax: 1,
      rateLimitLoginIpWindowSeconds: 900,
    };
    const app = makeApp(config, limiter, clock);

    const first = await request(app, undefined);
    expect(first.status).toBe(200);

    const second = await request(app, undefined);
    expect(second.status).toBe(429);
  });

  it("calls the limiter with the namespaced key, limit and window", async () => {
    const consumeSpy = vi.spyOn(limiter, "consume");
    const config: AppConfig = {
      ...baseConfig,
      rateLimitLoginIpMax: 6,
      rateLimitLoginIpWindowSeconds: 120,
    };
    const app = makeApp(config, limiter, clock);

    await request(app, "203.0.113.5");

    expect(consumeSpy).toHaveBeenCalledTimes(1);
    expect(consumeSpy).toHaveBeenCalledWith("auth:login:ip:203.0.113.5", 6, 120);
  });

  it("stops before downstream work once blocked", async () => {
    const config: AppConfig = {
      ...baseConfig,
      rateLimitLoginIpMax: 1,
      rateLimitLoginIpWindowSeconds: 900,
    };
    const app = new Hono();
    app.onError(createErrorHandler(silentLogger));
    let downstreamCalls = 0;
    app.post(
      "/login",
      createIpRateLimitMiddleware({
        config,
        rateLimiter: limiter,
        clientIpResolver: ipResolver,
        clock,
        scope: "login",
        limit: config.rateLimitLoginIpMax,
        windowSeconds: config.rateLimitLoginIpWindowSeconds,
      }),
      (c) => {
        downstreamCalls += 1;
        return c.json({ ok: true });
      },
    );

    await request(app, "203.0.113.5");
    const blocked = await request(app, "203.0.113.5");

    expect(blocked.status).toBe(429);
    expect(downstreamCalls).toBe(1);
  });
});