import { beforeEach, describe, expect, it } from "vitest";
import { PBKDF2PasswordHasher, type AppConfig } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { AuditLogRepository } from "@zelora/db/audit";
import type { CartRepository } from "@zelora/db/cart";
import type { OrderRepository } from "@zelora/db/orders";
import type { CatalogRepository } from "@zelora/db/catalog";
import type { ProductRepository } from "@zelora/db/products";
import type { SellerRepository } from "@zelora/db/seller";
import type { UserRepository } from "@zelora/db/users";
import type { ApiFailure } from "@zelora/shared";
import { createApp } from "../app";
import type { Clock } from "../services/clock";
import type { MediaObjectInput, MediaObjectOutput, MediaStorage } from "../services/media/storage";

/**
 * Route tests for the public media read path, composed through the real app so
 * the `/media` mount, the error boundary and the security headers are all
 * exercised, with the storage port faked at the composition boundary.
 *
 * The route's whole job is to turn a key that arrived from a URL into bytes, or
 * into a refusal indistinguishable from "nothing is stored here". These tests
 * pin the exact bytes, the served content type, the cacheability claim, and the
 * whole class of keys it must refuse without ever reaching the driver.
 */

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3001,
  appVersion: "0.1.0",
  corsOrigin: "http://localhost:5173",
  sessionCookieName: "zelora_session",
  sessionTtlSeconds: 2_592_000,
  sessionCookieSecure: false,
  pbkdf2Iterations: 1_000,
  rateLimitEnabled: true,
  rateLimitTrustProxy: false,
  rateLimitLoginIpMax: 20,
  rateLimitLoginIpWindowSeconds: 900,
  rateLimitLoginEmailMax: 10,
  rateLimitLoginEmailWindowSeconds: 900,
  rateLimitRegisterIpMax: 10,
  rateLimitRegisterIpWindowSeconds: 3_600,
  rateLimitSellerOnboardingIpMax: 10,
  rateLimitSellerOnboardingIpWindowSeconds: 3_600,
  rateLimitProductCreateIpMax: 100,
  rateLimitProductCreateIpWindowSeconds: 3_600,
  rateLimitOrderPlaceIpMax: 20,
  rateLimitOrderPlaceIpWindowSeconds: 3_600,
  sessionLastUsedThrottleSeconds: 300,
  sessionPurgeIntervalSeconds: 3_600,
  adminBootstrapSecret: null,
  mediaPublicBaseUrl: "https://api.test/media",
  mediaLocalRoot: ".data/media",
};

const PRODUCT_ID = "01955f00-0000-7000-8000-0000000000a1";
const DIGEST = "a".repeat(64);

/** In-memory storage that records reads, so "refused before the driver" is observable. */
class FakeMediaStorage implements MediaStorage {
  readonly getCalls: string[] = [];
  readonly putCalls: string[] = [];
  readonly objects = new Map<string, MediaObjectOutput>();

  /** Fail `get` the way an unreachable backend would. */
  failGet: boolean = false;

  async put(key: string, _object: MediaObjectInput): Promise<void> {
    this.putCalls.push(key);
  }

  async get(key: string): Promise<MediaObjectOutput | null> {
    this.getCalls.push(key);
    if (this.failGet) {
      throw new Error("media storage is unavailable");
    }
    return this.objects.get(key) ?? null;
  }

  async delete(): Promise<void> {
    throw new Error("unexpected delete call");
  }

  publicUrl(key: string): string {
    return `https://api.test/media/${key}`;
  }
}

/**
 * A repository stand-in that fails loudly if any of its methods is ever called.
 * Built through a proxy so it stays correct as those ports grow: naming the
 * methods here by hand would let this file drift out of sync with them silently,
 * and a media test that quietly depended on a real repository is not a media test.
 */
function inertRepository<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, property) => () => {
      throw new Error(`unexpected ${name}.${String(property)} call`);
    },
  });
}

let mediaStorage: FakeMediaStorage;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  mediaStorage = new FakeMediaStorage();
  app = createApp({
    config,
    userRepository: inertRepository<UserRepository>("userRepository"),
    sessionRepository: inertRepository<AuthSessionRepository>("sessionRepository"),
    sellerRepository: inertRepository<SellerRepository>("sellerRepository"),
    catalogRepository: inertRepository<CatalogRepository>("catalogRepository"),
    productRepository: inertRepository<ProductRepository>("productRepository"),
    cartRepository: inertRepository<CartRepository>("cartRepository"),
    orderRepository: inertRepository<OrderRepository>("orderRepository"),
    auditLogRepository: inertRepository<AuditLogRepository>("auditLogRepository"),
    passwordHasher: new PBKDF2PasswordHasher(config.pbkdf2Iterations),
    clock: { now: () => new Date("2026-06-01T00:00:00.000Z") } satisfies Clock,
    mediaStorage,
  });
});

