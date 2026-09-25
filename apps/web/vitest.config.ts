import vue from "@vitejs/plugin-vue";
import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
