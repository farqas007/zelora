import { describe, expect, it } from "vitest";
import {
  ADMIN_BOOTSTRAP_SECRET_MIN_LENGTH,
  ADMIN_ERROR_CODES,
  AUTH_ERROR_CODES,
  CART_ERROR_CODES,
  ORDER_ADDRESS_KINDS,
  ORDER_ERROR_CODES,
  ORDER_ITEM_STATUSES,
  ORDER_STATUSES,
  PRODUCT_STATUSES,
  PRODUCT_VARIANT_STATUSES,
  SELLER_PRODUCT_ERROR_CODES,
  SELLER_PROFILE_STATUSES,
  SERVICE_NAME,
  STORE_STATUSES,
  USER_ROLES,
  USER_STATUSES,
} from "./index";

/**
 * Runtime coverage for the vocabularies `@zelora/shared` publishes.
 *
 * Error codes travel as strings, and that contract is invisible to the type
 * checker: a client receives `error.code` off the wire and looks it up by
 * value, so a code whose value drifts from its key — or two maps that both
 * claim the same string — breaks the browser silently while the types stay
 * perfectly happy. Pinning identity, uniqueness and cross-map disjointness is
 * most of what this file does.
 *
 * The status tuples get the same treatment for a different reason: they are
 * duplicated verbatim in `packages/db` (the browser cannot import the database
 * package), so each state here is a state a `CHECK` constraint there knows
 * about. `packages/db` owns the parity assertion that keeps the two copies
 * equal; what follows checks that the states the flows depend on are present.
 */

/** Every published error-code map, by the module that owns it. */
const ERROR_CODE_MAPS = {
  AUTH_ERROR_CODES,
  CART_ERROR_CODES,
  ORDER_ERROR_CODES,
  ADMIN_ERROR_CODES,
  SELLER_PRODUCT_ERROR_CODES,
} as const;

/** Every status/role vocabulary, by the field it constrains. */
const STATUS_VOCABULARIES = {
  USER_ROLES,
  USER_STATUSES,
  SELLER_PROFILE_STATUSES,
  STORE_STATUSES,
  PRODUCT_STATUSES,
  PRODUCT_VARIANT_STATUSES,
  ORDER_STATUSES,
  ORDER_ITEM_STATUSES,
  ORDER_ADDRESS_KINDS,
} as const;

