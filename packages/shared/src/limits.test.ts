import { describe, expect, it } from "vitest";
import {
  AUTH_LIMITS,
  CART_ITEM_QUANTITY_LIMITS,
  CHECKOUT_LIMITS,
  COUNTRY_CODE_PATTERN,
  CURRENCY_PATTERN,
  DEFAULT_PRODUCT_CURRENCY,
  EMAIL_PATTERN,
  INVENTORY_LIMITS,
  ORDER_PAGE_LIMITS,
  PENDING_SELLERS_PAGE_LIMITS,
  PRODUCT_IMAGE_CONTENT_TYPES,
  PRODUCT_IMAGE_LIMITS,
  PRODUCT_IMAGE_UPLOAD_LIMITS,
  PRODUCT_LIMITS,
  PRODUCT_SLUG_PATTERN,
  PRODUCT_VARIANT_LIMITS,
  SELLER_PRODUCT_PAGE_LIMITS,
  SKU_PATTERN,
  SLUG_PATTERN,
} from "./index";

/**
 * Runtime coverage for the limits and patterns in `@zelora/shared`.
 *
 * These numbers are not decorative: the API enforces them and the web app
 * mirrors them, and several of them are *derived from one another* or from a
 * pattern rather than written out by hand. Those derived cases are what this
 * file is for — the modules' doc comments state the intent, but until now
 * nothing checked that the numbers still honoured it, so a limit could drift
 * apart from the limit it is defined against and both the API and the browser
 * would keep agreeing on the wrong value.
 */

/** Every `min`/`max` pair a `*_LIMITS` object publishes, as one bound pair. */
const BOUNDED_LIMITS: ReadonlyArray<readonly [string, { min: number; max: number }]> = [
  ["AUTH_LIMITS.email", { min: AUTH_LIMITS.emailMinLength, max: AUTH_LIMITS.emailMaxLength }],
  ["AUTH_LIMITS.password", { min: AUTH_LIMITS.passwordMinLength, max: AUTH_LIMITS.passwordMaxLength }],
  ["AUTH_LIMITS.name", { min: AUTH_LIMITS.nameMinLength, max: AUTH_LIMITS.nameMaxLength }],
  ["AUTH_LIMITS.slug", { min: AUTH_LIMITS.slugMinLength, max: AUTH_LIMITS.slugMaxLength }],
  [
    "AUTH_LIMITS.displayName",
    { min: AUTH_LIMITS.displayNameMinLength, max: AUTH_LIMITS.displayNameMaxLength },
  ],
  [
    "AUTH_LIMITS.storeName",
    { min: AUTH_LIMITS.storeNameMinLength, max: AUTH_LIMITS.storeNameMaxLength },
  ],
  ["PRODUCT_LIMITS.name", { min: PRODUCT_LIMITS.nameMinLength, max: PRODUCT_LIMITS.nameMaxLength }],
  ["PRODUCT_LIMITS.slug", { min: PRODUCT_LIMITS.slugMinLength, max: PRODUCT_LIMITS.slugMaxLength }],
  [
    "PRODUCT_VARIANT_LIMITS.name",
    { min: PRODUCT_VARIANT_LIMITS.nameMinLength, max: PRODUCT_VARIANT_LIMITS.nameMaxLength },
  ],
  [
    "PRODUCT_VARIANT_LIMITS.sku",
    { min: PRODUCT_VARIANT_LIMITS.skuMinLength, max: PRODUCT_VARIANT_LIMITS.skuMaxLength },
  ],
  [
    "PRODUCT_VARIANT_LIMITS.priceAmountCents",
    {
      min: PRODUCT_VARIANT_LIMITS.priceAmountCentsMin,
      max: PRODUCT_VARIANT_LIMITS.priceAmountCentsMax,
    },
  ],
  [
    "PRODUCT_VARIANT_LIMITS.compareAtAmountCents",
    {
      min: PRODUCT_VARIANT_LIMITS.compareAtAmountCentsMin,
      max: PRODUCT_VARIANT_LIMITS.compareAtAmountCentsMax,
    },
  ],
  [
    "CHECKOUT_LIMITS.recipientName",
    { min: CHECKOUT_LIMITS.recipientNameMinLength, max: CHECKOUT_LIMITS.recipientNameMaxLength },
  ],
  [
    "CHECKOUT_LIMITS.line1",
    { min: CHECKOUT_LIMITS.line1MinLength, max: CHECKOUT_LIMITS.line1MaxLength },
  ],
  ["CHECKOUT_LIMITS.city", { min: CHECKOUT_LIMITS.cityMinLength, max: CHECKOUT_LIMITS.cityMaxLength }],
];

