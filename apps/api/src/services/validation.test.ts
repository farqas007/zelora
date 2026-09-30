import { describe, expect, it } from "vitest";
import { ValidationError } from "@zelora/core";
import { IDEMPOTENCY_KEY_LIMITS } from "@zelora/shared";
import {
  normalizeEmail,
  normalizeName,
  parseIdempotencyKey,
  parseLoginRequest,
  parseOrderAddress,
  parsePlaceOrderRequest,
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

describe("parseOrderAddress", () => {
  it("accepts a full address and normalizes the country code to uppercase", () => {
    const address = parseOrderAddress({
      recipientName: "  Ada Lovelace  ",
      phone: " +1 555 0100 ",
      line1: " 1 Analytical Way ",
      line2: " Suite 2 ",
      city: " London ",
      region: " England ",
      postalCode: " SW1A ",
      countryCode: "gb",
    });
    expect(address).toEqual({
      recipientName: "Ada Lovelace",
      phone: "+1 555 0100",
      line1: "1 Analytical Way",
      line2: "Suite 2",
      city: "London",
      region: "England",
      postalCode: "SW1A",
      countryCode: "GB",
    });
  });

  it("accepts a minimal address with no optional fields", () => {
    const address = parseOrderAddress({
      recipientName: "Ada",
      line1: "1 Way",
      city: "London",
      countryCode: "GB",
    });
    expect(address).toEqual({
      recipientName: "Ada",
      line1: "1 Way",
      city: "London",
      countryCode: "GB",
    });
  });

  it("reports every missing required field at once", () => {
    expectFieldErrors(() => parseOrderAddress({}), {
      recipientName: ["Recipient name is required."],
      line1: ["Address line 1 is required."],
      city: ["City is required."],
      countryCode: ["Country code is required."],
    });
  });

  it("rejects a malformed country code", () => {
    expectFieldErrors(() => parseOrderAddress({ recipientName: "Ada", line1: "1", city: "X", countryCode: "USA" }), {
      countryCode: ["Country code must be a 2-letter code, e.g. US."],
    });
  });
});

describe("parsePlaceOrderRequest", () => {
  it("parses a body with shipping only", () => {
    const request = parsePlaceOrderRequest({
      shippingAddress: { recipientName: "Ada", line1: "1 Way", city: "London", countryCode: "GB" },
    });
    expect(request.shippingAddress.countryCode).toBe("GB");
    expect(request.billingAddress).toBeUndefined();
  });

  it("parses an explicit billing address", () => {
    const request = parsePlaceOrderRequest({
      shippingAddress: { recipientName: "Ada", line1: "1 Way", city: "London", countryCode: "GB" },
      billingAddress: { recipientName: "Grace", line1: "7 Navy", city: "NYC", countryCode: "us" },
    });
    expect(request.billingAddress?.countryCode).toBe("US");
  });

  it("prefixes nested shipping field errors", () => {
    expectFieldErrors(
      () =>
        parsePlaceOrderRequest({
          shippingAddress: { recipientName: "Ada", line1: "1", city: "X", countryCode: "USA" },
        }),
      {
        "shippingAddress.countryCode": ["Country code must be a 2-letter code, e.g. US."],
      },
    );
  });

  it("prefixes nested billing field errors alongside shipping errors", () => {
    expectFieldErrors(
      () =>
        parsePlaceOrderRequest({
          shippingAddress: { recipientName: "Ada", line1: "1", city: "X", countryCode: "GB" },
          billingAddress: { recipientName: "Grace", line1: "7", city: "Y", countryCode: "USA" },
        }),
      {
        "billingAddress.countryCode": ["Country code must be a 2-letter code, e.g. US."],
      },
    );
  });

  it("drops every monetary, catalog and ownership key the client adds", () => {
    // The parser is an allowlist: it builds a fresh request from the two
    // addresses it recognises and never copies a key it did not read. That is
    // the first line of defence against a client naming its own total, currency
    // or owner, so it is worth pinning here — the order service's re-pricing is
    // the second, and a regression in either layer is silent.
    const request = parsePlaceOrderRequest({
      shippingAddress: { recipientName: "Ada", line1: "1 Way", city: "London", countryCode: "GB" },
      totalAmountCents: 1,
      subtotalAmountCents: 1,
      shippingAmountCents: 0,
      discountAmountCents: 0,
      currency: "EUR",
      customerUserId: "00000000-0000-7000-8000-00000000dead",
      userId: "00000000-0000-7000-8000-00000000dead",
      status: "completed",
      items: [{ variantId: "attacker-variant", quantity: 99, priceAmountCents: 1 }],
      lines: [{ variantId: "attacker-variant", quantity: 99, priceAmountCents: 1 }],
    });

    expect(Object.keys(request).sort()).toEqual(["shippingAddress"]);
  });

  it("rejects a missing shipping address", () => {
    expectFieldErrors(() => parsePlaceOrderRequest({}), {
      shippingAddress: ["A shipping address is required."],
    });
  });

  it("rejects a body that is not an object", () => {
    expectFieldErrors(() => parsePlaceOrderRequest("nope"), {
      body: ["Request body must be a JSON object."],
    });
  });
});

describe("parseIdempotencyKey", () => {
  it("accepts a key inside the shared bounds and returns it byte for byte", () => {
    // Returning it verbatim matters: a key the client will retry with has to
    // hash to the same stored value, so no trimming, folding or padding.
    for (const key of [
      "checkout-key-0001",
      "a".repeat(IDEMPOTENCY_KEY_LIMITS.minLength),
      "a".repeat(IDEMPOTENCY_KEY_LIMITS.maxLength),
      "A.b_c~d:e-f",
      "01955f00-0000-7000-8000-0000000000e3",
    ]) {
      expect(parseIdempotencyKey(key)).toBe(key);
    }
  });

  it("requires the header: a missing key is refused, never defaulted", () => {
    // A server-side default would differ per attempt and turn every retry into
    // a second order, so absence is an error rather than a fresh key.
    for (const missing of [undefined, ""]) {
      expectFieldErrors(() => parseIdempotencyKey(missing), {
        idempotencyKey: ["A checkout idempotency key is required."],
      });
    }
  });

  it("refuses keys outside the shared length bounds", () => {
    const tooShort = "a".repeat(IDEMPOTENCY_KEY_LIMITS.minLength - 1);
    const tooLong = "a".repeat(IDEMPOTENCY_KEY_LIMITS.maxLength + 1);
    const message = [
      `Idempotency key must be between ${IDEMPOTENCY_KEY_LIMITS.minLength} and ${IDEMPOTENCY_KEY_LIMITS.maxLength} characters.`,
    ];
    expectFieldErrors(() => parseIdempotencyKey(tooShort), { idempotencyKey: message });
    expectFieldErrors(() => parseIdempotencyKey(tooLong), { idempotencyKey: message });
  });

  it("refuses characters that are unsafe in a header, an index or a log line", () => {
    // Every one of these is either a header/log delimiter, a control character
    // or non-ASCII — the reasons the shared character set is narrow.
    const malformed = [
      "key with spaces",
      "key\nwith-newline",
      "key\rwith-cr",
      "key,other",
      "key;other",
      'key"quoted',
      "key\\backslash",
      "key\twith-tab",
      "kéy-ünicode",
      "key/with/slash",
      "key?with=query",
      "key#with-fragment",
      "key(with-parens)",
    ];
    for (const key of malformed) {
      expectFieldErrors(() => parseIdempotencyKey(key.padEnd(20, "x")), {
        idempotencyKey: ["Idempotency key may only contain letters, digits and the characters . _ ~ : -"],
      });
    }
  });

  it("refuses a header folded from several values", () => {
    // A repeated header is folded by the HTTP layer into one comma-joined
    // value, which is ambiguous rather than a key anyone chose. The comma makes
    // it fail the character set instead of silently picking the first value.
    expectFieldErrors(() => parseIdempotencyKey("first-key-0001,second-key-0001"), {
      idempotencyKey: ["Idempotency key may only contain letters, digits and the characters . _ ~ : -"],
    });
  });

  it("refuses surrounding whitespace instead of trimming it", () => {
    // Trimming would accept a key the client never sent back verbatim, and the
    // retry would then miss the stored key and place a second order.
    expectFieldErrors(() => parseIdempotencyKey(" checkout-key-0001 "), {
      idempotencyKey: ["Idempotency key may only contain letters, digits and the characters . _ ~ : -"],
    });
  });
});
