import { canonicalUrl } from "../../utils/site-meta";

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event);
  setResponseHeader(event, "content-type", "text/plain; charset=utf-8");

  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /objednavka",
    "Disallow: /poptavka",
    "Disallow: /vop",
    "Disallow: /reklamace",
    "Disallow: /ochrana-soukromi",
    `Sitemap: ${canonicalUrl(config.public.siteUrl, "/sitemap.xml")}`,
    "",
  ].join("\n");
});
