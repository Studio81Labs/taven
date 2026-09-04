const LOCAL_SITE_ORIGIN = "http://localhost:3000";

export function canonicalTitle(
  page: string | undefined,
  brand = "Taven",
): string {
  return page ? `${page} · ${brand}` : brand;
}

export function normalizeSiteOrigin(value: string | undefined): string {
  if (!value) return LOCAL_SITE_ORIGIN;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return LOCAL_SITE_ORIGIN;
    }
    return url.origin;
  } catch {
    return LOCAL_SITE_ORIGIN;
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
