import { test, expect } from "@playwright/test";

const INTEGRATION_API_URL =
  process.env.INTEGRATION_API_URL || "http://127.0.0.1:3001";

test.describe("Real API Integration Journey", () => {
  test.skip(
    !process.env.INTEGRATION_TEST,
    "Skipped unless INTEGRATION_TEST=true environment variable is present",
  );

  test("connects to live backend and checks health and availability", async ({
    request,
  }) => {
    let healthResponse;
    try {
      healthResponse = await request.get(`${INTEGRATION_API_URL}/health`);
    } catch (error) {
      test.skip(
        true,
        `Live backend is not reachable at ${INTEGRATION_API_URL}: ${(error as Error).message}`,
      );
      return;
    }

    expect(healthResponse.status()).toBe(200);

    const legal = await request.get(
      `${INTEGRATION_API_URL}/legal-documents/availability`,
    );
    expect([200, 503]).toContain(legal.status());
  });
});
