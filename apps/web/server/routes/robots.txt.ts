import { canonicalUrl } from "../../utils/site-meta";
import { isProductionDeployment } from "../../utils/deployment-environment";

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event);
  setResponseHeader(event, "content-type", "text/plain; charset=utf-8");

  if (!isProductionDeployment(config.public.deploymentEnvironment)) {
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
