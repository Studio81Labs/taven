import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:4176",
    ...devices["Desktop Chrome"],
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 4176 --strictPort",
    port: 4176,
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_API_BASE_URL: "http://127.0.0.1:4176",
      VITE_APP_ENV: "test",
    },
  },
});
