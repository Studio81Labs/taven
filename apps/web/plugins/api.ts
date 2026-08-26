import { createTavenApiClient } from "@taven/openapi-client";

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  return {
    provide: {
      api: createTavenApiClient({ baseUrl: config.public.apiBaseUrl }),
    },
  };
});
