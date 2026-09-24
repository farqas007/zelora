import type {
  AddCartItemRequest,
  ApiEnvelope,
  ApiErrorBody,
  AuthCsrfEnvelope,
  AuthMeEnvelope,
  CartEnvelope,
  CatalogCategoryDto,
  CatalogListProductsRequest,
  CatalogProductDetailDto,
  CatalogProductListData,
  HealthResponse,
  LoginEnvelope,
  LoginRequest,
  LogoutAllEnvelope,
  LogoutEnvelope,
  RegisterEnvelope,
  RegisterRequest,
  SellerOnboardingEnvelope,
  SellerOnboardingRequest,
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
 */

/** Header the API's CSRF middleware requires on mutating requests. */
export const CSRF_HEADER = "X-Zelora-CSRF";

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
  listCatalogCategories(): Promise<ApiEnvelope<CatalogCategoryDto[]>>;
  listCatalogProducts(input: CatalogListProductsRequest): Promise<ApiEnvelope<CatalogProductListData>>;
  getCatalogProductBySlug(slug: string): Promise<ApiEnvelope<CatalogProductDetailDto>>;
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

  async function request<E extends ApiEnvelope<unknown>>(
    path: string,
    options: RequestOptions,
  ): Promise<E> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.csrf === true) {
      const token = dependencies.getCsrfToken();
      if (token !== null && token.length > 0) {
        headers[CSRF_HEADER] = token;
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        credentials: "include",
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
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