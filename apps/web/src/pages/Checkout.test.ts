import { describe, expect, it } from "vitest";
import type { OrderAddressRequest } from "@zelora/shared";
import { toAddressRequest, type AddressForm } from "./Checkout";

function form(overrides: Partial<AddressForm> = {}): AddressForm {
  return {
    recipientName: "",
    phone: "",
    line1: "",
    line2: "",
    city: "",
    region: "",
    postalCode: "",
    countryCode: "",
    ...overrides,
  };
}

describe("toAddressRequest", () => {
  it("trims every value and uppercases the country code", () => {
    const request = toAddressRequest(
      form({
        recipientName: "  Ada Lovelace ",
        line1: " 1 Analytical Engine Parade ",
        city: " London ",
        countryCode: "gb",
      }),
    );

    expect(request).toEqual({
      recipientName: "Ada Lovelace",
      line1: "1 Analytical Engine Parade",
      city: "London",
      countryCode: "GB",
    });
  });

  it("omits empty optional fields so the wire body stays clean", () => {
    const request = toAddressRequest(
      form({
        recipientName: "Ada Lovelace",
        phone: "   ",
        line1: "1 Analytical Engine Parade",
        line2: "",
        city: "London",
        region: "",
        postalCode: "",
        countryCode: "GB",
      }),
    );

    expect(request).toEqual({
      recipientName: "Ada Lovelace",
      line1: "1 Analytical Engine Parade",
      city: "London",
      countryCode: "GB",
    });
  });

  it("lifts filled optional fields onto the request", () => {
    const request = toAddressRequest(
      form({
        recipientName: "Ada Lovelace",
        phone: "+44 20 7946 0958",
        line1: "1 Analytical Engine Parade",
        line2: "Floor 2",
        city: "London",
        region: "Greater London",
        postalCode: "SW1A 1AA",
        countryCode: "GB",
      }),
    );

    const expected: OrderAddressRequest = {
      recipientName: "Ada Lovelace",
      phone: "+44 20 7946 0958",
      line1: "1 Analytical Engine Parade",
      line2: "Floor 2",
      city: "London",
      region: "Greater London",
      postalCode: "SW1A 1AA",
      countryCode: "GB",
    };
    expect(request).toEqual(expected);
  });
});