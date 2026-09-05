import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_PAYMENT_FLOWS_ENV } from "../../launch-approval-gates";
import { PaymentsService, publicSiteUrl } from "./payments.service";

describe("payment capabilities", () => {
  it("hides provider methods while checkout is disabled", async () => {
    const capabilities = vi.fn().mockResolvedValue({
      provider: "comgate",
      methods: ["CARD", "BANK_TRANSFER"],
    });
    const service = new PaymentsService(
      {} as never,
      { capabilities } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.capabilities({})).resolves.toEqual({
      provider: "disabled",
      methods: [],
    });
    expect(capabilities).not.toHaveBeenCalled();

    await expect(
      service.capabilities({ [CHECKOUT_PAYMENT_FLOWS_ENV]: "true" }),
    ).resolves.toEqual({
      provider: "comgate",
      methods: ["CARD", "BANK_TRANSFER"],
    });
    expect(capabilities).toHaveBeenCalledTimes(1);
  });
});

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
