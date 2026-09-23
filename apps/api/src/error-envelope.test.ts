import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  AppError,
  TooManyRequestsError,
  ValidationError,
  toApiFailure,
  type Logger,
} from "@zelora/core";
import type { ApiFailure } from "@zelora/shared";
import { createErrorHandler } from "./middleware/error";

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("error envelope (ApiErrorBody)", () => {
  it("keeps the envelope backward compatible: an AppError without fields serializes no fields key", () => {
    const failure = toApiFailure(new AppError("SOME_CODE", "boom.", 400));
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error.code).toBe("SOME_CODE");
      expect(failure.error.message).toBe("boom.");
      expect(failure.error.details).toBeUndefined();
      expect(failure.error.fields).toBeUndefined();
    }
  });

  it("serializes details when present and leaves fields absent", () => {
    const failure = toApiFailure(new AppError("SOME_CODE", "boom.", 400, { resource: "x" }));
    if (!failure.ok) {
      expect(failure.error.details).toEqual({ resource: "x" });
      expect(failure.error.fields).toBeUndefined();
    }
  });

  it("serializes per-field validation errors on the top-level fields key", () => {
    const failure = toApiFailure(
      new ValidationError("The request is invalid.", { email: ["Email is invalid."] }),
    );
    if (!failure.ok) {
      expect(failure.error.code).toBe("VALIDATION_ERROR");
      expect(failure.error.fields).toEqual({ email: ["Email is invalid."] });
    }
  });

  it("leaves fields absent for a ValidationError created without fields", () => {
    const failure = toApiFailure(new ValidationError("The request is invalid."));
    if (!failure.ok) {
      expect(failure.error.code).toBe("VALIDATION_ERROR");
      expect(failure.error.fields).toBeUndefined();
    }
  });

  it("keeps details and fields independent on the same error", () => {
    const failure = toApiFailure(
      new ValidationError("The request is invalid.", { slug: ["Slug is taken."] }, { resource: "slug" }),
    );
    if (!failure.ok) {
      expect(failure.error.fields).toEqual({ slug: ["Slug is taken."] });
      expect(failure.error.details).toEqual({ resource: "slug" });
    }
  });

  it("maps unknown errors to INTERNAL_ERROR with no leaked message and no extra keys", () => {
    const failure = toApiFailure(new Error("oops"));
    if (!failure.ok) {
      expect(failure.error.code).toBe("INTERNAL_ERROR");
      expect(failure.error.message).toBe("Internal server error.");
      expect(failure.error.message).not.toContain("oops");
      expect(failure.error.fields).toBeUndefined();
      expect(failure.error.details).toBeUndefined();
    }
  });
});

describe("HTTP 429 support", () => {
  it("maps a TooManyRequestsError to the RATE_LIMITED code with status 429", () => {
    const error = new TooManyRequestsError();
    expect(error.statusCode).toBe(429);
    const failure = toApiFailure(error);
    if (!failure.ok) {
      expect(failure.error.code).toBe("RATE_LIMITED");
    }
  });

  it("returns HTTP 429 with the typed envelope through the error boundary", async () => {
    const app = new Hono();
    app.onError(createErrorHandler(silentLogger));
    app.get("/boom", () => {
      throw new TooManyRequestsError();
    });

    const response = await app.request("/boom");
    expect(response.status).toBe(429);

    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("still maps a non-AppError to HTTP 500 through the error boundary", async () => {
    const app = new Hono();
    app.onError(createErrorHandler(silentLogger));
    app.get("/boom", () => {
      throw new Error("boom");
    });

    const response = await app.request("/boom");
    expect(response.status).toBe(500);

    const body = (await response.json()) as ApiFailure;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error.");
    expect(body.error.message).not.toContain("boom");
  });
});