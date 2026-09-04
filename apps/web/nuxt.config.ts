import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  compatibilityDate: "2026-08-26",
  devtools: { enabled: false },
  css: [
    "@fontsource/ibm-plex-sans/400.css",
    "@fontsource/ibm-plex-sans/600.css",
    "@fontsource/ibm-plex-mono/400.css",
    "@fontsource/ibm-plex-mono/600.css",
    "@taven/ui-web/tokens.css",
    "~/assets/css/tailwind.css",
  ],
  vite: { plugins: [tailwindcss()] },
  nitro: { compressPublicAssets: true },
  build: { transpile: ["@taven/ui-web", "@taven/openapi-client"] },
  runtimeConfig: {
    apiBaseUrl: "http://localhost:3001",
    public: {
      apiBaseUrl: "http://localhost:3001",
      siteUrl: "http://localhost:3000",
    },
  },
  app: {
    head: {
      htmlAttrs: { lang: "cs" },
      title: "Taven",
      meta: [
        {
          name: "description",
          content:
            "Zakázkový 3D tisk s cenou vypočtenou ze skutečných tiskových dat.",
        },
      ],
    },
  },
});
