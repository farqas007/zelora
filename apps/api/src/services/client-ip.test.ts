import { describe, expect, it } from "vitest";
import {
  firstForwardedFor,
  isValidIpv4,
  isValidIpv6,
  normalizeClientIp,
} from "./client-ip";

describe("isValidIpv4", () => {
  it.each([
    ["192.0.2.1", true],
    ["0.0.0.0", true],
    ["255.255.255.255", true],
    ["256.0.0.1", false],
    ["192.0.2", false],
    ["192.0.2.1.9", false],
    ["a.b.c.d", false],
    ["192.0.2.1:8080", false],
    ["", false],
  ])("treats %s as %s", (input, expected) => {
    expect(isValidIpv4(input)).toBe(expected);
  });
});

describe("isValidIpv6", () => {
  it.each([
    ["::1", true],
    ["2001:db8::1", true],
    ["fe80::1", true],
    ["::", true],
    ["192.0.2.1", false],
    ["zzzz", false],
    ["1", false],
    ["", false],
  ])("treats %s as %s", (input, expected) => {
    expect(isValidIpv6(input)).toBe(expected);
  });
});

describe("firstForwardedFor", () => {
  it("returns the first entry from a comma-separated list", () => {
    expect(firstForwardedFor("203.0.113.5, 10.0.0.1")).toBe("203.0.113.5");
  });

  it("returns the first entry when there are more than two", () => {
    expect(firstForwardedFor("198.51.100.7, 10.0.0.1, 10.0.0.2")).toBe(
      "198.51.100.7",
    );
  });

  it("returns the single entry unchanged", () => {
    expect(firstForwardedFor("203.0.113.5")).toBe("203.0.113.5");
  });

  it("skips leading empty entries", () => {
    expect(firstForwardedFor(", , 203.0.113.5")).toBe("203.0.113.5");
  });

  it("returns undefined for an empty header", () => {
    expect(firstForwardedFor("")).toBeUndefined();
    expect(firstForwardedFor("   ")).toBeUndefined();
    expect(firstForwardedFor(", ,")).toBeUndefined();
  });

  it("returns undefined for a non-string value", () => {
    expect(firstForwardedFor(undefined)).toBeUndefined();
  });
});

describe("normalizeClientIp", () => {
  it("keeps a plain IPv4 address", () => {
    expect(normalizeClientIp("203.0.113.5")).toBe("203.0.113.5");
  });

  it("normalizes surrounding whitespace", () => {
    expect(normalizeClientIp("  203.0.113.5  ")).toBe("203.0.113.5");
  });

  it("keeps a bare IPv6 address and lowercases it", () => {
    expect(normalizeClientIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeClientIp("::1")).toBe("::1");
  });

  it("collapses IPv4-mapped IPv6 into the dotted quad", () => {
    expect(normalizeClientIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeClientIp("::FFFF:192.0.2.1")).toBe("192.0.2.1");
  });

  it("strips surrounding brackets from IPv6", () => {
    expect(normalizeClientIp("[2001:db8::1]")).toBe("2001:db8::1");
  });

  it("strips brackets and an explicit port from IPv6", () => {
    expect(normalizeClientIp("[2001:db8::1]:443")).toBe("2001:db8::1");
  });

  it("strips a clearly-framed port from an IPv4 host:port", () => {
    expect(normalizeClientIp("203.0.113.5:8080")).toBe("203.0.113.5");
  });

  it("does not mangle a bare IPv6 that happens to end in digits", () => {
    expect(normalizeClientIp("2001:db8::5")).toBe("2001:db8::5");
  });

  it("rejects malformed IPv4 octets", () => {
    expect(normalizeClientIp("256.0.0.1")).toBeUndefined();
    expect(normalizeClientIp("999.0.0.1:80")).toBeUndefined();
  });

  it("rejects non-IP strings", () => {
    expect(normalizeClientIp("example.com")).toBeUndefined();
    expect(normalizeClientIp("1.2.3.4.5")).toBeUndefined();
    expect(normalizeClientIp("2001:db8:::")).toBeUndefined();
  });

  it("rejects empty and whitespace-only values", () => {
    expect(normalizeClientIp("")).toBeUndefined();
    expect(normalizeClientIp("   ")).toBeUndefined();
  });

  it("returns undefined for a non-string value", () => {
    expect(normalizeClientIp(undefined)).toBeUndefined();
  });

  it("does not trust forwarded formatting on its own", () => {
    // A raw comma-separated list is never a single address.
    expect(normalizeClientIp("203.0.113.5, 10.0.0.1")).toBeUndefined();
  });
});