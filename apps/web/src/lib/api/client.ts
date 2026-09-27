import type {
  AddCartItemRequest,
  AddProductImagesEnvelope,
  ApiEnvelope,
  ApiErrorBody,
  AuthCsrfEnvelope,
  AuthMeEnvelope,
  CartEnvelope,
  CatalogCategoryDto,
  CatalogListProductsRequest,
  CatalogProductDetailDto,
  CatalogProductListData,
  CreateProductEnvelope,
  CreateProductRequest,
  CreateProductVariantEnvelope,
  CreateProductVariantRequest,
  DeleteProductImageEnvelope,
  GetSellerProductEnvelope,
  HealthResponse,
  ListSellerProductImagesEnvelope,
  ListSellerProductsEnvelope,
  LoginEnvelope,
  LoginRequest,
  LogoutAllEnvelope,
  LogoutEnvelope,
  PublishProductEnvelope,
  RegisterEnvelope,
  RegisterRequest,
  SellerOnboardingEnvelope,
  SellerOnboardingRequest,
  SellerListProductsRequest,
  SetInventoryEnvelope,
  SetInventoryRequest,
  SetPrimaryProductImageEnvelope,
  StorefrontEnvelope,
  StorefrontRequest,
  UpdateCartItemRequest,
} from "@zelora/shared";

/**
 * Browser-safe Zelora API client.
 *
 * The session cookie is HttpOnly, so it is never read or stored from
 * JavaScript: requests are made with `credentials: "include"` and the browser
 * attaches the cookie itself. CSRF-protected endpoints additionally echo the
 * in-memory synchronizer token in the `X-Zelora-CSRF` header supplied by the
 * injected token provider.
 *
 * This module is deliberately React-independent: callers wire in their own
 * CSRF token holder (a closure over in-memory state) and receive typed
 * {@link ApiEnvelope} responses straight from the existing shared contracts.
 *
 * ### Two transports, one error surface
 *
 * Every endpoint except the seller image upload sends a JSON body, and the
 * shared {@link request} path serialises it. The upload is the single
 * `multipart/form-data` endpoint, so it travels on a separate {@link requestFormData}
 * path. The split is deliberate: the browser must generate the multipart
 * boundary itself, so the upload path never sets `Content-Type` at all —
 * assigning one by hand strips the boundary and the API cannot parse the body.
 * Both paths then share the identical envelope decoding and error handling, so
 * a caller cannot tell from its types which transport a method used.
 */

/** Header the API's CSRF middleware requires on mutating requests. */
export const CSRF_HEADER = "X-Zelora-CSRF";

/**
 * Multipart field name the image upload endpoint reads each file part from.
 *
 * Exported so a caller building or asserting on the request body speaks the
 * server's vocabulary rather than a copy of it. The `[]` suffix mirrors the
 * server's own constant and is required: the API parses with
 * `parseBody({ all: true })`, which only yields an array for a bracketed
 * repeated field, and a bare `images` field is a 422 rather than a silent drop.
 */
export const IMAGE_FIELD = "images[]";

/** Absolute API base URL. Defaults to the local dev server. */
export const API_BASE_URL: string =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export interface ApiClientDependencies {
  /**
   * Absolute origin the API is served from. Defaults to {@link API_BASE_URL}.
   */
  baseUrl?: string;
  /**
   * Returns the current in-memory session CSRF token, or `null` when there is
   * no authenticated session. Invoked per mutating request so the token is
   * always read fresh.
   */
  getCsrfToken: () => string | null;
}