/** The three published page-size windows, all keyset-paginated by the same rule. */
const PAGE_LIMITS = {
  SELLER_PRODUCT_PAGE_LIMITS,
  PENDING_SELLERS_PAGE_LIMITS,
  ORDER_PAGE_LIMITS,
} as const;

/** The one framing allowance the request-body guard is allowed to add. */
const FRAMING_HEADROOM =
  PRODUCT_IMAGE_UPLOAD_LIMITS.maxBodyBytes -
  PRODUCT_IMAGE_LIMITS.maxFilesPerRequest * PRODUCT_IMAGE_LIMITS.maxBytesPerFile;

/** A run of `length` accepted characters, for probing a pattern's own bounds. */
function ofLength(length: number, char = "a"): string {
  return char.repeat(length);
}

describe("length limits are internally consistent", () => {
  it.each(BOUNDED_LIMITS)("%s brackets its own bounds", (_name, { min, max }) => {
    expect(Number.isInteger(min)).toBe(true);
    expect(Number.isInteger(max)).toBe(true);
    expect(min).toBeGreaterThan(0);
    expect(min).toBeLessThanOrEqual(max);
  });

  it.each(Object.entries(PAGE_LIMITS))("%s is a window its own default sits inside", (_name, limits) => {
    expect(limits.min).toBe(1);
    expect(Number.isInteger(limits.default)).toBe(true);
    expect(limits.default).toBeGreaterThanOrEqual(limits.min);
    expect(limits.default).toBeLessThanOrEqual(limits.max);
  });

  it("gives every paginated list the same window, so one cursor rule fits all of them", () => {
    expect(SELLER_PRODUCT_PAGE_LIMITS).toEqual(PENDING_SELLERS_PAGE_LIMITS);
    expect(PENDING_SELLERS_PAGE_LIMITS).toEqual(ORDER_PAGE_LIMITS);
  });

  it("never lets a cart line ask for more units than inventory can hold", () => {
    expect(CART_ITEM_QUANTITY_LIMITS.min).toBe(1);
    expect(CART_ITEM_QUANTITY_LIMITS.max).toBeGreaterThanOrEqual(CART_ITEM_QUANTITY_LIMITS.min);
    expect(CART_ITEM_QUANTITY_LIMITS.max).toBeLessThanOrEqual(INVENTORY_LIMITS.quantityMax);
    // Stock is allowed to reach zero, so a seller can always zero out a variant.
    expect(INVENTORY_LIMITS.quantityMin).toBe(0);
  });

  it("bounds the email by the RFC 5321 path maximum, not an arbitrary round number", () => {
    // 254 is the hard ceiling for a forward-path address. A larger declared
    // maximum would promise to accept addresses SMTP cannot carry.
    expect(AUTH_LIMITS.emailMaxLength).toBe(254);
  });

  it("keeps a product name within its own description budget", () => {
    expect(PRODUCT_LIMITS.nameMaxLength).toBeLessThanOrEqual(PRODUCT_LIMITS.descriptionMaxLength);
  });
});

