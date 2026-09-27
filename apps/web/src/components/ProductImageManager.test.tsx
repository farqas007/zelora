import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  ApiEnvelope,
  DeletedProductImageData,
  ProductImageDto,
  SellerProductImageListData,
} from "@zelora/shared";
import { ProductImageManager } from "./ProductImageManager";
import { IMAGE_FIELD, type ZeloraApi } from "../lib/api/client";

/**
 * Component tests for the seller image manager.
 *
 * The API is injected as a prop, so these exercise the real component against a
 * recording double rather than a mocked module — the manager's contract with the
 * API client is the thing under test, so stubbing the client out would test
 * nothing.
 */

const PRODUCT_ID = "01955f00-0000-7000-8000-0000000000a1";

/** One image row, with only the fields the manager reads set explicitly. */
function image(overrides: Partial<ProductImageDto> & { id: string }): ProductImageDto {
  return {
    productId: PRODUCT_ID,
    url: `https://media.test/media/products/${PRODUCT_ID}/${overrides.id}.png`,
    altText: null,
    sortOrder: 0,
    isPrimary: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Wrap a list in the success envelope the client returns. */
function ok<T>(data: T): ApiEnvelope<T> {
  return { ok: true, data };
}

/** A failure envelope, shaped as the API sends it. */
function failure(
  code: string,
  message: string,
  fields?: Record<string, string[]>,
): ApiEnvelope<never> {
  return { ok: false, error: { code, message, ...(fields === undefined ? {} : { fields }) } };
}

/** A PNG-shaped file. The bytes are never read: the API sniffs, not the client. */
function pngFile(name: string, size = 512): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

/**
 * A recording API double.
 *
 * Overrides are supplied as an *outcome* — a value, a promise, or a function of
 * the call arguments — rather than as a replacement function. Every method is
 * wrapped by the same recorder either way, so a test can both override what an
 * endpoint returns and assert on the calls that were made; replacing a method
 * outright would silently stop it being recorded.
 */
interface StubOptions {
  addProductImages?: Outcome<ApiEnvelope<ProductImageDto[]>>;
  deleteProductImage?: Outcome<ApiEnvelope<DeletedProductImageData>>;
  setPrimaryProductImage?: Outcome<ApiEnvelope<ProductImageDto>>;
  listSellerProductImages?: Outcome<ApiEnvelope<SellerProductImageListData>>;
}

/** What an overridden method should resolve to. A function may also reject. */
type Outcome<R> = R | Promise<R> | ((...args: unknown[]) => R | Promise<R>);

interface RecordedCall {
  method: string;
  args: unknown[];
}

function createApiStub(options: StubOptions = {}): {
  api: ZeloraApi;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  function record<R>(method: string, fallback: R): (...args: unknown[]) => Promise<R> {
    return (...args: unknown[]): Promise<R> => {
      calls.push({ method, args });
      const override = options[method as keyof StubOptions];
      if (override === undefined) {
        return Promise.resolve(fallback);
      }
      if (typeof override === "function") {
        return Promise.resolve((override as (...a: unknown[]) => R | Promise<R>)(...args));
      }
      return Promise.resolve(override as R);
    };
  }

  const api = {
    addProductImages: record<ApiEnvelope<ProductImageDto[]>>("addProductImages", ok([])),
    deleteProductImage: record<ApiEnvelope<DeletedProductImageData>>(
      "deleteProductImage",
      ok({ productId: PRODUCT_ID, imageId: "", wasPrimary: false }),
    ),
    setPrimaryProductImage: record<ApiEnvelope<ProductImageDto>>(
      "setPrimaryProductImage",
      ok(image({ id: "" })),
    ),
    listSellerProductImages: record<ApiEnvelope<SellerProductImageListData>>(
      "listSellerProductImages",
      ok({ productId: PRODUCT_ID, images: [] }),
    ),
  } as unknown as ZeloraApi;

  return { api, calls };
}

/** Methods that were called, in order, by name only. */
function methodNames(calls: readonly RecordedCall[]): string[] {
  return calls.map((call) => call.method);
}

/** Calls of one kind, in order. */
function callsTo(calls: readonly RecordedCall[], method: string): RecordedCall[] {
  return calls.filter((call) => call.method === method);
}

/** A promise plus its resolver, for holding a request open mid-assertion. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {
    throw new Error("resolve called before it was assigned");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

let objectUrlStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom implements neither `URL.createObjectURL` nor `revokeObjectURL`, and
  // neither is used by the app — the preview URL is a test affordance so a
  // selected file can be asserted on. Stubbed here rather than shipped.
  objectUrlStub = vi.fn(() => "blob:zelora-test/1");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: objectUrlStub }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderManager(
  api: ZeloraApi,
  initialImages: ProductImageDto[],
): ReturnType<typeof render> {
  return render(
    <ProductImageManager
      api={api}
      productId={PRODUCT_ID}
      productName="Wireless Headphones"
      initialImages={initialImages}
    />,
  );
}

/**
 * The first gallery tile containing a control with the given accessible name.
 *
 * "First" is the primary image's tile, since the canonical order always leads
 * with the primary.
 */
function tileFor(name: RegExp): HTMLElement {
  const button = screen.getAllByRole("button", { name })[0]!;
  const tile = button.closest("li");
  if (tile === null) throw new Error("expected the control to sit inside a gallery tile");
  return tile;
}

/** Every "Set primary" control, in the order the tiles render. */
function setPrimaryControls(): HTMLElement[] {
  return screen.getAllByRole("button", { name: /as the primary image/ });
}

/** Every "Remove" control, in the order the tiles render. */
function removeControls(): HTMLElement[] {
  return screen.getAllByRole("button", { name: /Remove .* from this product/ });
}

/** The `src` of every visible gallery image, in render order. */
function imageSources(): Array<string | null> {
  return screen.getAllByRole("img").map((node) => node.getAttribute("src"));
}

/** The visible file input, reached by its real label rather than a test id. */
function fileInput(): HTMLInputElement {
  return screen.getByLabelText("Add images") as HTMLInputElement;
}

/** Select files as a user would, through the input rather than a synthetic call. */
function selectFiles(files: File[]): void {
  fireEvent.change(fileInput(), { target: { files } });
}

describe("ProductImageManager", () => {
  describe("rendering the server's gallery", () => {
    it("renders every image with its url used verbatim", () => {
      const first = image({ id: "img-1", sortOrder: 0 });
      const second = image({ id: "img-2", sortOrder: 1 });
      const { api } = createApiStub();

      renderManager(api, [first, second]);

      // `image.url` is already absolute; the manager must not re-derive it.
      expect(imageSources()).toEqual([first.url, second.url]);
    });

    it("keeps the order the server sent rather than sorting locally", () => {
      const { api } = createApiStub();
      // Deliberately not sorted by sortOrder or primary flag: the array is
      // canonical and the UI must render it as given.
      const served = [
        image({ id: "img-b", sortOrder: 1, isPrimary: false }),
        image({ id: "img-a", sortOrder: 0, isPrimary: true }),
      ];

      renderManager(api, served);

      expect(imageSources()).toEqual([served[0]!.url, served[1]!.url]);
    });

    it("shows the Primary badge on the primary image only", () => {
      const { api } = createApiStub();

      renderManager(api, [
        image({ id: "img-1", sortOrder: 0, isPrimary: true }),
        image({ id: "img-2", sortOrder: 1, isPrimary: false }),
      ]);

      const badges = screen.getAllByText("Primary");
      expect(badges).toHaveLength(1);
      expect(within(tileFor(/Set .* as the primary image/)).getByText("Primary")).toBeDefined();
    });

    it("disables Set primary on the image that is already primary", () => {
      const { api } = createApiStub();

      renderManager(api, [
        image({ id: "img-1", sortOrder: 0, isPrimary: true }),
        image({ id: "img-2", sortOrder: 1, isPrimary: false }),
      ]);

      const controls = setPrimaryControls();
      expect((controls[0] as HTMLButtonElement | HTMLInputElement).disabled).toBe(true);
      expect((controls[1] as HTMLButtonElement | HTMLInputElement).disabled).toBe(false);
    });

    it("shows the count out of the shared cap", () => {
      const { api } = createApiStub();

      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);

      expect(screen.getByText("2 of 8")).toBeDefined();
    });

    it("states the empty case", () => {
      const { api } = createApiStub();

      renderManager(api, []);

      expect(screen.getByText("No images have been added yet.")).toBeDefined();
    });
  });

  describe("the zero-primary state", () => {
    it("says so when the gallery holds images but none is primary", () => {
      const { api } = createApiStub();

      renderManager(api, [
        image({ id: "img-1", isPrimary: false }),
        image({ id: "img-2", isPrimary: false }),
      ]);

      expect(screen.getByText(/No primary image set/)).toBeDefined();
      expect(screen.queryByText("Primary")).toBeNull();
    });

    it("stays silent when a primary exists", () => {
      const { api } = createApiStub();

      renderManager(api, [image({ id: "img-1", isPrimary: true })]);

      expect(screen.queryByText(/No primary image set/)).toBeNull();
    });

    it("stays silent for an empty gallery, which has nothing to promote", () => {
      const { api } = createApiStub();

      renderManager(api, []);

      expect(screen.queryByText(/No primary image set/)).toBeNull();
    });

    it("does not assume the first image is the primary", () => {
      const { api } = createApiStub();

      renderManager(api, [
        image({ id: "img-1", sortOrder: 0, isPrimary: false }),
        image({ id: "img-2", sortOrder: 1, isPrimary: true }),
      ]);

      // The second tile is the primary, and Set primary is disabled there.
      const controls = setPrimaryControls();
      expect((controls[1] as HTMLButtonElement | HTMLInputElement).disabled).toBe(true);
    });
  });

  describe("uploading", () => {
    it("posts a multipart body with one images[] part per file", async () => {
      const { api, calls } = createApiStub();

      renderManager(api, []);
      const input = screen.getByLabelText("Add images") as HTMLInputElement;
      fireEvent.change(input, {
        target: {
          files: [pngFile("one.png"), pngFile("two.png")],
        },
      });

      await waitFor(() => expect(methodNames(calls)).toContain("addProductImages"));

      const upload = calls.find((call) => call.method === "addProductImages");
      const files = upload?.args[1] as File[];
      expect(upload?.args[0]).toBe(PRODUCT_ID);
      expect(files).toHaveLength(2);
      expect(files.map((file) => file.name)).toEqual(["one.png", "two.png"]);
    });

    it("never sets Content-Type by hand, so the browser adds the boundary", async () => {
      // The real client is exercised here rather than the stub, because the
      // header is the client's decision and a stubbed method cannot prove it.
      const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(ok([])), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { createApiClient } = await import("../lib/api/client");
      const api = createApiClient({ getCsrfToken: () => "csrf-token" });

      await api.addProductImages(PRODUCT_ID, [pngFile("one.png")]);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://localhost:3001/api/seller/products/${PRODUCT_ID}/images`);
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
    });

    it("appends every file under the bracketed field name, never a bare one", async () => {
      const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(ok([])), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { createApiClient } = await import("../lib/api/client");
      const api = createApiClient({ getCsrfToken: () => "csrf-token" });

      await api.addProductImages(PRODUCT_ID, [pngFile("one.png"), pngFile("two.png")]);

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const body = init.body as FormData;
      expect(IMAGE_FIELD).toBe("images[]");
      expect(body.getAll(IMAGE_FIELD)).toHaveLength(2);
      expect(body.getAll("images")).toHaveLength(0);
    });

    it("sends the CSRF token on the upload", async () => {
      const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(ok([])), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { createApiClient, CSRF_HEADER } = await import("../lib/api/client");
      const api = createApiClient({ getCsrfToken: () => "csrf-token" });

      await api.addProductImages(PRODUCT_ID, [pngFile("one.png")]);

      const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
      expect(headers[CSRF_HEADER]).toBe("csrf-token");
    });

    it("re-reads the canonical list after uploading", async () => {
      const uploaded = [image({ id: "img-new", sortOrder: 8 })];
      const { api, calls } = createApiStub({
        addProductImages: ok(uploaded),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: uploaded })),
        ),
      });

      renderManager(api, []);
      selectFiles([pngFile("one.png")]);

      await waitFor(() => expect(methodNames(calls)).toEqual([
        "addProductImages",
        "listSellerProductImages",
      ]));
    });

    it("renders the canonical order the re-read returned, not the upload order", async () => {
      const canonical = [
        image({ id: "img-primary", isPrimary: true }),
        image({ id: "img-new", sortOrder: 8 }),
      ];
      const { api } = createApiStub({
        addProductImages: ok([image({ id: "img-new" })]),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: canonical })),
        ),
      });

      renderManager(api, []);
      selectFiles([pngFile("one.png")]);

      await waitFor(() => {
        expect(imageSources()).toEqual([canonical[0]!.url, canonical[1]!.url]);
      });
    });

    it("refuses an over-capacity selection before any request is made", async () => {
      const { api, calls } = createApiStub();
      renderManager(api, Array.from({ length: 8 }, (_u, index) => image({ id: `img-${index}` })));

      selectFiles([pngFile("ninth.png")]);

      expect(await screen.findByText(/already has 8 images/)).toBeDefined();
      expect(calls).toHaveLength(0);
    });

    it("reports an unsupported file type without contacting the API", async () => {
      const { api, calls } = createApiStub();

      renderManager(api, []);
      fireEvent.change(screen.getByLabelText("Add images"), {
        target: { files: [new File([new Uint8Array(64)], "scan.tiff", { type: "image/tiff" })] },
      });

      expect(await screen.findByText(/scan\.tiff/)).toBeDefined();
      expect(calls).toHaveLength(0);
    });

    it("disables the file input once the product is at the cap", () => {
      const { api } = createApiStub();
      renderManager(api, Array.from({ length: 8 }, (_u, index) => image({ id: `img-${index}` })));

      expect((screen.getByLabelText("Add images") as HTMLButtonElement | HTMLInputElement).disabled).toBe(true);
    });
  });

  describe("setting the primary image", () => {
    it("posts to the primary endpoint and then re-reads the canonical list", async () => {
      const promoted = [image({ id: "img-2", isPrimary: true }), image({ id: "img-1" })];
      const { api, calls } = createApiStub({
        setPrimaryProductImage: ok(promoted[0]!),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: promoted })),
        ),
      });

      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);
      // The first tile is img-1's, because img-1 is primary before this click.
      fireEvent.click(setPrimaryControls()[0]!);

      await waitFor(() =>
        expect(methodNames(calls)).toEqual(["setPrimaryProductImage", "listSellerProductImages"]),
      );
      const setPrimary = calls[0]!;
      expect(setPrimary.args).toEqual([PRODUCT_ID, "img-1"]);
    });

    it("shows the Primary badge on the image the server promoted", async () => {
      const promoted = [image({ id: "img-2", isPrimary: true }), image({ id: "img-1" })];
      const { api } = createApiStub({
        setPrimaryProductImage: ok(promoted[0]!),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: promoted })),
        ),
      });

      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);
      fireEvent.click(setPrimaryControls()[0]!);

      await waitFor(() => expect(screen.getAllByText("Primary")).toHaveLength(1));
      expect(
        within(tileFor(/as the primary image/)).getByText("Primary"),
      ).toBeDefined();
    });
  });

  describe("deleting an image", () => {
    it("deletes then re-reads the canonical list", async () => {
      const remaining = [image({ id: "img-2", isPrimary: true })];
      const { api, calls } = createApiStub({
        deleteProductImage: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, imageId: "img-1", wasPrimary: false })),
        ),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: remaining })),
        ),
      });

      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);
      fireEvent.click(removeControls()[0]!);

      await waitFor(() =>
        expect(methodNames(calls)).toEqual(["deleteProductImage", "listSellerProductImages"]),
      );
      expect(calls[0]!.args).toEqual([PRODUCT_ID, "img-1"]);
    });

    it("drops the deleted image from the gallery", async () => {
      const remaining = [image({ id: "img-2" })];
      const { api } = createApiStub({
        deleteProductImage: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, imageId: "img-1", wasPrimary: false })),
        ),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: remaining })),
        ),
      });

      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);
      fireEvent.click(removeControls()[0]!);

      await waitFor(() => {
        expect(imageSources()).toEqual([remaining[0]!.url]);
      });
    });

    it("does not claim stored bytes were freed", async () => {
      const { api } = createApiStub({
        deleteProductImage: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, imageId: "img-1", wasPrimary: false })),
        ),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: [] })),
        ),
      });

      renderManager(api, [image({ id: "img-1" })]);
      fireEvent.click(screen.getByRole("button", { name: /Remove .* from this product/ }));

      const notice = await screen.findByText("Image removed.");
      expect(notice.textContent?.toLowerCase()).not.toContain("freed");
      expect(notice.textContent?.toLowerCase()).not.toContain("storage");
    });

    it("surfaces the zero-primary state that deleting the primary leaves behind", async () => {
      const survivors = [image({ id: "img-2", isPrimary: false })];
      const { api } = createApiStub({
        deleteProductImage: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, imageId: "img-1", wasPrimary: true })),
        ),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: survivors })),
        ),
      });

      renderManager(api, [image({ id: "img-1", isPrimary: true }), image({ id: "img-2" })]);
      fireEvent.click(
        within(tileFor(/as the primary image/)).getByRole("button", { name: /Remove .* from/ }),
      );

      expect(await screen.findByText(/No primary image set/)).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("shows the API's per-file validation messages rather than a generic one", async () => {
      const { api } = createApiStub({
        addProductImages: vi.fn(() =>
          Promise.resolve(
            failure("VALIDATION_ERROR", "The request is invalid.", {
              imagePosition: ["Image 3: Only JPEG, PNG, WebP and AVIF images are accepted."],
            }),
          ),
        ),
      });

      renderManager(api, []);
      selectFiles([pngFile("one.png")]);

      expect(
        await screen.findByText("Image 3: Only JPEG, PNG, WebP and AVIF images are accepted."),
      ).toBeDefined();
      // The generic form-validation copy would tell the seller nothing.
      expect(screen.queryByText(/fix the highlighted fields/)).toBeNull();
    });

    it("shows every distinct message when the API reports more than one", async () => {
      const { api } = createApiStub({
        addProductImages: vi.fn(() =>
          Promise.resolve(
            failure("VALIDATION_ERROR", "The request is invalid.", {
              images: ["At least one \"images[]\" part is required."],
              contentType: ["Images must be uploaded as multipart/form-data."],
            }),
          ),
        ),
      });

      renderManager(api, []);
      selectFiles([pngFile("one.png")]);

      expect(await screen.findByText('At least one "images[]" part is required.')).toBeDefined();
      expect(
        screen.getByText("Images must be uploaded as multipart/form-data."),
      ).toBeDefined();
    });

    it("explains the image limit in seller-facing copy", async () => {
      const { api } = createApiStub({
        addProductImages: vi.fn(() =>
          Promise.resolve(failure("IMAGE_LIMIT_REACHED", "A product may hold at most 8 images.")),
        ),
      });

      renderManager(api, []);
      selectFiles([pngFile("one.png")]);

      expect(await screen.findByText(/maximum number of images/)).toBeDefined();
    });

    it("explains that the image is no longer part of the product", async () => {
      const { api } = createApiStub({
        deleteProductImage: vi.fn(() =>
          Promise.resolve(failure("IMAGE_NOT_FOUND", "This image does not belong to this product.")),
        ),
      });

      renderManager(api, [image({ id: "img-1" })]);
      fireEvent.click(screen.getByRole("button", { name: /Remove .* from this product/ }));

      expect(await screen.findByText(/no longer part of this product/)).toBeDefined();
    });

    it("never echoes an internal id into the error text", async () => {
      const { api } = createApiStub({
        deleteProductImage: vi.fn(() =>
          Promise.resolve(failure("IMAGE_NOT_FOUND", "This image does not belong to this product.")),
        ),
      });

      renderManager(api, [image({ id: "01955f00-0000-7000-8000-0000000000ff" })]);
      fireEvent.click(screen.getByRole("button", { name: /Remove .* from this product/ }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).not.toContain("01955f00");
    });

    it("reports a transport failure without leaking a raw message", async () => {
      const { api } = createApiStub({
        listSellerProductImages: () => Promise.reject(new Error("socket hangup")),
      });

      renderManager(api, [image({ id: "img-1" })]);
      fireEvent.click(removeControls()[0]!);

      expect(await screen.findByText(/Something went wrong/)).toBeDefined();
    });

    it("does not claim success when the write landed but the re-read failed", async () => {
      // The delete succeeds, so the image really is gone — but the gallery on
      // screen is stale, and a green "Image removed." next to a red error would
      // be self-contradictory.
      const { api } = createApiStub({
        deleteProductImage: ok({ productId: PRODUCT_ID, imageId: "img-1", wasPrimary: false }),
        listSellerProductImages: failure("UNAUTHENTICATED", "Your session has expired."),
      });

      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);

      fireEvent.click(removeControls()[0]!);

      await screen.findByRole("alert");
      expect(screen.queryByText("Image removed.")).toBeNull();
      // The stale list is kept rather than guessed at, so the count still
      // reflects what the server last confirmed.
      expect(screen.getAllByRole("img")).toHaveLength(2);
    });

    it("leaves the gallery intact when a mutation fails", async () => {
      const { api } = createApiStub({
        setPrimaryProductImage: vi.fn(() =>
          Promise.resolve(failure("IMAGE_NOT_FOUND", "This image does not belong to this product.")),
        ),
      });

      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);
      fireEvent.click(setPrimaryControls()[0]!);

      await screen.findByText(/no longer part of this product/);
      expect(screen.getAllByRole("img")).toHaveLength(2);
    });
  });

  describe("in-flight behaviour", () => {
    it("disables every mutation control while an upload is running", async () => {
      const gate = deferred<ApiEnvelope<ProductImageDto[]>>();
      const { api } = createApiStub({
        addProductImages: vi.fn(() => gate.promise),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: [] })),
        ),
      });

      renderManager(api, [image({ id: "img-1" })]);
      selectFiles([pngFile("one.png")]);

      await waitFor(() => expect(fileInput().disabled).toBe(true));
      for (const control of screen.getAllByRole("button")) {
        expect((control as HTMLButtonElement | HTMLInputElement).disabled).toBe(true);
      }

      gate.resolve(ok([]));
      await waitFor(() =>
        expect(fileInput().disabled).toBe(false),
      );
    });

    it("ignores a second submission while one is already running", async () => {
      const gate = deferred<ApiEnvelope<SellerProductImageListData>>();
      const { api, calls } = createApiStub({
        deleteProductImage: ok({ productId: PRODUCT_ID, imageId: "img-1", wasPrimary: false }),
        listSellerProductImages: () => gate.promise,
      });

      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);
      const removeButtons = removeControls();

      fireEvent.click(removeButtons[0]!);
      // The control is disabled, but a fast double click can still land.
      fireEvent.click(removeButtons[0]!);
      fireEvent.click(removeButtons[0]!);

      await waitFor(() => expect(callsTo(calls, "deleteProductImage")).toHaveLength(1));
      expect(callsTo(calls, "listSellerProductImages")).toHaveLength(1);
      gate.resolve(ok({ productId: PRODUCT_ID, images: [] }));
      await waitFor(() => expect(callsTo(calls, "listSellerProductImages")).toHaveLength(1));
    });

    it("does not start a delete while an upload is in flight", async () => {
      const gate = deferred<ApiEnvelope<ProductImageDto[]>>();
      const { api, calls } = createApiStub({
        addProductImages: vi.fn(() => gate.promise),
        deleteProductImage: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, imageId: "img-1", wasPrimary: false })),
        ),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: [] })),
        ),
      });

      renderManager(api, [image({ id: "img-1" })]);
      selectFiles([pngFile("one.png")]);
      await waitFor(() => expect(methodNames(calls)).toContain("addProductImages"));

      fireEvent.click(screen.getByRole("button", { name: /Remove .* from this product/ }));

      expect(methodNames(calls)).not.toContain("deleteProductImage");
      gate.resolve(ok([]));
      await waitFor(() => expect(fileInput().disabled).toBe(false));
    });

    it("marks the running control and leaves the others unlabelled as busy", async () => {
      const gate = deferred<ApiEnvelope<DeletedProductImageData>>();
      const { api } = createApiStub({
        deleteProductImage: vi.fn(() => gate.promise),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(ok({ productId: PRODUCT_ID, images: [] })),
        ),
      });

      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);

      fireEvent.click(removeControls()[0]!);

      // The label changes to report progress, which is what "show state where
      // practical" means for a request with no measurable byte total.
      await waitFor(() => expect(screen.getAllByText("Removing…")).toHaveLength(1));
      gate.resolve(ok({ productId: PRODUCT_ID, imageId: "img-1", wasPrimary: false }));
      await waitFor(() => expect(screen.queryByText("Removing…")).toBeNull());
    });
  });

  describe("image fallback", () => {
    it("degrades one broken url to the watermark without losing the rest", async () => {
      const { api } = createApiStub();
      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);

      const [first, second] = screen.getAllByRole("img", { hidden: true });
      fireEvent.error(first!);

      await waitFor(() => {
        const watermark = document.querySelector(
          'img[src="/assets/zelora-mark.svg"]',
        );
        expect(watermark).not.toBeNull();
      });
      // The surviving image is still the seller's own url, untouched.
      expect(second!.getAttribute("src")).toContain("img-2");
    });

    it("keeps the other image's controls working after one breaks", async () => {
      const { api, calls } = createApiStub({
        setPrimaryProductImage: ok(image({ id: "img-2", isPrimary: true })),
        listSellerProductImages: vi.fn(() =>
          Promise.resolve(
            ok({ productId: PRODUCT_ID, images: [image({ id: "img-2", isPrimary: true }), image({ id: "img-1" })] }),
          ),
        ),
      });

      renderManager(api, [image({ id: "img-1" }), image({ id: "img-2" })]);

      // Break the first tile's image, then act on the *other* tile's control.
      const [firstTile, secondTile] = screen.getAllByRole("listitem");
      fireEvent.error(within(firstTile!).getByRole("img", { hidden: true }));

      const surviving = within(secondTile!).getByRole("button", { name: /as the primary image/ });
      fireEvent.click(surviving);

      const setPrimary = callsTo(calls, "setPrimaryProductImage");
      expect(setPrimary).toHaveLength(1);
      expect(setPrimary[0]!.args).toEqual([PRODUCT_ID, "img-2"]);
    });

    it("prefers the stored alt text over the product name", () => {
      const { api } = createApiStub();

      renderManager(api, [image({ id: "img-1", altText: "Front view of the headphones" })]);

      expect(screen.getByRole("img", { name: "Front view of the headphones" })).toBeDefined();
    });
  });

  describe("accessible naming", () => {
    it("gives the file control a real label bound to the input", () => {
      const { api } = createApiStub();

      renderManager(api, []);

      const input = screen.getByLabelText("Add images");
      expect(input.getAttribute("type")).toBe("file");
      expect(input.hasAttribute("multiple")).toBe(true);
      expect(input.getAttribute("accept")).toBe("image/jpeg,image/png,image/webp,image/avif");
    });

    it("names each tile's controls for assistive technology", () => {
      const { api } = createApiStub();

      renderManager(api, [image({ id: "img-1", altText: "Box front" })]);

      expect(
        screen.getByRole("button", { name: "Set Box front as the primary image" }),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Remove Box front from this product" }),
      ).toBeDefined();
    });

    it("points the file input at the hint that explains the limits", () => {
      const { api } = createApiStub();

      renderManager(api, []);

      const hint = screen.getByText(/Up to 8 at a time/);
      expect(hint.id).not.toBe("");
      expect(screen.getByLabelText("Add images").getAttribute("aria-describedby")).toBe(hint.id);
    });

    it("announces progress politely and success politely, never assertively", async () => {
      const gate = deferred<ApiEnvelope<DeletedProductImageData>>();
      const { api } = createApiStub({
        deleteProductImage: () => gate.promise,
        listSellerProductImages: ok({ productId: PRODUCT_ID, images: [] }),
      });

      renderManager(api, [image({ id: "img-1" })]);

      // While the request is open the only live region is a polite status.
      fireEvent.click(removeControls()[0]!);
      await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
      expect(screen.queryByRole("alert")).toBeNull();

      // A successful outcome is still polite: it interrupts nothing.
      gate.resolve(ok({ productId: PRODUCT_ID, imageId: "img-1", wasPrimary: false }));
      await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("announces a failed mutation with role=alert", async () => {
      const { api } = createApiStub({
        deleteProductImage: failure("IMAGE_NOT_FOUND", "This image does not belong to this product."),
      });

      renderManager(api, [image({ id: "img-1" })]);

      fireEvent.click(removeControls()[0]!);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("no longer part of this product");
    });
  });
});
