const LOCAL_SITE_ORIGIN = "http://localhost:3000";

export function canonicalTitle(
  page: string | undefined,
  brand = "Taven",
): string {
  return page ? `${page} · ${brand}` : brand;
}

export function normalizeSiteOrigin(value: string | undefined): string {
  if (value === undefined) return LOCAL_SITE_ORIGIN;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError();
    }
    return url.origin;
  } catch (error) {
    throw new TypeError("NUXT_PUBLIC_SITE_URL must be a valid HTTP(S) URL.", {
      cause: error,
    });
  }
}

export function canonicalUrl(
  siteOrigin: string | undefined,
  path: string,
): string {
  const origin = normalizeSiteOrigin(siteOrigin);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalizedPath, `${origin}/`).toString();
}
