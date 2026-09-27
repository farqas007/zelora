import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context, MiddlewareHandler } from "hono";
import { AppError, toApiFailure, ValidationError, type AppConfig } from "@zelora/core";
import type { AuthSessionRepository } from "@zelora/db/auth";
import type { UserRepository } from "@zelora/db/users";
import { PRODUCT_IMAGE_UPLOAD_LIMITS } from "@zelora/shared";
import type {
  AddProductImagesEnvelope,
  CreateProductEnvelope,
  CreateProductVariantEnvelope,
  GetSellerProductEnvelope,
  ListSellerProductImagesEnvelope,
  ListSellerProductsEnvelope,
  PublishProductEnvelope,
  SellerOnboardingEnvelope,
  SetInventoryEnvelope,
} from "@zelora/shared";
import type { AppEnv } from "../context";
import { createAuthMiddleware } from "../middleware/auth";
import { createCsrfMiddleware } from "../middleware/csrf";
import { createIpRateLimitMiddleware } from "../middleware/rate-limit";
import type { ProductImageUpload, SellerService } from "../services/seller";
import type { Clock } from "../services/clock";
import type { ClientIpResolver } from "../services/client-ip";
import type { RateLimiter } from "../services/rate-limit";

/**
 * Seller routes mounted at `/api/seller`.
 *
 * `POST /api/seller/onboarding` runs behind the existing security stack in a
 * fixed order: authentication (session cookie), CSRF (synchronizer token) and
 * then the seller-onboarding per-IP rate limit before the handler. The handler
 * only reads the body, hands everything to the injected {@link SellerService},
 * and returns the shared envelope. It never touches repositories directly and
 * never constructs a service itself.
 *
 * `POST /api/seller/products` runs behind the same stack plus an explicit
 * seller-role gate ({@link requireSellerRole}) and a dedicated per-IP rate
 * limit, then delegates identity verification and product creation to
 * {@link SellerService.createProduct}.
 *
 * `POST /api/seller/products/:id/variants`,
 * `POST /api/seller/products/:id/variants/:variantId/inventory` and
 * `POST /api/seller/products/:id/publish` extend the same flow: each runs
 * behind auth, the seller-role gate, CSRF and its own per-IP rate limit, then
 * delegates to {@link SellerService}. Ownership is resolved entirely
 * server-side by the service from the authenticated session, never from the
 * request body.
 *
 * `GET /api/seller/products/:id/images` is a read, so it runs behind
 * authentication and the seller-role gate only — no CSRF check (it changes no
 * state) and no write rate limit, matching the other seller reads above.
 *
 * `POST /api/seller/products/:id/images` is the one multipart endpoint in the
 * API. It carries the same stack as the other seller writes — auth, the
 * seller-role gate, CSRF, a per-IP rate limit — plus a route-scoped request
 * body limit, because `multipart/form-data` is parsed into memory in one piece
 * and is therefore the only request shape that can be large. The handler reads
 * the parts and delegates to {@link SellerService.addProductImages}; it does no
 * image validation of its own and never touches storage.
 *
 * Route modules stay edge-compatible: the seller repository is injected by the
 * application boundary and only its contract is referenced here as a type. The
 * multipart helpers below use only web-standard globals (`File`, `FormData`)
 * and Hono, so the same code runs in the Cloudflare Worker.
 */

/** Reject non-seller callers after the auth middleware has resolved identity. */
export function requireSellerRole(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth.user.role !== "seller") {
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to perform this action.",
        403,
      );
    }
    await next();
  };
}

export interface SellerRoutesDependencies {
  config: AppConfig;
  sellerService: SellerService;
  sessionRepository: AuthSessionRepository;
  userRepository: UserRepository;
  clock: Clock;
  rateLimiter: RateLimiter;
  clientIpResolver: ClientIpResolver;
}

/**
 * Read the JSON request body as `unknown` so validation owns all shape
 * checks. Malformed JSON or an empty body surfaces as `null`, which the shared
 * validation layer rejects with a `VALIDATION_ERROR` envelope instead of
 * leaking a parser exception.
 */
