import { publicSite } from "../content/public-site";
import { canonicalTitle, canonicalUrl } from "../utils/site-meta";
import { toValue, type MaybeRefOrGetter } from "vue";

interface PublicPageMeta {
  description: MaybeRefOrGetter<string>;
  noindex?: MaybeRefOrGetter<boolean>;
  path: string;
  title?: MaybeRefOrGetter<string>;
}

export function usePublicPageMeta({
  description,
  noindex = false,
  path,
  title,
}: PublicPageMeta): void {
  const config = useRuntimeConfig();
  const stagingDeployment = config.public.deploymentEnvironment === "staging";
  const resolvedTitle = computed(() =>
    canonicalTitle(
      title === undefined ? undefined : toValue(title),
      publicSite.brand.name,
    ),
  );
  const resolvedDescription = computed(() => toValue(description));
  const url = canonicalUrl(config.public.siteUrl, path);

  useSeoMeta({
    title: resolvedTitle,
    description: resolvedDescription,
    ogDescription: resolvedDescription,
    ogTitle: resolvedTitle,
    ogType: "website",
    ogUrl: url,
    robots: computed(() =>
      toValue(noindex) || stagingDeployment
        ? "noindex, nofollow"
        : "index, follow",
    ),
    twitterCard: "summary",
  });
  useHead({
    htmlAttrs: { lang: "cs" },
    link: [{ rel: "canonical", href: url }],
  });
}
