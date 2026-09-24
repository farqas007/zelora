import { Hono } from "hono";
import type { StorefrontDto } from "@zelora/shared";
import type { CatalogService } from "../services/catalog";

/**
 * Public storefront route mounted at `/api` (subpath `/stores/:slug`).
 *
 * Like the catalog routes this is anonymous-by-design: no session, CSRF or
 * IP-rate-limit middleware applies. The read is bounded (single store, keyset
 * pagination, capped page size) and only surfaces an `active` store's public
 * identity plus its published products — 404s surface through the error
 * boundary. The store slug is handed to the service raw, matching the product
 * detail route; slugs are always stored lowercase so an uppercase URL simply
 * resolves to nothing.
 *
 * Edge-compatible: only the service contract is referenced here; repository
 * details live behind it and outside this module.
 */

export interface StorefrontRoutesDependencies {
  catalogService: CatalogService;
}

export function createStorefrontRoutes(dependencies: StorefrontRoutesDependencies): Hono {
  const { catalogService } = dependencies;
  const app = new Hono();

  app.get("/stores/:slug", async (c) => {
    const data: StorefrontDto = await catalogService.getStorefront(
      c.req.param("slug"),
      c.req.query(),
    );
    return c.json({ ok: true, data });
  });

  return app;
}