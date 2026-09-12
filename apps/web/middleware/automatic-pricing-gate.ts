import { useLegalAvailability } from "../composables/useLegalAvailability";

export default defineNuxtRouteMiddleware(async () => {
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