async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** Multipart field carrying the image parts. The `[]` suffix is load-bearing. */
const IMAGE_FIELD = "images[]";

/** Multipart field carrying per-image alt text, positionally paired. */
const ALT_TEXT_FIELD = "altText[]";

/** Content type the upload endpoint accepts, as it appears in the header. */
const MULTIPART_FORM_DATA = "multipart/form-data";

/**
 * Reject a request body this endpoint cannot use, with a typed 422.
 *
 * `fields` keys distinguish *transport* problems (`images`, `altText`,
 * `contentType`) from the *content* problems the service reports per file under
 * `imagePosition`. Keeping them apart is what lets a client tell "you sent the
 * wrong shape" from "your third file is not an image" without parsing prose.
 */
function uploadShapeError(field: string, message: string): ValidationError {
  return new ValidationError("The request is invalid.", { [field]: [message] });
}

/**
 * Bound the buffered request body for an image upload.
 *
 * Mounted per route rather than globally: the other endpoints are JSON bodies a
 * few kilobytes at most, and a global cap large enough for a multi-megabyte
 * multipart upload would be a large cap on every request the API serves.
 *
 * ### Why a custom `onError`
 *
 * Hono's `bodyLimit` default throws an `HTTPException(413)`, but this app
 * installs its own error boundary (`createErrorHandler`), which *replaces*
 * Hono's default handler — and the replacement is the only place `HTTPException`
 * is understood. Left alone, an oversized body would be reported to the seller
 * as a 500 `INTERNAL_ERROR`, which is both wrong (the seller did nothing
 * invalid beyond sending too much at once) and actively misleading in a log
 * full of real server faults. The handler below therefore renders the shared
 * failure envelope itself, and answers **422** rather than 413 so the existing
 * `HttpStatus` vocabulary in `@zelora/core` stays exactly as it is.
 *
 * This is a resource guard, not a validation rule: a body that fits is still
 * checked file by file for size, count and format, and a body that does not fit
 * is refused before a single byte is parsed into an image.
 */
function imageUploadBodyLimit(): MiddlewareHandler {
  return bodyLimit({
    maxSize: PRODUCT_IMAGE_UPLOAD_LIMITS.maxBodyBytes,
    onError: (c) => {
      const failure = toApiFailure(
        uploadShapeError(
          "images",
          `The upload must be at most ${PRODUCT_IMAGE_UPLOAD_LIMITS.maxBodyBytes} bytes in total.`,
        ),
      );
      return c.json(failure, 422);
    },
  });
}

