import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "@zelora/core";
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from "./cookie";

function makeApp(config: AppConfig): Hono {
  const app = new Hono();

  app.get("/set", (c) => {
    setSessionCookie(config, c, "raw-session-token");
    return c.text("ok");
  });

  app.get("/read", (c) => c.text(readSessionCookie(config, c) ?? ""));

  app.get("/clear", (c) => {
    clearSessionCookie(config, c);
    return c.text("ok");
  });

  return app;
}

describe("session cookie helpers", () => {
  const config = loadConfig({ NODE_ENV: "test" });

  it("sets the configured session cookie with the full security attribute set", async () => {
    const app = makeApp(config);
    const response = await app.request("/set");

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toMatch(/^zelora_session=raw-session-token/);
    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
  });

  it("marks the cookie Secure when configured so", async () => {
    const secureConfig = loadConfig({ NODE_ENV: "test", SESSION_COOKIE_SECURE: "true" });
    const response = await makeApp(secureConfig).request("/set");

    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("honors a custom cookie name and TTL from config", async () => {
    const customConfig = loadConfig({
      NODE_ENV: "test",
      SESSION_COOKIE_NAME: "custom_session",
      SESSION_TTL_SECONDS: "3600",
    });
    const response = await makeApp(customConfig).request("/set");

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toMatch(/^custom_session=raw-session-token/);
    expect(setCookie).toContain("Max-Age=3600");
  });

  it("reads the session cookie back from a request", async () => {
    const app = makeApp(config);
    const response = await app.request("/read", {
      headers: { Cookie: "zelora_session=raw-session-token" },
    });

    expect(await response.text()).toBe("raw-session-token");
  });

  it("returns undefined when no session cookie is present", async () => {
    const response = await makeApp(config).request("/read");

    expect(await response.text()).toBe("");
  });

  it("clears the session cookie by expiring it immediately", async () => {
    const response = await makeApp(config).request("/clear", {
      headers: { Cookie: "zelora_session=old-token" },
    });

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toMatch(/^zelora_session=;/);
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("old-token");
  });
});