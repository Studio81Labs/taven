import { createTavenApiClient } from "@taven/openapi-client";
import { indexablePublicRoutes } from "../../content/public-site";
import { canonicalUrl } from "../../utils/site-meta";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  setResponseHeader(event, "content-type", "application/xml; charset=utf-8");
  setResponseHeader(event, "cache-control", "no-store");

  const availability = await Promise.race([
    createTavenApiClient({ baseUrl: config.apiBaseUrl })
      .GET("/legal-documents/availability")
      .then((response) => response.data),
    new Promise<undefined>((resolve) => setTimeout(resolve, 1_000)),
  ]).catch(() => undefined);

  const urls = indexablePublicRoutes(availability)
    .map(
      (path) =>
        `  <url><loc>${canonicalUrl(config.public.siteUrl, path)}</loc></url>`,
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
    "",
  ].join("\n");
});