/** Narrow a parsed multipart value to a string part, or `null` when it is not. */
function multipartIsText(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Turn one parsed multipart body into the transport-neutral upload list the
 * service validates, or throw a 422 describing the shape problem.
 *
 * Every rule here is about *shape*, and all of them are decided before the
 * service sees a byte:
 *
 * - **The `[]` suffix is required on the field names.** Hono returns a bare
 *   scalar for a repeated field that happened to occur once, so `images` would
 *   hand the service a `File` where it requires an array — and a single-image
 *   upload is the common case, not the edge case. `images[]` is always an
 *   array, so the contract has no arity-dependent shape. A bare `images` field
 *   is therefore *rejected* rather than ignored: silently dropping files a
 *   seller believed they uploaded is the one outcome worse than an error.
 * - **Alt text is paired by position, so its arity must be exact.** An
 *   `altText[]` whose length differs from `images[]` would either leave trailing
 *   images undescribed or shift descriptions onto the wrong file. Both are
 *   silent data corruption, so *any* mismatch is a 422 rather than a best-effort
 *   pairing. Alt text as a whole is still optional: omit the field to describe
 *   nothing, send one part per image to describe them all, and send an empty
 *   part for an individual image that needs no description.
 * - **Only `File` parts are images.** A text part named `images[]` is a client
 *   that sent a path or a base64 string; validating it as image bytes would
 *   fail anyway, but with a message about image content instead of about the
 *   request shape.
 * - **Unknown fields are ignored**, matching every other endpoint here: a
 *   client-supplied field is never trusted, and refusing to be forward-compatible
 *   would break a browser that adds its own bookkeeping to the form.
 */
async function readImageUploads(c: Context): Promise<ProductImageUpload[]> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== MULTIPART_FORM_DATA) {
    throw uploadShapeError(
      "contentType",
      "Images must be uploaded as multipart/form-data.",
    );
  }
  // `all: true` is what makes a repeated field an array; Hono's own default
  // returns the last value only. A parse failure (malformed boundary, truncated
  // body) surfaces as a typed 422 rather than a parser exception.
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    throw uploadShapeError("contentType", "The upload could not be read as multipart/form-data.");
  }

  const rawImages = body[IMAGE_FIELD];
  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    throw uploadShapeError(IMAGE_FIELD, `At least one "${IMAGE_FIELD}" part is required.`);
  }

  const files: File[] = [];
  for (const [index, value] of rawImages.entries()) {
    if (!(value instanceof File)) {
      throw uploadShapeError(
        IMAGE_FIELD,
        `Image ${index + 1} must be an uploaded file.`,
      );
    }
    files.push(value);
  }

  const rawAltText = body[ALT_TEXT_FIELD];
  let altTexts: string[];
  if (rawAltText === undefined) {
    altTexts = [];
  } else if (Array.isArray(rawAltText) && rawAltText.every(multipartIsText)) {
    altTexts = rawAltText;
  } else {
    throw uploadShapeError(ALT_TEXT_FIELD, `Alt text must be sent as "${ALT_TEXT_FIELD}" text parts.`);
  }
  if (altTexts.length !== 0 && altTexts.length !== files.length) {
    throw uploadShapeError(
      ALT_TEXT_FIELD,
      `Send either no alt text or exactly one "${ALT_TEXT_FIELD}" part per image (${files.length} expected, ${altTexts.length} received).`,
    );
  }

  // Read every part into memory *before* handing anything to the service. The
  // body is already fully buffered by the parser, so this is a slice of a
  // bounded buffer rather than a second download, and it is what lets the
  // service validate the whole batch before the first storage write.
  return Promise.all(
    files.map(async (file, index) => ({
      bytes: new Uint8Array(await file.arrayBuffer()),
      altText: altTexts[index] ?? null,
    })),
  );
}