/** Typed endpoints of the Zelora API, keyed by HTTP route. */
export interface ZeloraApi {
  getHealth(): Promise<ApiEnvelope<HealthResponse>>;
  register(input: RegisterRequest): Promise<RegisterEnvelope>;
  login(input: LoginRequest): Promise<LoginEnvelope>;
  me(): Promise<AuthMeEnvelope>;
  csrf(): Promise<AuthCsrfEnvelope>;
  logout(): Promise<LogoutEnvelope>;
  logoutAll(): Promise<LogoutAllEnvelope>;
  onboardSeller(input: SellerOnboardingRequest): Promise<SellerOnboardingEnvelope>;
  listSellerProducts(input?: SellerListProductsRequest): Promise<ListSellerProductsEnvelope>;
  getSellerProduct(productId: string): Promise<GetSellerProductEnvelope>;
  listSellerProductImages(productId: string): Promise<ListSellerProductImagesEnvelope>;
  addProductImages(productId: string, files: readonly File[]): Promise<AddProductImagesEnvelope>;
  deleteProductImage(productId: string, imageId: string): Promise<DeleteProductImageEnvelope>;
  setPrimaryProductImage(productId: string, imageId: string): Promise<SetPrimaryProductImageEnvelope>;
  createProduct(input: CreateProductRequest): Promise<CreateProductEnvelope>;
  createProductVariant(
    productId: string,
    input: CreateProductVariantRequest,
  ): Promise<CreateProductVariantEnvelope>;
  setProductInventory(
    productId: string,
    variantId: string,
    input: SetInventoryRequest,
  ): Promise<SetInventoryEnvelope>;
  publishProduct(productId: string): Promise<PublishProductEnvelope>;
  listCatalogCategories(): Promise<ApiEnvelope<CatalogCategoryDto[]>>;
  listCatalogProducts(input: CatalogListProductsRequest): Promise<ApiEnvelope<CatalogProductListData>>;
  getCatalogProductBySlug(slug: string): Promise<ApiEnvelope<CatalogProductDetailDto>>;
  getStorefront(slug: string, input: StorefrontRequest): Promise<StorefrontEnvelope>;
  getCart(): Promise<CartEnvelope>;
  addCartItem(input: AddCartItemRequest): Promise<CartEnvelope>;
  updateCartItemQuantity(itemId: string, input: UpdateCartItemRequest): Promise<CartEnvelope>;
  removeCartItem(itemId: string): Promise<CartEnvelope>;
  clearCart(): Promise<CartEnvelope>;
}

/**
 * Transport-level failure: network error, non-JSON response, or an unexpected
 * payload shape. API-level failures arrive as valid {@link ApiFailure}
 * envelopes instead and are the caller's responsibility to narrow.
 */
export class ApiClientError extends Error {
  /** HTTP status when the failure came from a non-envelope response. */
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiClientError";
    this.status = status;
  }
}

/**
 * A valid {@link ApiFailure} envelope returned by the API. Carries the stable
 * `code`, per-field `fields`, and `details` alongside the human `message` so
 * callers can surface structured validation feedback without parsing strings.
 */
export class ApiFailureError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly fields: Record<string, string[]> | undefined;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiFailureError";
    this.code = body.code;
    this.details = body.details;
    this.fields = body.fields;
  }
}

