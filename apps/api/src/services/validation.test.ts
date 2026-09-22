import { describe, expect, it } from "vitest";
import { ValidationError } from "@zelora/core";
import {
  normalizeEmail,
  normalizeName,
  parseLoginRequest,
  parseRegisterRequest,
  validateEmail,
  validateName,
  validatePassword,
} from "./validation";

function expectFieldErrors(run: () => unknown, expected: Record<string, string[]>): void {
  try {
    run();
    expect.unreachable("expected a ValidationError");
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.statusCode).toBe(422);
    expect(error.fields).toEqual(expected);
  }
}

describe("normalization helpers", () => {
  it("normalizes an email by trimming and lowercasing", () => {
    expect(normalizeEmail("  USER@Example.COM ")).toBe("user@example.com");
  });

  it("trims a name without altering case", () => {
    expect(normalizeName("  Ada Lovelace  ")).toBe("Ada Lovelace");
  });
});

describe("validateEmail", () => {
  it("accepts a valid email", () => {
    expect(validateEmail("user@example.com")).toEqual([]);
  });

  it("rejects an email without an @ symbol", () => {
    expect(validateEmail("not-an-email")).toEqual(["Email is invalid."]);
  });

  it("rejects an email outside the length bounds", () => {
    const tooLong = `${"a".repeat(250)}@example.com`;
    expect(validateEmail(tooLong)).toEqual([
      "Email must be between 3 and 254 characters.",
    ]);
  });
});

describe("validatePassword", () => {
  it("accepts a password within the length bounds", () => {
    expect(validatePassword("password123")).toEqual([]);
  });

  it("rejects a password that is too short", () => {
    expect(validatePassword("short")).toEqual([
      "Password must be at least 8 characters.",
    ]);
  });

  it("rejects a password that is too long", () => {
    expect(validatePassword("x".repeat(129))).toEqual([
      "Password must be at most 128 characters.",
    ]);
  });
});

describe("validateName", () => {
  it("accepts a name within the length bounds", () => {
    expect(validateName("Ada Lovelace")).toEqual([]);
  });

  it("rejects an empty name", () => {
    expect(validateName("")).toEqual([
      "Name must be between 1 and 80 characters.",
    ]);
  });

  it("rejects a name that is too long", () => {
    expect(validateName("x".repeat(81))).toEqual([
      "Name must be between 1 and 80 characters.",
    ]);
  });
});

describe("parseRegisterRequest", () => {
  it("accepts a valid body and returns normalized values", () => {
    const request = parseRegisterRequest({
      email: "  USER@Example.COM ",
      password: "password123",
      name: "  Ada Lovelace  ",
    });

    expect(request).toEqual({
      email: "user@example.com",
      password: "password123",
      name: "Ada Lovelace",
    });
  });

  it("reports every missing required field at once", () => {
    expectFieldErrors(() => parseRegisterRequest({}), {
      email: ["Email is required."],
      password: ["Password is required."],
      name: ["Name is required."],
    });
  });

  it("reports a non-string field alongside other missing fields", () => {
    expectFieldErrors(() => parseRegisterRequest({ email: 42 }), {
      email: ["Email must be a string."],
      password: ["Password is required."],
      name: ["Name is required."],
    });
  });

  it("rejects an invalid email and a too-short password together", () => {
    expectFieldErrors(() => parseRegisterRequest({ email: "bad", password: "short", name: "Ada" }), {
      email: ["Email is invalid."],
      password: ["Password must be at least 8 characters."],
    });
  });

  it("rejects a body that is not an object", () => {
    expectFieldErrors(() => parseRegisterRequest(null), {
      body: ["Request body must be a JSON object."],
    });
    expectFieldErrors(() => parseRegisterRequest([]), {
      body: ["Request body must be a JSON object."],
    });
    expectFieldErrors(() => parseRegisterRequest("email@x.com"), {
      body: ["Request body must be a JSON object."],
    });
    expectFieldErrors(() => parseRegisterRequest(42), {
      body: ["Request body must be a JSON object."],
    });
  });
});

describe("parseLoginRequest", () => {
  it("accepts a valid body and normalizes the email", () => {
    const request = parseLoginRequest({
      email: "  USER@Example.COM ",
      password: "password123",
    });

    expect(request).toEqual({ email: "user@example.com", password: "password123" });
  });

  it("reports field errors for invalid fields", () => {
    expectFieldErrors(() => parseLoginRequest({ email: "nope", password: "x" }), {
      email: ["Email is invalid."],
      password: ["Password must be at least 8 characters."],
    });
  });

  it("rejects a body that is not an object", () => {
    expectFieldErrors(() => parseLoginRequest("nope"), {
      body: ["Request body must be a JSON object."],
    });
  });
});