import { describe, expect, it } from "vitest";
import { publicSiteUrl } from "./payments.service";

describe("payment return site URL", () => {
  it("requires an explicitly configured HTTPS origin in production", () => {
    expect(() => publicSiteUrl({ NODE_ENV: "production" })).toThrow(
      "TAVEN_PUBLIC_SITE_URL is required in production",
    );
    expect(() =>
      publicSiteUrl({
        NODE_ENV: "production",
        TAVEN_PUBLIC_SITE_URL: "http://taven.cz",
      }),
    ).toThrow("TAVEN_PUBLIC_SITE_URL must use HTTPS in production");
    expect(
      publicSiteUrl({
        NODE_ENV: "production",
        TAVEN_PUBLIC_SITE_URL: "https://taven.cz/",
      }),
    ).toBe("https://taven.cz");
  });

  it("retains HTTP support for local development", () => {
    expect(publicSiteUrl({})).toBe("http://localhost:3000");
    expect(
      publicSiteUrl({ TAVEN_PUBLIC_SITE_URL: "http://127.0.0.1:3000/" }),
    ).toBe("http://127.0.0.1:3000");
  });
});
