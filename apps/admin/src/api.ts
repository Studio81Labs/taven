import { createTavenApiClient } from "@taven/openapi-client";

export const apiClient = createTavenApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001",
});