/** Store an object under a well-formed key, returning the key. */
function seedObject(
  bytes: number[],
  contentType: string | null,
  productId = PRODUCT_ID,
  digest = DIGEST,
  extension = "png",
): string {
  const key = `products/${productId}/${digest}.${extension}`;
  mediaStorage.objects.set(key, {
    bytes: new Uint8Array(bytes).buffer as ArrayBuffer,
    contentType,
  });
  return key;
}

describe("GET /media/*", () => {
  it("serves the exact stored bytes with the stored content type", async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03];
    const key = seedObject(png, "image/png");

    const response = await app.request(`/media/${key}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    // Byte-for-byte, not merely "an image": the digest in the key is a claim
    // about these exact bytes, and a truncating or re-encoding driver would
    // break it.
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(png);
  });

  it("needs no session, no CSRF token and no seller role", async () => {
    const key = seedObject([0xff, 0xd8, 0xff, 0xe0], "image/jpeg", PRODUCT_ID, "b".repeat(64), "jpg");

    const anonymous = await app.request(`/media/${key}`);
    expect(anonymous.status).toBe(200);

    // A stale cookie must not change the answer either: this path is anonymous
    // by construction, not "anonymous until someone logs in".
    const withCookie = await app.request(`/media/${key}`, {
      headers: { Cookie: "zelora_session=not-a-real-session" },
    });
    expect(withCookie.status).toBe(200);
  });

  it("marks content immutable and one-year cacheable", async () => {
    const key = seedObject([0x89, 0x50], "image/png");

    const response = await app.request(`/media/${key}`);

    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("falls back to the key's own extension when the driver stored no type", async () => {
    // The filesystem driver records bare bytes, so `null` is a real case there.
    // The extension is not client input: the key builder chose it from the
    // sniffed content type of these bytes.
    for (const [extension, contentType] of [
      ["png", "image/png"],
      ["jpg", "image/jpeg"],
      ["webp", "image/webp"],
      ["avif", "image/avif"],
    ] as const) {
      mediaStorage.objects.clear();
      const key = seedObject([0x01, 0x02], null, PRODUCT_ID, "c".repeat(64), extension);

      const response = await app.request(`/media/${key}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
    }
  });

  it("serves a well-formed key whose product has no product row", async () => {
    // The read path is key-addressed, not product-addressed: a product that has
    // since been deleted must not orphan the bytes every catalog page still
    // references, and nothing here joins `products`.
    const key = seedObject([0x89, 0x50], "image/png");
    expect(mediaStorage.getCalls).toHaveLength(0);

    const response = await app.request(`/media/${key}`);

    expect(response.status).toBe(200);
    expect(mediaStorage.getCalls).toEqual([key]);
  });

  it("404s a well-formed key with nothing stored under it", async () => {
    const response = await app.request(`/media/products/${PRODUCT_ID}/${DIGEST}.png`);

    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiFailure;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("refuses every key it could not have issued, without reaching the driver", async () => {
    const refused = [
      // Traversal, in every encoding a URL can carry it in.
      "products/../../etc/passwd.png",
      "products/%2e%2e%2f%2e%2e%2fetc%2fpasswd.png",
      `products/${PRODUCT_ID}/../../../../etc/passwd.png`,
      `products/${PRODUCT_ID}/${DIGEST}.png/../../secret`,
      // Wrong shape: missing segments, extra segments, a bare filename.
      `${DIGEST}.png`,
      `products/${DIGEST}.png`,
      `products/${PRODUCT_ID}`,
      `products/${PRODUCT_ID}/${DIGEST}.png/extra`,
      // Wrong product id: a valid-looking but non-UUIDv7 value, and an empty
      // segment that would otherwise read as "current directory".
      `products/not-a-uuid/${DIGEST}.png`,
      `products//${DIGEST}.png`,
      // Wrong digest: too short, too long, and not lowercase hex.
      `products/${PRODUCT_ID}/abc.png`,
      `products/${PRODUCT_ID}/${"a".repeat(63)}.png`,
      `products/${PRODUCT_ID}/${"a".repeat(65)}.png`,
      `products/${PRODUCT_ID}/${"A".repeat(64)}.png`,
      `products/${PRODUCT_ID}/${"g".repeat(64)}.png`,
      // An extension the platform never issues — a client-chosen one, which
      // would let a caller serve arbitrary bytes under an image type.
      `products/${PRODUCT_ID}/${DIGEST}.svg`,
      `products/${PRODUCT_ID}/${DIGEST}.html`,
      `products/${PRODUCT_ID}/${DIGEST}`,
      // A separator inside the filename half, so the digest is not all hex.
      `products/${PRODUCT_ID}/${DIGEST}.png.png`,
      // A prefix other than the media namespace, which could otherwise address
      // an unrelated object in the same store.
      `admin/${PRODUCT_ID}/${DIGEST}.png`,
      `${PRODUCT_ID}/${DIGEST}.png`,
      // Windows separators and a NUL, both of which a driver may treat
      // differently from a POSIX path.
      `products\\${PRODUCT_ID}\\${DIGEST}.png`,
      `products/${PRODUCT_ID}/${DIGEST}.png `,
    ];

    for (const key of refused) {
      const response = await app.request(`/media/${encodeURI(key)}`);
      expect(response.status, `expected ${key} to be refused`).toBe(404);
    }

    // The guarantee is structural: nothing unrecognised ever reached a driver.
    expect(mediaStorage.getCalls).toEqual([]);
  });

  it("404s the same way for a malformed key and a missing object", async () => {
    // If the two answers differed, this endpoint could be used to probe for
    // well-formed keys — and therefore for product ids.
    const missing = await app.request(`/media/products/${PRODUCT_ID}/${DIGEST}.png`);
    const malformed = await app.request("/media/products/nope.png");

    expect(malformed.status).toBe(missing.status);
    expect(await malformed.text()).toBe(await missing.text());
  });

  it("404s an empty key rather than serving something unexpected", async () => {
    const response = await app.request("/media/");

    expect(response.status).toBe(404);
    expect(mediaStorage.getCalls).toEqual([]);
  });

  it("reports a storage fault as 500, not as a missing image", async () => {
    const key = seedObject([0x89, 0x50], "image/png");
    mediaStorage.failGet = true;

    const response = await app.request(`/media/${key}`);

    // A backend that cannot answer is not the same as an object that is absent,
    // and collapsing the two would turn a storage outage into a marketplace full
    // of broken images and no error anywhere.
    expect(response.status).toBe(500);
    const body = (await response.json()) as ApiFailure;
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error.");
  });

  it("does not accept a write to the public media path", async () => {
    const key = seedObject([0x89, 0x50], "image/png");

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.request(`/media/${key}`, { method });
      expect(response.status, `expected ${method} to be refused`).toBe(404);
    }
    expect(mediaStorage.putCalls).toEqual([]);
  });

  it("is loadable from another origin, which is how the storefront consumes it", async () => {
    // The regression this pins: Hono's `secureHeaders` default is
    // `Cross-Origin-Resource-Policy: same-origin`, which blocks a cross-origin
    // no-CORS load — and an `<img src>` is precisely one. Media is served from
    // the API origin and rendered by a storefront on a different one, so with
    // the default every seller-uploaded product photo is blocked in production
    // while same-origin seed images keep rendering and hide the fault. No
    // `crossorigin` attribute appears anywhere in the web app, so nothing opts
    // back in on the client side.
    const key = seedObject([0x89, 0x50, 0x4e, 0x47], "image/png");

    const response = await app.request(`/media/${key}`, {
      headers: { Origin: "https://zelora-web.farqas007.workers.dev" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("keeps the rest of the security header set intact", async () => {
    // `crossOriginResourcePolicy` is the single override; a mistake that
    // replaced the whole header set would strip these and is not visible from
    // the CORP assertion above.
    const key = seedObject([0x89, 0x50], "image/png");

    const response = await app.request(`/media/${key}`);

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("still refuses a credentialed cross-origin read, so CORP did not become CORS", async () => {
    // CORP and CORS are independent. Making media cross-origin-readable must not
    // hand any origin a readable response: `/media` sits outside the `cors()`
    // mount, so no `Access-Control-Allow-Origin` is emitted and a cross-origin
    // `fetch` of the same URL is still refused by the browser.
    const key = seedObject([0x89, 0x50], "image/png");

    const response = await app.request(`/media/${key}`, {
      headers: { Origin: "https://evil.test" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses media reads on a deployment with no media storage configured", async () => {
    const unconfigured = createApp({
      config: { ...config, mediaPublicBaseUrl: null },
      userRepository: inertRepository<UserRepository>("userRepository"),
      sessionRepository: inertRepository<AuthSessionRepository>("sessionRepository"),
      sellerRepository: inertRepository<SellerRepository>("sellerRepository"),
      catalogRepository: inertRepository<CatalogRepository>("catalogRepository"),
      productRepository: inertRepository<ProductRepository>("productRepository"),
      cartRepository: inertRepository<CartRepository>("cartRepository"),
    orderRepository: inertRepository<OrderRepository>("orderRepository"),
      auditLogRepository: inertRepository<AuditLogRepository>("auditLogRepository"),
      passwordHasher: new PBKDF2PasswordHasher(config.pbkdf2Iterations),
      clock: { now: () => new Date("2026-06-01T00:00:00.000Z") } satisfies Clock,
    });

    const response = await unconfigured.request(`/media/products/${PRODUCT_ID}/${DIGEST}.png`);

    expect(response.status).toBe(500);
    const body = (await response.json()) as ApiFailure;
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).not.toContain("MEDIA_PUBLIC_BASE_URL");
  });
});
