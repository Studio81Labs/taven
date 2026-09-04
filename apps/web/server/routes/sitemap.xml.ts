import { indexablePublicRoutes } from "../../content/public-site";
import { canonicalUrl } from "../../utils/site-meta";

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event);
  setResponseHeader(event, "content-type", "application/xml; charset=utf-8");

  const urls = indexablePublicRoutes
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
