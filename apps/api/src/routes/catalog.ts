import { Hono } from "hono";
import type { CatalogCategoryDto, CatalogProductDetailDto } from "@zelora/shared";
import type { CatalogService, ListProductsResultData } from "../services/catalog";

/**
 * Public catalog routes mounted at `/api` (subpaths `/categories` and
 * `/products[/:slug]`).
 *
 * These are the storefront's only unauthenticated reads. No session, CSRF or
 * IP-rate-limit middleware applies: the catalog is anonymous-by-design and
 * the queries are constrained (keyset pagination, capped page size) so a
 * bounded read workload cannot bloat the database. The route only reads query
 * parameters, delegates to the injected {@link CatalogService}, and returns
 * the shared envelopes — 404s surface through the error boundary.
 *
 * Edge-compatible: only the service contract is referenced here; repository
 * details live behind it and outside this module.
 */

export interface CatalogRoutesDependencies {
  catalogService: CatalogService;
}

export function createCatalogRoutes(dependencies: CatalogRoutesDependencies): Hono {
  const { catalogService } = dependencies;
  const app = new Hono();

  app.get("/categories", async (c) => {
    const data: CatalogCategoryDto[] = await catalogService.listCategories();
    return c.json({ ok: true, data });
  });

  app.get("/products", async (c) => {
    const query = c.req.query();
    const data: ListProductsResultData = await catalogService.listProducts(query);
    return c.json({ ok: true, data });
  });

  app.get("/products/:slug", async (c) => {
    const data: CatalogProductDetailDto = await catalogService.getProductBySlug(
      c.req.param("slug"),
    );
    return c.json({ ok: true, data });
  });

  return app;
}