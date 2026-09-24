import { expect, type Page } from "@playwright/test";

/** Keep raw browser diagnostics in memory only; assertions emit booleans, not secrets. */
export function observeBrowserDiagnostics(page: Page) {
  const urls: string[] = [];
  const messages: string[] = [];
  const observationBodies: unknown[] = [];

  page.on("request", (request) => {
    const url = request.url();
    urls.push(url);
    if (
      request.method() === "POST" &&
      new URL(url).pathname.endsWith("/observations")
    ) {
      try {
        observationBodies.push(JSON.parse(request.postData() ?? "null"));
      } catch {
        observationBodies.push(null);
      }
    }
  });
  page.on("console", (message) => messages.push(message.text()));
  page.on("pageerror", (error) => messages.push(error.message));

  return {
    observationBodies: () => [...observationBodies],
    assertSanitized(
      markers: readonly string[],
      allowedOrigins: readonly string[],
    ) {
      const needles = markers.filter(Boolean);
      expect(urls.length).toBeGreaterThan(0);
      const decodedUrls = urls.map((url) => {
        try {
          // Browser URL serialization percent-encodes text and may use + for
          // spaces in query values. Inspect both representations.
          return decodeURIComponent(url.replace(/\+/g, "%20"));
        } catch {
          return null;
        }
      });
      expect(decodedUrls.every((url) => url !== null)).toBe(true);
      const surfaces = [...urls, ...decodedUrls, ...messages];
      expect(
        surfaces.some(
          (value) =>
            value !== null && needles.some((needle) => value.includes(needle)),
        ),
      ).toBe(false);
      const origins = new Set(allowedOrigins);
      expect(
        urls
          .filter((url) => /^https?:\/\//.test(url))
          .every((url) => origins.has(new URL(url).origin)),
      ).toBe(true);
    },
  };
}
