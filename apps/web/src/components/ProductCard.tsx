import { Link } from "react-router-dom";
import type { CatalogProductSummaryDto } from "@zelora/shared";
import { formatCents } from "../lib/format";

/**
 * Storefront card for a {@link CatalogProductSummaryDto}. The whole card is a
 * link to the product detail page so customers can tap anywhere on it.
 */
export function ProductCard({ product }: { product: CatalogProductSummaryDto }) {
  const price =
    product.priceAmountCents !== null && product.currency !== null
      ? formatCents(product.priceAmountCents, product.currency)
      : "Sold out";

  return (
    <Link className="product-card" to={`/catalog/products/${product.slug}`}>
      <div className="product-media">
        {product.image !== null ? (
          <img
            className="product-image"
            src={product.image.url}
            alt={product.image.altText ?? product.name}
            loading="lazy"
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