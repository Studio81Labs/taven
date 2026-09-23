import { createTavenApiClient } from "@taven/openapi-client";
import { adminApiBaseUrl } from "./app-config";

const baseUrl = adminApiBaseUrl(
  import.meta.env.VITE_APP_ENV ?? import.meta.env.MODE,
  import.meta.env.VITE_API_BASE_URL,
);
let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
let onForbidden: (() => void) | null = null;

export function configureAdminTransport(handlers: {
  unauthorized: () => void;
  forbidden: () => void;
}): void {
  onUnauthorized = handlers.unauthorized;
  onForbidden = handlers.forbidden;
}

export function setAdminCsrfToken(token: string | null): void {
  csrfToken = token;
}

export const apiClient = createTavenApiClient({
  baseUrl,
  credentials: "include",
  fetch: async (input: Request) => {
    const request = new Request(input);
    const path = new URL(request.url).pathname;
    const isAuthenticationStart =
      path === "/admin/auth/login" || path === "/admin/auth/github/start";
    if (
      path.startsWith("/admin/") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !isAuthenticationStart
    ) {
      if (!csrfToken) {
        throw new Error("Relace není připravena pro zápis.");
      }
      request.headers.set("X-CSRF-Token", csrfToken);
    }
    const response = await fetch(request, { credentials: "include" });
    if (path.startsWith("/admin/") && path !== "/admin/auth/methods") {
      if (response.status === 401 && !isAuthenticationStart) {
        onUnauthorized?.();
      } else if (
        response.status === 403 &&
        path !== "/admin/auth/session" &&
        !isAuthenticationStart
      ) {
        onForbidden?.();
      }
    }
    return response;
  },
});