export function createSellerRoutes(dependencies: SellerRoutesDependencies): Hono<AppEnv> {
  const { config, sellerService, sessionRepository, userRepository, clock, rateLimiter, clientIpResolver } =
    dependencies;
  const app = new Hono<AppEnv>();

  const requireAuth = createAuthMiddleware({
    sessionRepository,
    userRepository,
    clock,
    config,
  });
  const requireCsrf = createCsrfMiddleware();

  const onboardingRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-onboarding",
    limit: config.rateLimitSellerOnboardingIpMax,
    windowSeconds: config.rateLimitSellerOnboardingIpWindowSeconds,
  });

  const productCreateRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-product-create",
    limit: config.rateLimitProductCreateIpMax,
    windowSeconds: config.rateLimitProductCreateIpWindowSeconds,
  });

  const productVariantRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-product-variant",
    limit: config.rateLimitProductCreateIpMax,
    windowSeconds: config.rateLimitProductCreateIpWindowSeconds,
  });

  const productInventoryRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-product-inventory",
    limit: config.rateLimitProductCreateIpMax,
    windowSeconds: config.rateLimitProductCreateIpWindowSeconds,
  });

  const productPublishRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-product-publish",
    limit: config.rateLimitProductCreateIpMax,
    windowSeconds: config.rateLimitProductCreateIpWindowSeconds,
  });

  const productImageUploadRateLimit = createIpRateLimitMiddleware({
    config,
    rateLimiter,
    clientIpResolver,
    clock,
    scope: "seller-product-image-upload",
    // Uploads share the product-mutation budget with the variant, inventory and
    // publish routes, each under its own scope. Reusing the limit is what keeps
    // the seller's whole write surface on one number an operator already knows
    // how to tune, instead of a second number that silently diverges from it.
    limit: config.rateLimitProductCreateIpMax,
    windowSeconds: config.rateLimitProductCreateIpWindowSeconds,
  });

  app.post("/onboarding", requireAuth, requireCsrf, onboardingRateLimit, async (c) => {
    const auth = c.get("auth");
    const body = await readJsonBody(c);
    const data = await sellerService.onboard(auth.user, body);
    return c.json<SellerOnboardingEnvelope>({ ok: true, data }, 201);
  });

  app.get("/products", requireAuth, requireSellerRole(), async (c) => {
    const auth = c.get("auth");
    const data = await sellerService.listProducts(auth.user, {
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    return c.json<ListSellerProductsEnvelope>({ ok: true, data }, 200);
  });

  app.get("/products/:id", requireAuth, requireSellerRole(), async (c) => {
    const auth = c.get("auth");
    const data = await sellerService.getProduct(auth.user, c.req.param("id"));
    return c.json<GetSellerProductEnvelope>({ ok: true, data }, 200);
  });

  app.get("/products/:id/images", requireAuth, requireSellerRole(), async (c) => {
    const auth = c.get("auth");
    const data = await sellerService.listProductImages(auth.user, c.req.param("id"));
    return c.json<ListSellerProductImagesEnvelope>({ ok: true, data }, 200);
  });

  app.post(
    "/products",
    requireAuth,
    requireSellerRole(),
    requireCsrf,
    productCreateRateLimit,
    async (c) => {
      const auth = c.get("auth");
      const body = await readJsonBody(c);
      const data = await sellerService.createProduct(auth.user, body);
      return c.json<CreateProductEnvelope>({ ok: true, data }, 201);
    },
  );

  app.post(
    "/products/:id/variants",
    requireAuth,
    requireSellerRole(),
    requireCsrf,
    productVariantRateLimit,
    async (c) => {
      const auth = c.get("auth");
      const id = c.req.param("id");
      const body = await readJsonBody(c);
      const data = await sellerService.createVariant(auth.user, id, body);
      return c.json<CreateProductVariantEnvelope>({ ok: true, data }, 201);
    },
  );

  app.post(
    "/products/:id/variants/:variantId/inventory",
    requireAuth,
    requireSellerRole(),
    requireCsrf,
    productInventoryRateLimit,
    async (c) => {
      const auth = c.get("auth");
      const id = c.req.param("id");
      const variantId = c.req.param("variantId");
      const body = await readJsonBody(c);
      const data = await sellerService.setInventory(auth.user, id, variantId, body);
      return c.json<SetInventoryEnvelope>({ ok: true, data }, 200);
    },
  );

  app.post(
    "/products/:id/publish",
    requireAuth,
    requireSellerRole(),
    requireCsrf,
    productPublishRateLimit,
    async (c) => {
      const auth = c.get("auth");
      const id = c.req.param("id");
      const data = await sellerService.publishProduct(auth.user, id);
      return c.json<PublishProductEnvelope>({ ok: true, data }, 200);
    },
  );

  /**
   * `POST /api/seller/products/:id/images` is the transport over
   * {@link SellerService.addProductImages}, and the ordering of the stack is
   * the security property: authentication, then the seller-role gate, then CSRF,
   * then the per-IP budget, and only then the body-size guard and the handler.
   *
   * The rate limit deliberately runs *before* the body limit, so a caller who is
   * over budget is refused without their payload ever being buffered — the
   * expensive step is the one gated by the cheap one. The body limit then runs
   * before the handler for the same reason, and the handler still does not
   * validate a single image: it reads parts and hands them to the service,
   * which resolves ownership server-side and decides everything else.
   */
  app.post(
    "/products/:id/images",
    requireAuth,
    requireSellerRole(),
    requireCsrf,
    productImageUploadRateLimit,
    imageUploadBodyLimit(),
    async (c) => {
      const auth = c.get("auth");
      const id = c.req.param("id");
      const uploads = await readImageUploads(c);
      const data = await sellerService.addProductImages(auth.user, id, uploads);
      return c.json<AddProductImagesEnvelope>({ ok: true, data }, 201);
    },
  );

  return app;
}