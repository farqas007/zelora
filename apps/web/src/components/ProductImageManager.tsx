import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { PRODUCT_IMAGE_LIMITS, type ProductImageDto } from "@zelora/shared";
import type { ZeloraApi } from "../lib/api/client";
import { describeImageEnvelope, describeImageFailure } from "../lib/images/errors";
import {
  IMAGE_ACCEPT_ATTRIBUTE,
  MAX_BYTES_PER_FILE_LABEL,
  remainingImageCapacity,
  validateImageSelection,
} from "../lib/images/validation";

/**
 * Seller-facing management UI for one product's image gallery.
 *
 * ### One rule governs the state: the server's order is the only order
 *
 * `images` is held exactly as the API last returned it and is never sorted,
 * filtered or re-ordered locally. Every successful mutation ends with either
 * the rows the mutation returned or a fresh canonical `GET`, and that array
 * replaces state wholesale. That is what keeps "the gallery shows what the
 * storefront shows" true: the API decides display order (primary first, then
 * `sortOrder`, then id) and a client that second-guessed it would drift.
 *
 * Set-primary and delete are followed by a `GET` even though each returns
 * something — the primary response is one row, and the delete response is a
 * bare acknowledgement. Re-reading is one small request and makes the
 * canonical-order guarantee structural rather than a thing to remember.
 *
 * ### Zero primary images is a real state
 *
 * An upload never sets a primary, and deleting the primary does not promote a
 * replacement, so a gallery can hold images with *no* primary at all. That is
 * surfaced as its own message rather than being left to look like a rendering
 * bug. Correspondingly, nothing here assumes `images[0]` is the primary.
 *
 * Reordering is deliberately absent: it is a separate phase, and adding the
 * controls now would imply an order the UI cannot yet justify changing.
 */
export interface ProductImageManagerProps {
  /** The signed-in seller's API client, taken from `useAuth()`. */
  api: ZeloraApi;
  productId: string;
  productName: string;
  /** Canonical image order as delivered by `getSellerProduct`. */
  initialImages: ProductImageDto[];
}

/** Which mutation, if any, is in flight. One value, so they cannot overlap. */
type PendingOperation =
  | { kind: "none" }
  | { kind: "upload"; fileCount: number }
  | { kind: "primary"; imageId: string }
  | { kind: "delete"; imageId: string };

const NO_PENDING: PendingOperation = { kind: "none" };

/** True while any mutation is running; every control is disabled on it. */
function isBusy(pending: PendingOperation): boolean {
  return pending.kind !== "none";
}

