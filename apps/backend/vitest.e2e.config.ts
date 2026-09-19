import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test/e2e.setup.ts"],
  },
});
