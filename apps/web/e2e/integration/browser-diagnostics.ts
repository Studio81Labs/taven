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
      const surfaces = [...urls, ...messages];
      expect(urls.length).toBeGreaterThan(0);
      expect(
        surfaces.some((value) =>
          needles.some((needle) => value.includes(needle)),
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
