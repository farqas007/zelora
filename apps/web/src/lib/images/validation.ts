/**
 * Client-side pre-flight validation for a seller's image selection.
 *
 * ### What this is, and what it is not
 *
 * This module exists to save a seller a pointless round trip: it refuses a
 * selection that the API is certain to reject anyway, before the bytes are
 * read. It is **UX, not a security boundary**. The API re-derives every one of
 * these decisions server-side — including the ones that cannot be checked here
 * at all, such as whether a file's *bytes* are really a supported image
 * (see `services/media/image-validation.ts`, which sniffs magic bytes and
 * ignores the declared MIME type entirely). A file that passes every check in
 * this module can still be refused with a 422, and that answer is the real one.
 *
 * The one check that genuinely cannot be mirrored is content format: a browser
 * `File.type` is client-declared metadata, so it is used here only to *reject
 * obvious mismatches early*, never to decide what is uploadable. `.tiff` can
 * therefore never be selected, while a `.jpg` renamed to `.png` still gets as
 * far as the server and is correctly refused there.
 *
 * Every number is read from `PRODUCT_IMAGE_LIMITS` in `@zelora/shared` rather
 * than written out here, so the frontend cannot drift from the contract the API
 * enforces.
 */
import { PRODUCT_IMAGE_CONTENT_TYPES, PRODUCT_IMAGE_LIMITS } from "@zelora/shared";

/**
 * Browser-declared MIME types offered to the seller's file picker.
 *
 * Derived from the API's verified content-type list, so the picker filters with
 * exactly the four formats the API will accept. Mirrors a MIME type, and
 * filters nothing on its own: the `accept` attribute is a convenience, which is
 * why {@link validateImageSelection} re-checks {@link File.type} anyway.
 */
export const IMAGE_ACCEPT_ATTRIBUTE = PRODUCT_IMAGE_CONTENT_TYPES.join(",");

/** The outcome of validating one selection. */
export type ImageSelectionValidation =
  | { ok: true; files: File[] }
  | { ok: false; message: string };

/**
 * How many images the product can still accept, never below zero.
 *
 * Clamped at zero so a gallery that is somehow already at the cap reports
 * "0 remaining" rather than a negative number a seller would have to interpret.
 */
export function remainingImageCapacity(currentCount: number): number {
  return Math.max(0, PRODUCT_IMAGE_LIMITS.maxPerProduct - currentCount);
}

/**
 * Label one rejected file, preferring its name and falling back to its
 * position so an unnamed or synthetic `File` is still identifiable.
 */
function labelFile(file: File, index: number, total: number): string {
  return file.name === "" ? `Image ${index + 1} of ${total}` : `"${file.name}"`;
}

/** The byte cap rendered for sellers, from the shared limit rather than a copy. */
export const MAX_BYTES_PER_FILE_LABEL = `${(
  PRODUCT_IMAGE_LIMITS.maxBytesPerFile / (1024 * 1024)
).toFixed(2)} MiB`;

/**
 * Validate a selection against both the request cap and the product's
 * remaining capacity.
 *
 * Order is chosen for the seller rather than for the code: the two capacity
 * checks run first, because they are the ones a seller can fix by *choosing
 * fewer files*, and doing them first means an over-large selection is never
 * reported as a per-file problem. Only then is each file inspected.
 *
 * Per-file checks run in the same order the API uses — emptiness, then size,
 * then declared type — so the message a seller reads here matches the one they
 * would have received from the server. The size comparison uses `>` rather than
 * `>=` because the cap is **inclusive**: a file of exactly
 * {@link PRODUCT_IMAGE_LIMITS.maxBytesPerFile} bytes is accepted.
 *
 * The first failing file wins and the rest of the selection is not reported
 * again: re-validating after a fix is immediate, whereas a list of every
 * problem is a list the seller has to read and match up against their files.
 */
export function validateImageSelection(
  selection: readonly File[],
  currentCount: number,
): ImageSelectionValidation {
  const ordered = [...selection];

  if (ordered.length === 0) {
    return { ok: false, message: "Choose at least one image to upload." };
  }

  if (ordered.length > PRODUCT_IMAGE_LIMITS.maxFilesPerRequest) {
    return {
      ok: false,
      message: `You can upload at most ${PRODUCT_IMAGE_LIMITS.maxFilesPerRequest} images at a time. You selected ${ordered.length}.`,
    };
  }

  const remaining = remainingImageCapacity(currentCount);
  if (ordered.length > remaining) {
    return {
      ok: false,
      message:
        remaining === 0
          ? `This product already has ${PRODUCT_IMAGE_LIMITS.maxPerProduct} images, which is the maximum. Delete an image before adding another.`
          : `This product can hold ${PRODUCT_IMAGE_LIMITS.maxPerProduct} images and already has ${currentCount}, so you can add ${remaining} more. You selected ${ordered.length}.`,
    };
  }

  for (const [index, file] of ordered.entries()) {
    if (file.size === 0) {
      return {
        ok: false,
        message: `${labelFile(file, index, ordered.length)} is empty. Choose a different file.`,
      };
    }
    if (file.size > PRODUCT_IMAGE_LIMITS.maxBytesPerFile) {
      return {
        ok: false,
        message: `${labelFile(file, index, ordered.length)} is larger than the ${MAX_BYTES_PER_FILE_LABEL} limit.`,
      };
    }
    if (file.type !== "" && !isSupportedDeclaredType(file.type)) {
      return {
        ok: false,
        message: `${labelFile(file, index, ordered.length)} is not a supported image. Choose a JPEG, PNG, WebP or AVIF file.`,
      };
    }
  }

  return { ok: true, files: ordered };
}

/**
 * Whether a browser-declared MIME type is one the API accepts.
 *
 * The comparison is case-insensitive because browsers are inconsistent about
 * the casing of `File.type`, and the parameter of a value like
 * `image/PNG` is not always stripped. An empty type is treated as *unknown*
 * rather than unsupported: some browsers and some drag sources report no type
 * at all, and refusing those would block a file the server sniffs perfectly
 * well.
 */
function isSupportedDeclaredType(type: string): boolean {
  const normalized = type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized === "") {
    return true;
  }
  return (PRODUCT_IMAGE_CONTENT_TYPES as readonly string[]).includes(normalized);
}
