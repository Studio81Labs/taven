import { publicSite } from "../content/public-site";
import { canonicalTitle, canonicalUrl } from "../utils/site-meta";

interface PublicPageMeta {
  description: string;
  noindex?: boolean;
  path: string;
  title?: string;
}

export function usePublicPageMeta({
  description,
  noindex = false,
  path,
  title,
}: PublicPageMeta): void {
  const config = useRuntimeConfig();
  const fullTitle = canonicalTitle(title, publicSite.brand.name);
  const url = canonicalUrl(config.public.siteUrl, path);

  useSeoMeta({
    title: fullTitle,
    description,
    ogDescription: description,
    ogTitle: fullTitle,
    ogType: "website",
    ogUrl: url,
    robots: noindex ? "noindex, nofollow" : "index, follow",
    twitterCard: "summary",
  });
  useHead({
    htmlAttrs: { lang: "cs" },
    link: [{ rel: "canonical", href: url }],
  });
}
