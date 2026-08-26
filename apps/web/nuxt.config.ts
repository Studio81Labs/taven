export default defineNuxtConfig({
  compatibilityDate: "2026-08-26",
  devtools: { enabled: false },
  css: ["@taven/ui-web/tokens.css"],
  build: { transpile: ["@taven/ui-web", "@taven/openapi-client"] },
  runtimeConfig: {
    public: {
      apiBaseUrl: "http://localhost:3001",
    },
  },
  app: {
    head: {
      title: "Taven",
      meta: [
        {
          name: "description",
          content: "Local 3D printing with a transparent production path.",
        },
      ],
    },
  },
});
