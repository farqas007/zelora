import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_FINGERPRINT_HEX_LENGTH, type PlaceOrderRequest } from "@zelora/shared";
import { canonicalizeCheckoutRequest, fingerprintCheckoutRequest } from "./order-fingerprint";

/**
 * Unit tests for the checkout request fingerprint.
 *
 * The fingerprint is what decides whether a repeat of an idempotency key is a
 * retry (answer with the original order) or a reuse of the key for something
 * else (refuse), so its stability and its scope are the contract under test.
 */

const CUSTOMER = "00000000-0000-7000-8000-0000000000a1";
const OTHER_CUSTOMER = "00000000-0000-7000-8000-0000000000a2";

const SHIPPING: PlaceOrderRequest["shippingAddress"] = {
  recipientName: "Ada Lovelace",
  phone: "+44 20 7946 0958",
  line1: "1 Analytical Engine Parade",
  line2: "Flat 3",
  city: "London",
  region: "Greater London",
  postalCode: "SW1A 1AA",
  countryCode: "GB",
};

function request(overrides: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest {
  return { shippingAddress: { ...SHIPPING }, ...overrides };
}

/** The same address with one optional field left out entirely. */
function addressWithout(field: "line2" | "region" | "postalCode"): PlaceOrderRequest["shippingAddress"] {
  const address: PlaceOrderRequest["shippingAddress"] = { ...SHIPPING };
  delete address[field];
  return address;
}

describe("canonicalizeCheckoutRequest", () => {
  it("is stable across calls", () => {
    expect(canonicalizeCheckoutRequest(CUSTOMER, request())).toBe(
      canonicalizeCheckoutRequest(CUSTOMER, request()),
    );
  });

  it("does not depend on the order the fields were written in", () => {
    // Same values, properties assembled in a different order: still the same
    // request. This is why addresses are encoded as positional arrays.
    expect(canonicalizeCheckoutRequest(CUSTOMER, request())).toBe(
      canonicalizeCheckoutRequest(CUSTOMER, {
        shippingAddress: {
          countryCode: "GB",
          postalCode: SHIPPING.postalCode,
          region: SHIPPING.region,
          line2: SHIPPING.line2,
          city: SHIPPING.city,
          line1: SHIPPING.line1,
          phone: SHIPPING.phone,
          recipientName: SHIPPING.recipientName,
        },
      }),
    );
  });

  it("encodes absent optional address fields as null, not as a missing key", () => {
    // Otherwise an address with and the same address without an optional field
    // could produce encodings that differ only in length, which is exactly the
    // kind of near-miss a digest comparison must not depend on.
    const bare: PlaceOrderRequest["shippingAddress"] = {
      recipientName: "Ada",
      line1: "1 Way",
      city: "London",
      countryCode: "GB",
    };
    expect(canonicalizeCheckoutRequest(CUSTOMER, { shippingAddress: bare })).toBe(
      JSON.stringify([
        "zelora.checkout.v1",
        CUSTOMER,
        ["Ada", null, "1 Way", null, "London", null, null, "GB"],
        ["Ada", null, "1 Way", null, "London", null, null, "GB"],
      ]),
    );
  });

  it("treats an omitted billing address as the shipping address", () => {
    // The order stores billing = shipping when it is omitted, so both spellings
    // produce the same order and must produce the same fingerprint: a shopper
    // who adds the billing form back on retry must not be told their key changed.
    expect(canonicalizeCheckoutRequest(CUSTOMER, request())).toBe(
      canonicalizeCheckoutRequest(CUSTOMER, request({ billingAddress: { ...SHIPPING } })),
    );
  });

  it("separates the two addresses so one cannot be confused with the other", () => {
    expect(canonicalizeCheckoutRequest(CUSTOMER, request())).not.toBe(
      canonicalizeCheckoutRequest(CUSTOMER, request({ billingAddress: { ...SHIPPING, city: "Cambridge" } })),
    );
  });
});

describe("fingerprintCheckoutRequest", () => {
  it("is a hex SHA-256 of the canonical form", async () => {
    const fingerprint = await fingerprintCheckoutRequest(CUSTOMER, request());
    expect(fingerprint).toMatch(/^[0-9a-f]+$/);
    expect(fingerprint).toHaveLength(IDEMPOTENCY_FINGERPRINT_HEX_LENGTH);

    const expected = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalizeCheckoutRequest(CUSTOMER, request())),
    );
    expect(fingerprint).toBe(
      [...new Uint8Array(expected)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  });

  it("is stable across retries and independent of the key", async () => {
    const first = await fingerprintCheckoutRequest(CUSTOMER, request());
    const second = await fingerprintCheckoutRequest(CUSTOMER, request());
    expect(second).toBe(first);
  });

  it("changes when any address field changes", async () => {
    const base = await fingerprintCheckoutRequest(CUSTOMER, request());
    const variants: PlaceOrderRequest[] = [
      request({ shippingAddress: { ...SHIPPING, line1: "2 Other Street" } }),
      request({ shippingAddress: { ...SHIPPING, city: "Cambridge" } }),
      request({ shippingAddress: { ...SHIPPING, countryCode: "US" } }),
      request({ shippingAddress: { ...SHIPPING, recipientName: "Grace Hopper" } }),
      request({ shippingAddress: { ...SHIPPING, phone: "+1 555 0100" } }),
      request({ shippingAddress: addressWithout("line2") }),
      request({ shippingAddress: addressWithout("region") }),
      request({ shippingAddress: addressWithout("postalCode") }),
      request({ billingAddress: { ...SHIPPING, city: "NYC" } }),
    ];
    for (const variant of variants) {
      expect(await fingerprintCheckoutRequest(CUSTOMER, variant)).not.toBe(base);
    }
  });

  it("cannot move between customers", async () => {
    // The lookup is already scoped to the caller, but a fingerprint that
    // collided across accounts would turn that scoping into the only thing
    // standing between two shoppers.
    expect(await fingerprintCheckoutRequest(OTHER_CUSTOMER, request())).not.toBe(
      await fingerprintCheckoutRequest(CUSTOMER, request()),
    );
  });

  it("does not let a value escape into an adjacent field", async () => {
    // JSON encoding, not a delimiter join: otherwise moving a comma from one
    // field into the next would leave the canonical form unchanged.
    const withComma = request({ shippingAddress: { ...SHIPPING, city: "London, England" } });
    const splitAcrossFields = request({
      shippingAddress: { ...SHIPPING, city: "London", region: "England" },
    });
    expect(await fingerprintCheckoutRequest(CUSTOMER, withComma)).not.toBe(
      await fingerprintCheckoutRequest(CUSTOMER, splitAcrossFields),
    );
  });
});