import { createTavenApiClient } from "@taven/openapi-client";

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const baseUrl = import.meta.server
    ? config.apiBaseUrl
    : config.public.apiBaseUrl;
  return {
    provide: {
      api: createTavenApiClient({ baseUrl }),
    },
  };
});