describe("the product-image byte limits stay derivable", () => {
  it("caps the request body at the largest legal batch, never less", () => {
    // maxBodyBytes is documented as "the largest legal batch plus framing". If
    // it ever fell to or below the payload alone, a fully legal upload would be
    // rejected by the transport guard before validation ever saw it.
    expect(FRAMING_HEADROOM).toBeGreaterThan(0);
  });

  it("leaves framing headroom too small to smuggle an extra image past the byte checks", () => {
    // The allowance covers multipart boundaries and per-part headers only, so
    // it must stay under one whole image: a body just over the guard must not
    // be large enough to carry a ninth file that validation would reject.
    expect(FRAMING_HEADROOM).toBeLessThan(PRODUCT_IMAGE_LIMITS.maxBytesPerFile);
  });

  it("keeps the enforced per-file cap below the hard per-object ceiling", () => {
    // maxStoredObjectBytes is D1's BLOB limit, never the enforced cap. If the
    // enforced cap ever reached it, a write could be accepted by the API and
    // then rejected by the database — the failure the note above it warns
    // about, and the reason that note is stated here at all.
    expect(PRODUCT_IMAGE_LIMITS.maxBytesPerFile).toBeLessThan(PRODUCT_IMAGE_LIMITS.maxStoredObjectBytes);
  });

  it("accepts a product's whole gallery in one request and no more", () => {
    // A seller may hold maxPerProduct images and may upload at most
    // maxFilesPerRequest at a time, so the two caps have to meet for a gallery
    // to be fillable in a single pass.
    expect(PRODUCT_IMAGE_LIMITS.maxPerProduct).toBe(PRODUCT_IMAGE_LIMITS.maxFilesPerRequest);
  });

  it("leaves the alt-text cap inside the framing allowance, since alt text rides in the body", () => {
    expect(PRODUCT_IMAGE_LIMITS.altTextMaxLength).toBeGreaterThan(0);
    expect(PRODUCT_IMAGE_LIMITS.altTextMaxLength).toBeLessThan(FRAMING_HEADROOM);
  });

  it("keeps every count and byte cap a positive integer", () => {
    const caps = {
      maxPerProduct: PRODUCT_IMAGE_LIMITS.maxPerProduct,
      maxFilesPerRequest: PRODUCT_IMAGE_LIMITS.maxFilesPerRequest,
      maxBytesPerFile: PRODUCT_IMAGE_LIMITS.maxBytesPerFile,
      maxStoredObjectBytes: PRODUCT_IMAGE_LIMITS.maxStoredObjectBytes,
      altTextMaxLength: PRODUCT_IMAGE_LIMITS.altTextMaxLength,
      urlMaxLength: PRODUCT_IMAGE_LIMITS.urlMaxLength,
      maxBodyBytes: PRODUCT_IMAGE_UPLOAD_LIMITS.maxBodyBytes,
    };
    for (const [name, value] of Object.entries(caps)) {
      expect(Number.isInteger(value), `${name} must be an integer`).toBe(true);
      expect(value, `${name} must be positive`).toBeGreaterThan(0);
    }
  });
});

