import { useLegalAvailability } from "../composables/useLegalAvailability";

export default defineNuxtRouteMiddleware(async (to) => {
  if (
    to.query.retry === "1" &&
    typeof to.query.sessionId === "string" &&
    to.query.sessionId.length > 0
  ) {
    return;
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
