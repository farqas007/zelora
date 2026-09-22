import type { Context } from "hono";

/**
 * Client IP resolution helpers and the resolver seam between the HTTP layer
 * and the rate limiter.
 *
 * The {@link ClientIpResolver} is injected at the composition boundary so the
 * runtime-specific source of truth (TCP peer via `@hono/node-server` today,
 * the Cloudflare Workers adapter later) never leaks into edge-compatible
 * middleware. Forwarded headers themselves are never trusted here: a caller
 * has to explicitly opt in (e.g. from configuration) before {@link firstForwardedFor}
 * is used, and even then the value is normalized rather than echoed blindly.
 */

export interface ClientIpResolver {
  resolve(c: Context): string | undefined;
}

/** Return true when `value` is a well-formed dotted-quad IPv4 address. */
export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

/** Return true when `value` is a plausible bare IPv6 address (lowercased). */
export function isValidIpv6(value: string): boolean {
  return (
    value.length >= 2 &&
    value.includes(":") &&
    /^[0-9a-f:]+$/.test(value) &&
    !/:{3,}/.test(value)
  );
}

/**
 * Return the first non-empty entry of an `X-Forwarded-For` style comma-list,
 * trimmed. An empty/malformed header yields `undefined`. This is a pure helper:
 * it reads no headers itself and must only be wired up where the deployment
 * explicitly trusts the proxy that rewrote the header.
 */
export function firstForwardedFor(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  for (const part of value.split(",")) {
    const candidate = part.trim();
    if (candidate !== "") {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Normalize a raw address string into a canonical IP string or `undefined`.
 *
 * Handles surrounding whitespace, bracketed IPv6 (with or without a port),
 * IPv4 host:port, and the IPv4-mapped IPv6 form `::ffff:192.0.2.1`, which
 * both Node and some proxies report for the same client. Malformed or empty
 * input returns `undefined`.
 */
export function normalizeClientIp(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  let candidate = value.trim();
  if (candidate === "") {
    return undefined;
  }

  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(candidate);
  if (bracketed !== null) {
    candidate = bracketed[1]!;
  } else {
    const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(candidate);
    if (ipv4WithPort !== null) {
      candidate = ipv4WithPort[1]!;
    }
  }

  candidate = candidate.trim();

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(candidate);
  if (mapped !== null) {
    const dotted = mapped[1]!;
    return isValidIpv4(dotted) ? dotted : undefined;
  }

  if (isValidIpv4(candidate)) {
    return candidate;
  }

  const lowered = candidate.toLowerCase();
  if (isValidIpv6(lowered)) {
    return lowered;
  }

  return undefined;
}