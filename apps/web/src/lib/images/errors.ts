/**
 * Turns a failed seller image-management call into copy a seller can act on.
 *
 * This deliberately does **not** reuse `lib/auth/errors.ts`, whose
 * `resolveApiFailure` collapses every `VALIDATION_ERROR` to the single generic
 * "Please fix the highlighted fields and try again." That is the right call for
 * a text form, where the detail is rendered next to the offending field — but
 * an upload is a batch of files that has no fields to point at, and the API's
 * per-file messages are the only thing that tells the seller *which* of their
 * eight files was refused. Discarding them here would throw away the most
 * useful sentence in the whole response, so the field messages are preserved
 * verbatim and shown instead.
 *
 * Internal identifiers are never echoed into seller-facing text. The API's
 * messages already describe ids as "this image" rather than naming them, and
 * this module adds nothing that would undo that.
 */
import { SELLER_PRODUCT_ERROR_CODES, type ApiErrorBody } from "@zelora/shared";
import { ApiClientError, ApiFailureError } from "../api/client";

/** The one sentence shown when a failure has nothing more specific to say. */
const GENERIC_MESSAGE = "Something went wrong. Please try again.";

const NETWORK_MESSAGE =
  "Unable to reach the server. Please check your connection and try again.";

/**
 * Seller-facing copy for the image error codes the shared vocabulary defines.
 *
 * `IMAGE_NOT_FOUND` is worth spelling out rather than passing the API's message
 * through: it means the image is no longer part of this product, which the
 * seller cannot have caused by clicking the wrong thing in this UI, so the
 * useful instruction is "reload the gallery" rather than anything about the
 * image itself. The detail is deliberately hidden — the code exists to avoid
 * disclosing whether an image id belongs to someone else's product.
 */
const IMAGE_ERROR_MESSAGES: Partial<Record<string, string>> = {
  [SELLER_PRODUCT_ERROR_CODES.IMAGE_LIMIT_REACHED]:
    "This product already has the maximum number of images. Delete an image before adding another.",
  [SELLER_PRODUCT_ERROR_CODES.IMAGE_NOT_FOUND]:
    "That image is no longer part of this product. Reload the gallery to see its current images.",
};

/** The message to show for a non-validation failure, given its code. */
function messageForCode(code: string, apiMessage: string): string {
  return IMAGE_ERROR_MESSAGES[code] ?? apiMessage;
}

/**
 * The API's per-field messages, flattened into displayable sentences.
 *
 * Preserves every entry rather than taking the first, because a batch upload can
 * fail in more than one way at once and the seller is better served by the full
 * list. Object key order follows insertion order, so the API's own field order
 * is what they see.
 */
function fieldMessages(fields: Record<string, string[]> | undefined): string[] {
  if (fields === undefined) {
    return [];
  }
  return Object.values(fields)
    .flatMap((messages) => messages)
    .filter((message) => message.trim() !== "");
}

/**
 * Resolve an API failure — a `VALIDATION_ERROR` body — into what to display.
 *
 * Accepts the plain {@link ApiErrorBody} a returned envelope carries, so the
 * same mapping serves both ways a failure reaches this module: the envelope
 * branches on the client's own calls and the {@link ApiFailureError} its
 * transport throws. Returning an array rather than a single string lets the
 * alert render every distinct problem instead of hiding all but one.
 */
export function describeImageEnvelope(error: ApiErrorBody): string[] {
  const specific = fieldMessages(error.fields);
  if (specific.length > 0) {
    return specific;
  }
  if (error.code === "VALIDATION_ERROR") {
    // A validation failure with no field messages carries no detail worth
    // showing, so the generic stands in for the API's own "The request is
    // invalid." rather than leaking a message that says nothing.
    return [GENERIC_MESSAGE];
  }
  return [messageForCode(error.code, error.message)];
}

/**
 * Resolve any failure from an image-management call into what to display:
 * `messages` is the full set worth showing, most specific first.
 */
export function describeImageFailure(error: unknown): string[] {
  if (error instanceof ApiFailureError) {
    return describeImageEnvelope({
      code: error.code,
      message: error.message,
      details: error.details,
      fields: error.fields,
    });
  }
  if (error instanceof ApiClientError) {
    return [NETWORK_MESSAGE];
  }
  return [GENERIC_MESSAGE];
}
