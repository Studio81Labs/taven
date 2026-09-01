export default defineNuxtConfig({
  compatibilityDate: "2026-08-26",
  devtools: { enabled: false },
  css: [
    "@fontsource/ibm-plex-sans/400.css",
    "@fontsource/ibm-plex-sans/600.css",
    "@fontsource/ibm-plex-mono/400.css",
    "@fontsource/ibm-plex-mono/600.css",
    "@taven/ui-web/tokens.css",
    "~/assets/css/application.css",
  ],
  build: { transpile: ["@taven/ui-web", "@taven/openapi-client"] },
  runtimeConfig: {
    apiBaseUrl: "http://localhost:3001",
    public: {
      apiBaseUrl: "http://localhost:3001",
    },
  },
  app: {
    head: {
      htmlAttrs: { lang: "en" },
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
