import {
  getSessionStorage,
  loadPaymentReturnSession,
} from "../utils/quote-session-storage";
import { useLegalAvailability } from "../composables/useLegalAvailability";

export default defineNuxtRouteMiddleware(async (to) => {
  if (
    to.query.retry === "1" &&
    typeof to.query.sessionId === "string" &&
    to.query.sessionId.length > 0
  ) {
    // Preserve the retry route during SSR. The client middleware performs the
    // authenticated session/evidence check before allowing the retry flow.
    if (import.meta.server) return;
    if (import.meta.client) {
      const storage = getSessionStorage(window);
      const stored = storage ? loadPaymentReturnSession(storage) : undefined;
      if (stored?.sessionId === to.query.sessionId) {
        try {
          const response = await useNuxtApp().$api.GET(
            "/automatic-quote-sessions/{sessionId}",
            {
              params: { path: { sessionId: stored.sessionId } },
              headers: { Authorization: `Bearer ${stored.sessionToken}` },
            },
          );
          if (response.data?.checkoutEvidenceAccepted === true) return;
        } catch {
          // Fall through to the ordinary acquisition gate.
        }
      }
    }
  }
  const { refresh } = useLegalAvailability();
  await refresh();

  if (useAutomaticQuoteEnabled().value) return;

  return navigateTo(
    {
      path: "/cenik",
      query: { stav: "ceka-na-schvaleni-cen" },
    },
    { redirectCode: 302 },
  );
});