export function createApiClient(
  dependencies: ApiClientDependencies,
): ZeloraApi {
  const baseUrl = dependencies.baseUrl ?? API_BASE_URL;

  interface RequestOptions {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    /** Send the CSRF header when a token is available. */
    csrf?: boolean;
  }

  /** Populate the CSRF header from the injected token holder, when asked for. */
  function applyCsrf(headers: Record<string, string>, csrf: boolean | undefined): void {
    if (csrf !== true) {
      return;
    }
    const token = dependencies.getCsrfToken();
    if (token !== null && token.length > 0) {
      headers[CSRF_HEADER] = token;
    }
  }

  /**
   * Send the prepared request and decode the shared envelope.
   *
   * Split out of {@link request} so the JSON and multipart transports cannot
   * drift: both hand an already-built `fetch` configuration to this one
   * function, and therefore share the `credentials`, the envelope decoding and
   * both failure shapes ({@link ApiClientError} for a transport fault,
   * a returned envelope for an API-level one).
   */
  async function send<E extends ApiEnvelope<unknown>>(
    url: string,
    init: RequestInit,
  ): Promise<E> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (cause) {
      throw new ApiClientError(`Unable to reach the Zelora API at ${url}.`, undefined, {
        cause,
      });
    }

    const body = await parseBody(response, url);
    if (typeof body === "object" && body !== null && "ok" in body) {
      return body as E;
    }
    throw new ApiClientError(
      `The Zelora API returned an unexpected payload for ${url}.`,
      response.status,
    );
  }

  async function request<E extends ApiEnvelope<unknown>>(
    path: string,
    options: RequestOptions,
  ): Promise<E> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    applyCsrf(headers, options.csrf);

    return send<E>(url, {
      method: options.method,
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  /**
   * Send a `multipart/form-data` request.
   *
   * The body is handed to `fetch` as a {@link FormData} instance with **no
   * `Content-Type` header**, and that omission is the contract rather than an
   * oversight: the browser appends `multipart/form-data; boundary=…` itself,
   * and a hand-written `Content-Type` would arrive without the boundary the API
   * parses with, so the body would be unreadable. `RequestInit` also forbids
   * setting the header for a `FormData` body in some runtimes, so this is
   * enforced by construction rather than by convention.
   *
   * One caveat worth stating because it shapes the caller's error handling:
   * `fetch` offers no upload-progress event, so a multipart request reports
   * only "started" and "finished". Callers that want a progress indicator
   * therefore drive a local counter of their own rather than a byte total.
   */
  async function requestFormData<E extends ApiEnvelope<unknown>>(
    path: string,
    options: { method: "POST" | "PATCH"; body: FormData; csrf?: boolean },
  ): Promise<E> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    applyCsrf(headers, options.csrf);

    return send<E>(url, {
      method: options.method,
      headers,
      credentials: "include",
      body: options.body,
    });
  }

  return {
    getHealth: () => request<ApiEnvelope<HealthResponse>>("/api/health", { method: "GET" }),
    register: (input: RegisterRequest) =>
      request<RegisterEnvelope>("/api/auth/register", { method: "POST", body: input }),
    login: (input: LoginRequest) =>
      request<LoginEnvelope>("/api/auth/login", { method: "POST", body: input }),
    me: () => request<AuthMeEnvelope>("/api/auth/me", { method: "GET" }),
    csrf: () => request<AuthCsrfEnvelope>("/api/auth/csrf", { method: "GET" }),
    logout: () => request<LogoutEnvelope>("/api/auth/logout", { method: "POST", csrf: true }),
    logoutAll: () =>
      request<LogoutAllEnvelope>("/api/auth/logout-all", { method: "POST", csrf: true }),
    onboardSeller: (input: SellerOnboardingRequest) =>
      request<SellerOnboardingEnvelope>("/api/seller/onboarding", {
        method: "POST",
        body: input,
        csrf: true,
      }),
    listSellerProducts: (input = {}) => {
      const params = new URLSearchParams();
      if (input.limit !== undefined) {
        params.set("limit", String(input.limit));
      }
      if (input.cursor !== undefined && input.cursor !== "") {
        params.set("cursor", input.cursor);
      }
      const query = params.toString();
      return request<ListSellerProductsEnvelope>(
        `/api/seller/products${query === "" ? "" : `?${query}`}`,
        { method: "GET" },
      );
    },
    getSellerProduct: (productId) =>
      request<GetSellerProductEnvelope>(
        `/api/seller/products/${encodeURIComponent(productId)}`,
        { method: "GET" },
      ),
    listSellerProductImages: (productId) =>
      request<ListSellerProductImagesEnvelope>(
        `/api/seller/products/${encodeURIComponent(productId)}/images`,
        { method: "GET" },
      ),
    addProductImages: (productId, files) => {
      // Every file is appended under the *same* `images[]` name so the body
      // carries N repeated parts. The bracket suffix is load-bearing on the
      // server: it is what makes a single-file upload parse as a one-element
      // array instead of a bare scalar, and a bare `images` field is rejected
      // outright rather than silently dropped.
      const body = new FormData();
      for (const file of files) {
        body.append(IMAGE_FIELD, file);
      }
      return requestFormData<AddProductImagesEnvelope>(
        `/api/seller/products/${encodeURIComponent(productId)}/images`,
        { method: "POST", body, csrf: true },
      );
    },
    deleteProductImage: (productId, imageId) =>
      request<DeleteProductImageEnvelope>(
        `/api/seller/products/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}`,
        { method: "DELETE", csrf: true },
      ),
    setPrimaryProductImage: (productId, imageId) =>
      request<SetPrimaryProductImageEnvelope>(
        `/api/seller/products/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}/primary`,
        { method: "POST", csrf: true },
      ),
    createProduct: (input: CreateProductRequest) =>
      request<CreateProductEnvelope>("/api/seller/products", {
        method: "POST",
        body: input,
        csrf: true,
      }),
    createProductVariant: (productId, input) =>
      request<CreateProductVariantEnvelope>(`/api/seller/products/${encodeURIComponent(productId)}/variants`, {
        method: "POST",
        body: input,
        csrf: true,
      }),
    setProductInventory: (productId, variantId, input) =>
      request<SetInventoryEnvelope>(
        `/api/seller/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}/inventory`,
        { method: "POST", body: input, csrf: true },
      ),
    publishProduct: (productId) =>
      request<PublishProductEnvelope>(`/api/seller/products/${encodeURIComponent(productId)}/publish`, {
        method: "POST",
        csrf: true,
      }),
    listCatalogCategories: () =>
      request<ApiEnvelope<CatalogCategoryDto[]>>("/api/catalog/categories", { method: "GET" }),
    listCatalogProducts: (input) => {
      const params = new URLSearchParams();
      if (input.limit !== undefined) {
        params.set("limit", String(input.limit));
      }
      if (input.cursor !== undefined && input.cursor !== "") {
        params.set("cursor", input.cursor);
      }
      if (input.category !== undefined && input.category !== "") {
        params.set("category", input.category);
      }
      const query = params.toString();
      return request<ApiEnvelope<CatalogProductListData>>(
        `/api/catalog/products${query === "" ? "" : `?${query}`}`,
        { method: "GET" },
      );
    },
    getCatalogProductBySlug: (slug) =>
      request<ApiEnvelope<CatalogProductDetailDto>>(
        `/api/catalog/products/${encodeURIComponent(slug)}`,
        { method: "GET" },
      ),
    getStorefront: (slug, input) => {
      const params = new URLSearchParams();
      if (input.limit !== undefined) {
        params.set("limit", String(input.limit));
      }
      if (input.cursor !== undefined && input.cursor !== "") {
        params.set("cursor", input.cursor);
      }
      const query = params.toString();
      return request<StorefrontEnvelope>(
        `/api/stores/${encodeURIComponent(slug)}${query === "" ? "" : `?${query}`}`,
        { method: "GET" },
      );
    },
    getCart: () => request<CartEnvelope>("/api/cart", { method: "GET" }),
    addCartItem: (input) =>
      request<CartEnvelope>("/api/cart/items", { method: "POST", body: input, csrf: true }),
    updateCartItemQuantity: (itemId, input) =>
      request<CartEnvelope>(`/api/cart/items/${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        body: input,
        csrf: true,
      }),
    removeCartItem: (itemId) =>
      request<CartEnvelope>(`/api/cart/items/${encodeURIComponent(itemId)}`, {
        method: "DELETE",
        csrf: true,
      }),
    clearCart: () => request<CartEnvelope>("/api/cart", { method: "DELETE", csrf: true }),
  };
}

async function parseBody(response: Response, url: string): Promise<unknown> {
  const text = await response.text();
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiClientError(
      `The Zelora API returned a non-JSON response for ${url}.`,
      response.status,
    );
  }
}