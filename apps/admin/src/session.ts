import type { components } from "@taven/openapi-client";
import { reactive } from "vue";
import { apiClient, configureAdminTransport, setAdminCsrfToken } from "./api";
import { requestFeedback, type RequestFeedback } from "./request-feedback";

export type OperatorSession = components["schemas"]["OperatorSessionDto"];
export type OperatorPermission =
  OperatorSession["operator"]["permissions"][number];

type SessionPhase = "loading" | "authenticated" | "anonymous" | "unavailable";

export const session = reactive<{
  phase: SessionPhase;
  value: OperatorSession | null;
  scopeDenied: boolean;
}>({ phase: "loading", value: null, scopeDenied: false });

let epoch = 0;
let pendingBootstrap: Promise<void> | null = null;

function clear(phase: SessionPhase, scopeDenied = false): void {
  epoch += 1;
  session.value = null;
  session.phase = phase;
  session.scopeDenied = scopeDenied;
  setAdminCsrfToken(null);
}

function accept(value: OperatorSession): void {
  session.value = value;
  session.phase = "authenticated";
  session.scopeDenied = false;
  setAdminCsrfToken(value.csrfToken);
}

configureAdminTransport({
  unauthorized: () => clear("anonymous"),
  forbidden: () => {
    if (session.phase === "authenticated") void refreshSession();
  },
});

export function hasOperationalNode(): boolean {
  return session.value?.operator.nodeIds.length === 1;
}

export function hasPermission(permission: OperatorPermission): boolean {
  return session.value?.operator.permissions.includes(permission) ?? false;
}

export function bootstrapSession(): Promise<void> {
  if (pendingBootstrap) return pendingBootstrap;
  const requestEpoch = ++epoch;
  session.phase = "loading";
  pendingBootstrap = (async () => {
    try {
      const { data, response } = await apiClient.GET("/admin/auth/session");
      if (epoch !== requestEpoch) return;
      if (data && Array.isArray(data.operator?.permissions)) accept(data);
      else if (data) clear("unavailable");
      else if (response.status === 401) clear("anonymous");
      else if (response.status === 403) clear("anonymous", true);
      else clear("unavailable");
    } catch {
      if (epoch === requestEpoch) clear("unavailable");
    } finally {
      pendingBootstrap = null;
    }
  })();
  return pendingBootstrap;
}

export function refreshSession(): Promise<void> {
  return bootstrapSession();
}

export async function login(
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; feedback: RequestFeedback }> {
  const requestEpoch = ++epoch;
  const { data, response } = await apiClient.POST("/admin/auth/login", {
    body: { email, password },
  });
  if (epoch !== requestEpoch)
    return { ok: false, feedback: requestFeedback(409) };
  if (!data) {
    return {
      ok: false,
      feedback:
        response.status === 401
          ? {
              message:
                "Přihlášení se nezdařilo. Zkontrolujte údaje a zkuste to znovu.",
              retryAfterSeconds: null,
              refreshRequired: false,
            }
          : requestFeedback(
              response.status,
              response.headers.get("Retry-After"),
            ),
    };
  }
  accept(data);
  return { ok: true };
}

export async function startGithubLogin(): Promise<string | null> {
  const { data } = await apiClient.POST("/admin/auth/github/start", {});
  if (!data) return null;
  const url = new URL(data.authorizationUrl);
  if (url.protocol !== "https:") return null;
  return url.toString();
}

export async function logout(): Promise<void> {
  const current = session.value;
  if (!current) {
    clear("anonymous");
    return;
  }
  const requestEpoch = ++epoch;
  session.phase = "loading";
  try {
    const { response } = await apiClient.DELETE("/admin/auth/session", {
      params: { header: { "x-csrf-token": current.csrfToken } },
    });
    if (epoch !== requestEpoch) return;
    if (response.status !== 204) throw new Error("Logout was not confirmed");
    clear("anonymous");
  } catch (error) {
    if (epoch === requestEpoch) session.phase = "authenticated";
    throw error;
  }
}

export function resetSessionForTest(): void {
  clear("anonymous");
}
