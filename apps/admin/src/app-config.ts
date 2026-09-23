export function adminTitle(environment: string | undefined): string {
  return environment ? `Taven Admin · ${environment}` : "Taven Admin";
}

export function adminApiBaseUrl(
  environment: string | undefined,
  configured: string | undefined,
): string {
  if (
    environment !== "local" &&
    environment !== "development" &&
    environment !== "test" &&
    environment !== "staging" &&
    environment !== "production"
  ) {
    throw new Error("VITE_APP_ENV must name a supported environment");
  }
  const value = configured ?? "http://localhost:3001";
  const url = new URL(value);
  if (url.origin !== value.replace(/\/$/, "")) {
    throw new Error("VITE_API_BASE_URL must be an exact origin");
  }
  if (
    (environment === "staging" || environment === "production") &&
    (!configured || url.protocol !== "https:")
  ) {
    throw new Error("A configured HTTPS API origin is required");
  }
  return url.origin;
}