describe("validation patterns behave as their comments claim", () => {
  it("accepts ordinary addresses and rejects the malformed ones", () => {
    for (const valid of ["a@b.co", "ada.lovelace@example.test", "a+tag@sub.example.museum"]) {
      expect(EMAIL_PATTERN.test(valid)).toBe(true);
    }
    for (const invalid of ["", "ada", "ada@", "@example.test", "ada@example", "a@b c.test"]) {
      expect(EMAIL_PATTERN.test(invalid)).toBe(false);
    }
  });

  it("leaves email length to the declared limits, because the pattern cannot enforce it", () => {
    // EMAIL_PATTERN is a "simple structural check" by its own description, so
    // the length bounds are the only thing keeping a 1000-character address
    // out. Both halves of the rule have to be applied for the limit to mean
    // anything, and that is exactly why the bound is published here.
    expect(EMAIL_PATTERN.test(`${ofLength(AUTH_LIMITS.emailMaxLength * 4)}@example.test`)).toBe(true);
  });

  it("keeps slugs lowercase, dash-separated and free of empty segments", () => {
    for (const valid of ["abc", "my-store", "shop-2", "a-b-c"]) {
      expect(SLUG_PATTERN.test(valid)).toBe(true);
    }
    for (const invalid of ["", "A", "My-Store", "-shop", "shop-", "shop--2", "shop_2", "shop 2", "sh.op"]) {
      expect(SLUG_PATTERN.test(invalid)).toBe(false);
    }
  });

  it("shares one slug pattern, and therefore one set of bounds, between every slug field", () => {
    // PRODUCT_SLUG_PATTERN is documented as "shared with seller profiles and
    // stores" and is literally SLUG_PATTERN, so seller/store slugs and product
    // slugs are validated by a single rule. They therefore have to quote a
    // single set of bounds too, or the two forms would disagree about how long
    // a slug may be.
    expect(PRODUCT_SLUG_PATTERN.source).toBe(SLUG_PATTERN.source);
    expect(PRODUCT_LIMITS.slugMinLength).toBe(AUTH_LIMITS.slugMinLength);
    expect(PRODUCT_LIMITS.slugMaxLength).toBe(AUTH_LIMITS.slugMaxLength);
  });

  it("binds the SKU pattern's own length ceiling to the declared SKU limit", () => {
    // SKU_PATTERN hard-codes {0,63}, so it is a real upper bound rather than a
    // shape check. If PRODUCT_VARIANT_LIMITS.skuMaxLength were raised, the API
    // would accept a longer SKU and this pattern would then reject it — the two
    // are one contract expressed twice.
    expect(SKU_PATTERN.test(ofLength(PRODUCT_VARIANT_LIMITS.skuMaxLength))).toBe(true);
    expect(SKU_PATTERN.test(ofLength(PRODUCT_VARIANT_LIMITS.skuMaxLength + 1))).toBe(false);
  });

  it("starts a SKU with an alphanumeric and allows only . _ - afterwards", () => {
    for (const valid of ["A", "9", "abc", "AB-12", "a.b", "a_b", "a-b.c_d"]) {
      expect(SKU_PATTERN.test(valid)).toBe(true);
    }
    for (const invalid of ["", "-abc", ".abc", "_abc", "a b", "a/b", "a#b"]) {
      expect(SKU_PATTERN.test(invalid)).toBe(false);
    }
  });

  it("matches money in a three-letter uppercase currency code", () => {
    for (const valid of ["USD", "EUR", "GBP"]) {
      expect(CURRENCY_PATTERN.test(valid)).toBe(true);
    }
    for (const invalid of ["", "usd", "US", "USDD", "US1", " US"]) {
      expect(CURRENCY_PATTERN.test(invalid)).toBe(false);
    }
  });

  it("defaults to a currency its own money pattern accepts", () => {
    // An invalid default would make every variant created without an explicit
    // currency fail a check the client could not have known about.
    expect(CURRENCY_PATTERN.test(DEFAULT_PRODUCT_CURRENCY)).toBe(true);
  });

  it("matches a two-letter uppercase country code", () => {
    for (const valid of ["US", "GB", "DE"]) {
      expect(COUNTRY_CODE_PATTERN.test(valid)).toBe(true);
    }
    for (const invalid of ["", "U", "USA", "us", "U1", " U"]) {
      expect(COUNTRY_CODE_PATTERN.test(invalid)).toBe(false);
    }
  });
});

describe("the closed product-image content-type list stays closed", () => {
  it("holds exactly the four verified formats the API sniffs for", () => {
    expect([...PRODUCT_IMAGE_CONTENT_TYPES]).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
    ]);
  });

  it("names no type twice and admits no client-declared wildcard", () => {
    const seen = new Set(PRODUCT_IMAGE_CONTENT_TYPES);
    expect(seen.size).toBe(PRODUCT_IMAGE_CONTENT_TYPES.length);
    for (const contentType of PRODUCT_IMAGE_CONTENT_TYPES) {
      // A storage key's extension is derived from this string, so a wildcard or
      // a parameter-laden type would leak into a stored object's name.
      expect(contentType).not.toContain("*");
      expect(contentType.startsWith("image/")).toBe(true);
      expect(contentType.slice("image/".length)).toMatch(/^[a-z0-9]+$/);
    }
  });
});
