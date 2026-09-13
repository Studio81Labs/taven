import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1, // Deterministic serial runs to prevent shared mock state collisions
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
      testIgnore: ["**/integration/**"],
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["Pixel 5"],
      },
      testMatch: ["**/accessibility-and-responsive.spec.ts"],
    },
    {
      name: "integration",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
      testMatch: ["**/integration/**/*.spec.ts"],
    },
  ],
  webServer: [
    {
      command: "node e2e/fixtures/mock-backend-server.mjs",
      port: 4175,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "node scripts/serve-fixture-web.mjs",
      port: 4174,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: "4174",
        HOST: "127.0.0.1",
        NUXT_API_BASE_URL: "http://127.0.0.1:4175",
        NUXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:4175",
        NUXT_PUBLIC_SITE_URL: "http://127.0.0.1:4174",
        NUXT_PUBLIC_AUTOMATIC_QUOTE_ENABLED: "true",
      },
    },
  ],
});