export function ProductImageManager({
  api,
  productId,
  productName,
  initialImages,
}: ProductImageManagerProps) {
  const [images, setImages] = useState<readonly ProductImageDto[]>(initialImages);
  const [pending, setPending] = useState<PendingOperation>(NO_PENDING);
  // Mirrors `pending`, written synchronously. React does commit between two
  // discrete events, so the state alone would almost always do; this keeps the
  // overlap guard from depending on that flushing discipline holding.
  const pendingRef = useRef<PendingOperation>(NO_PENDING);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [failedImageIds, setFailedImageIds] = useState<ReadonlySet<string>>(() => new Set());

  const fileInputId = useId();

  // A different product must start from its own images, not the previous
  // product's gallery, and must not inherit a failed-URL or error state.
  // Keyed on the id alone so a mutation's own `initialImages` update — the
  // detail page holds a fixed prop — cannot re-run this and discard a mutation
  // result mid-flight.
  useEffect(() => {
    setImages(initialImages);
    setFailedImageIds(new Set());
    setErrors([]);
    setNotice(null);
  }, [productId, initialImages]);

  const busy = isBusy(pending);
  const remaining = remainingImageCapacity(images.length);
  const atCapacity = remaining === 0;
  const hasPrimary = images.some((image) => image.isPrimary);

  /**
   * Re-read the canonical gallery.
   *
   * The single place state is reconciled against the server after a mutation
   * that did not itself return the full ordered list. A failure here is
   * reported but does not roll anything back: the mutation already succeeded, so
   * the honest message is that the gallery could not be refreshed, not that the
   * action failed.
   */
  async function reloadCanonicalImages(): Promise<boolean> {
    const envelope = await api.listSellerProductImages(productId);
    if (envelope.ok) {
      setImages(envelope.data.images);
      return true;
    }
    // The write landed but the read did not, so the notice is replaced by the
    // refresh failure. Claiming success next to an error the seller can see
    // would be contradictory.
    setNotice(null);
    setErrors(describeImageEnvelope(envelope.error));
    return false;
  }

  /** Run one mutation, guarding against overlap and reporting its failure. */
  async function runMutation(
    operation: PendingOperation,
    action: () => Promise<void>,
  ): Promise<void> {
    // The ref rather than `pending`, so the guard cannot be bypassed by two
    // actions starting before React re-renders.
    if (isBusy(pendingRef.current)) {
      return;
    }
    pendingRef.current = operation;
    setErrors([]);
    setNotice(null);
    setPending(operation);
    try {
      await action();
    } catch (cause) {
      setErrors(describeImageFailure(cause));
    } finally {
      pendingRef.current = NO_PENDING;
      setPending(NO_PENDING);
    }
  }

  function onSelectFiles(event: ChangeEvent<HTMLInputElement>): void {
    const selection = Array.from(event.target.files ?? []);
    // Clear the native input immediately: selecting the same file twice in a
    // row must fire `change` again, and the browser only re-emits it when the
    // value actually changes.
    event.target.value = "";
    if (selection.length === 0) {
      return;
    }

    const validation = validateImageSelection(selection, images.length);
    if (!validation.ok) {
      setErrors([validation.message]);
      setNotice(null);
      return;
    }

    void runMutation({ kind: "upload", fileCount: validation.files.length }, async () => {
      const envelope = await api.addProductImages(productId, validation.files);
      if (!envelope.ok) {
        setErrors(describeImageEnvelope(envelope.error));
        return;
      }
      // The endpoint returns the rows it created, in submitted order — which is
      // not the gallery order. Appending would place them at the end of a list
      // sorted by `sortOrder`, so the canonical read is used instead of
      // guessing; the server is the only thing that knows where a new image
      // lands relative to a promoted one.
      if (!(await reloadCanonicalImages())) {
        return;
      }
      setNotice(
        `Added ${validation.files.length} ${validation.files.length === 1 ? "image" : "images"}.`,
      );
    });
  }

  function onSetPrimary(image: ProductImageDto): void {
    void runMutation({ kind: "primary", imageId: image.id }, async () => {
      const envelope = await api.setPrimaryProductImage(productId, image.id);
      if (!envelope.ok) {
        setErrors(describeImageEnvelope(envelope.error));
        return;
      }
      if (!(await reloadCanonicalImages())) {
        return;
      }
      setNotice("Primary image updated.");
    });
  }

  function onDeleteImage(image: ProductImageDto): void {
    void runMutation({ kind: "delete", imageId: image.id }, async () => {
      const envelope = await api.deleteProductImage(productId, image.id);
      if (!envelope.ok) {
        setErrors(describeImageEnvelope(envelope.error));
        return;
      }
      if (!(await reloadCanonicalImages())) {
        return;
      }
      // Deliberately says the image was removed from the product and nothing
      // more: the delete takes the reference, while the stored bytes are left
      // in place for a later reclamation step, and claiming otherwise would
      // promise something the API does not do.
      setNotice(image.isPrimary ? "Primary image removed from this product." : "Image removed.");
    });
  }

  return (
    <section className="user-card" aria-labelledby="images-heading">
      <div className="section-heading">
        <h2 id="images-heading">Images</h2>
        <span className="muted">
          {images.length} of {PRODUCT_IMAGE_LIMITS.maxPerProduct}
        </span>
      </div>

      {images.length > 0 && !hasPrimary && (
        <p className="image-manager-nudge" role="status">
          No primary image set. Choose an image below to set it as the one shown
          first across the marketplace.
        </p>
      )}

      {errors.length > 0 && (
        <div className="form-alert" role="alert">
          {errors.map((message) => (
            <p key={message} className="image-manager-alert-line">
              {message}
            </p>
          ))}
        </div>
      )}

      {notice !== null && (
        <p className="form-success" role="status">
          {notice}
        </p>
      )}

      {images.length === 0 ? (
        <p className="muted">No images have been added yet.</p>
      ) : (
        <ul className="seller-image-grid">
          {images.map((image) => {
            const failed = failedImageIds.has(image.id);
            return (
              <li key={image.id} className="seller-image-tile">
                <div className="seller-image-frame">
                  {failed ? (
                    <img
                      className="product-watermark"
                      src="/assets/zelora-mark.svg"
                      alt=""
                      aria-hidden="true"
                      width="96"
                      height="96"
                    />
                  ) : (
                    <img
                      className="seller-image-img"
                      src={image.url}
                      alt={image.altText ?? `${productName} image`}
                      loading="lazy"
                      onError={() =>
                        setFailedImageIds((current) => new Set(current).add(image.id))
                      }
                    />
                  )}
                </div>

                <div className="seller-image-meta">
                  {image.isPrimary ? <span className="badge">Primary</span> : null}
                </div>

                <div className="image-manager-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onSetPrimary(image)}
                    disabled={busy || image.isPrimary}
                    aria-label={`Set ${image.altText ?? "this image"} as the primary image`}
                  >
                    {pending.kind === "primary" && pending.imageId === image.id
                      ? "Setting…"
                      : "Set primary"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm image-manager-delete"
                    onClick={() => onDeleteImage(image)}
                    disabled={busy}
                    aria-label={`Remove ${image.altText ?? "this image"} from this product`}
                  >
                    {pending.kind === "delete" && pending.imageId === image.id
                      ? "Removing…"
                      : "Remove"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="image-manager-upload">
        {/* A real label bound to a real file input, rather than a hidden input
            behind a styled element: the control stays focusable, announces its
            own name and can be operated by keyboard and by assistive
            technology with no extra ARIA to keep in sync. */}
        <label className="image-manager-upload-label" htmlFor={fileInputId}>
          Add images
        </label>
        <input
          id={fileInputId}
          className="image-manager-file"
          type="file"
          accept={IMAGE_ACCEPT_ATTRIBUTE}
          multiple
          disabled={busy || atCapacity}
          onChange={onSelectFiles}
          aria-describedby={`${fileInputId}-hint`}
        />
        <p id={`${fileInputId}-hint`} className="field-hint">
          {atCapacity
            ? `This product has the maximum of ${PRODUCT_IMAGE_LIMITS.maxPerProduct} images. Remove one to add another.`
            : `Up to ${PRODUCT_IMAGE_LIMITS.maxFilesPerRequest} at a time, ${MAX_BYTES_PER_FILE_LABEL} each, in JPEG, PNG, WebP or AVIF format. ${
                remaining === 1 ? "1 image" : `${remaining} images`
              } can still be added.`}
        </p>
      </div>
    </section>
  );
}