describe("error codes are the strings clients switch on", () => {
  it.each(Object.entries(ERROR_CODE_MAPS))("%s maps every code to itself", (_name, codes) => {
    // The web app looks a code up by value. Identity mapping is what lets a
    // shared constant be the key, the wire value and the lookup key at once.
    for (const [key, value] of Object.entries(codes)) {
      expect(value).toBe(key);
    }
  });

  it.each(Object.entries(ERROR_CODE_MAPS))("%s publishes no duplicate wire value", (_name, codes) => {
    const values = Object.values(codes);
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(Object.entries(ERROR_CODE_MAPS))("%s is a non-empty, frozen-shaped record of plain strings", (_name, codes) => {
    expect(Object.keys(codes).length).toBeGreaterThan(0);
    for (const value of Object.values(codes)) {
      expect(typeof value).toBe("string");
      // Codes are matched exactly, so a code carrying whitespace or a stray
      // character class would never equal the string the server sent.
      expect(value).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("keeps the seller-product codes clear of the auth codes they delegate to", () => {
    // SELLER_PRODUCT_ERROR_CODES documents that transport failures "reuse the
    // auth vocabulary" (ACCOUNT_SUSPENDED, RATE_LIMITED, ...). That only holds
    // while the product map names none of them itself: a collision would make
    // one code mean two different things depending on which endpoint sent it.
    const authCodes = new Set<string>(Object.values(AUTH_ERROR_CODES));
    for (const code of Object.values(SELLER_PRODUCT_ERROR_CODES)) {
      expect(authCodes.has(code)).toBe(false);
    }
  });

  it("keeps the order codes clear of the auth codes they delegate to", () => {
    // Same contract as above, for the checkout 409 family.
    const authCodes = new Set<string>(Object.values(AUTH_ERROR_CODES));
    for (const code of Object.values(ORDER_ERROR_CODES)) {
      expect(authCodes.has(code)).toBe(false);
    }
  });

  it("keeps the cart codes clear of every other map's codes", () => {
    const elsewhere = new Set<string>([
      ...Object.values(AUTH_ERROR_CODES),
      ...Object.values(ORDER_ERROR_CODES),
      ...Object.values(SELLER_PRODUCT_ERROR_CODES),
    ]);
    for (const code of Object.values(CART_ERROR_CODES)) {
      expect(elsewhere.has(code)).toBe(false);
    }
  });

  it("leaves the activation-blocked code to auth, where the admin surface says to find it", () => {
    // ADMIN_ERROR_CODES documents that the activation path "reuses
    // SELLER_ACTIVATION_BLOCKED from AUTH_ERROR_CODES". The admin map must
    // therefore not redeclare it, or a client matching on the admin map would
    // miss the code the endpoint actually sends.
    expect(AUTH_ERROR_CODES.SELLER_ACTIVATION_BLOCKED).toBe("SELLER_ACTIVATION_BLOCKED");
    expect(ADMIN_ERROR_CODES).not.toHaveProperty("SELLER_ACTIVATION_BLOCKED");
  });

  it("refuses a bootstrap secret only at a length that is actually a secret", () => {
    // The bootstrap endpoint is the only unauthenticated path to an admin
    // account, and it is gated by a configured secret compared server-side.
    // A short minimum would let a guessable secret through that gate.
    expect(Number.isInteger(ADMIN_BOOTSTRAP_SECRET_MIN_LENGTH)).toBe(true);
    expect(ADMIN_BOOTSTRAP_SECRET_MIN_LENGTH).toBeGreaterThanOrEqual(32);
  });
});

describe("status vocabularies stay usable by both halves of the platform", () => {
  it.each(Object.entries(STATUS_VOCABULARIES))("%s is a non-empty tuple of distinct lowercase tokens", (_name, values) => {
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("keeps the states a record can be created in, without pinning which one is the default", () => {
    // The first entry of a tuple is not the database default — product_variants
    // defaults to `draft` while the seller service inserts `active` — so the
    // only claim worth pinning here is that every state a new record can land
    // in is actually in the vocabulary. The db/shared parity suite in
    // `packages/db` is what checks the defaults themselves.
    expect(USER_ROLES).toContain("customer");
    expect(USER_STATUSES).toContain("active");
    expect(SELLER_PROFILE_STATUSES).toContain("pending");
    expect(STORE_STATUSES).toContain("draft");
    expect(PRODUCT_STATUSES).toContain("draft");
    expect(PRODUCT_VARIANT_STATUSES).toContain("draft");
    expect(PRODUCT_VARIANT_STATUSES).toContain("active");
  });

  it("keeps the states that make an unpublished product invisible, and the states that unpublish it", () => {
    // products.ts states a product stays off the catalog until it is published
    // and only leaves again when archived. Both ends of that lifecycle are
    // load-bearing for the storefront's visibility filter.
    expect(PRODUCT_STATUSES).toContain("draft");
    expect(PRODUCT_STATUSES).toContain("active");
    expect(PRODUCT_STATUSES).toContain("archived");
  });

  it("keeps a store openable and closeable, and a seller reviewable", () => {
    expect(STORE_STATUSES).toContain("active");
    expect(STORE_STATUSES).toContain("closed");
    expect(SELLER_PROFILE_STATUSES).toContain("pending");
    expect(SELLER_PROFILE_STATUSES).toContain("active");
    expect(SELLER_PROFILE_STATUSES).toContain("rejected");
  });

  it("retains account suspension and deletion, which the auth error codes depend on", () => {
    // ACCOUNT_SUSPENDED and ACCOUNT_DELETED are only meaningful because these
    // two states exist; a status dropped from here is an unreachable code.
    expect(USER_STATUSES).toContain("suspended");
    expect(USER_STATUSES).toContain("deleted");
  });

  it("keeps exactly one role with admin powers, and a path into selling", () => {
    // The admin surface refuses to promote an admin to seller precisely
    // because the platform permits exactly one administrator.
    expect(USER_ROLES).toEqual(["customer", "seller", "admin"]);
    expect(USER_ROLES.filter((role) => role === "admin")).toHaveLength(1);
  });

  it("treats shipping as a kind in its own right, since billing defaults to it", () => {
    // PlaceOrderRequest makes shippingAddress required and billingAddress
    // optional, defaulting to the shipping snapshot.
    expect(ORDER_ADDRESS_KINDS).toContain("shipping");
    expect(ORDER_ADDRESS_KINDS).toContain("billing");
  });

  it("keeps an order and an order line cancellable and refundable on both sides", () => {
    // ORDER_ERROR_CODES reports failures against a line and against the order,
    // so both vocabularies need the same lifecycle vocabulary to express them.
    for (const status of ["cancelled", "refunded"] as const) {
      expect(ORDER_STATUSES).toContain(status);
      expect(ORDER_ITEM_STATUSES).toContain(status);
    }
  });

  it("names the health service the API actually reports", () => {
    // HealthResponse.status is the literal "ok" and its service field is typed
    // from this constant, so the two cannot disagree by accident — but the
    // constant itself is what a deploy probe and a dashboard match on.
    expect(SERVICE_NAME).toBe("zelora-api");
  });
});
