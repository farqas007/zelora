import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CatalogProductSummaryDto } from "@zelora/shared";
import { formatCents } from "../lib/format";

/**
 * Storefront card for a {@link CatalogProductSummaryDto}. The whole card is a
 * link to the product detail page so customers can tap anywhere on it.
 *
 * A product with no image falls back to the Zelora watermark. The same
 * fallback covers an image row whose URL cannot be loaded (a dead or mistyped
 * seller-supplied URL), so a failed fetch degrades to the placeholder instead of
 * leaving a broken image in the grid.
 */
export function ProductCard({ product }: { product: CatalogProductSummaryDto }) {
  const imageUrl = product.image?.url ?? null;
  const [imageFailed, setImageFailed] = useState(false);

  // Reset when the card is reused for a different image so a previously failed
  // URL does not suppress the next product's artwork.
  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);

  const price =
    product.priceAmountCents !== null && product.currency !== null
      ? formatCents(product.priceAmountCents, product.currency)
      : "Sold out";

  return (
    <Link className="product-card" to={`/catalog/products/${product.slug}`}>
      <div className="product-media">
        {imageUrl !== null && !imageFailed ? (
          <img
            className="product-image"
            src={imageUrl}
            alt={product.image!.altText ?? product.name}
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <img
            className="product-watermark"
            src="/assets/zelora-mark.svg"
            alt=""
            aria-hidden="true"
            width="96"
            height="96"
          />
        )}
      </div>
      <div className="product-body">
        <span className="product-store">{product.store.name}</span>
        <h3 className="product-title">{product.name}</h3>
        <p className="product-description">{product.description}</p>
        <span className="product-price">{price}</span>
      </div>
    </Link>
  );
}