import { canonicalUrl } from "../../utils/site-meta";

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event);
  setResponseHeader(event, "content-type", "text/plain; charset=utf-8");

  if (config.public.deploymentEnvironment === "staging") {
    return ["User-agent: *", "Disallow: /", ""].join("\n");
  }

  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /objednavka",
    "Disallow: /poptavka",
    `Sitemap: ${canonicalUrl(config.public.siteUrl, "/sitemap.xml")}`,
    "",
  ].join("\n");
});
